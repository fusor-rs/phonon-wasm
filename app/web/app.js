import { ComputePool, SPAWN_COMPUTE } from '../../vendor/fusor-ai/packages/host/compute.js';
import { Waveform } from './waveform.js';

// The engine bridge. The page's state lives in Rust (src/app.rs); this module owns the engine
// worker and, in threaded builds, its compute workers (fusor-ai's ComputePool), and the audio
// worklet (engine/playback.js) the engine worker feeds directly. It measures each synthesis and
// reports back with `engine` events, at most once per animation frame.

const params = new URLSearchParams(location.search);
const cores = navigator.hardwareConcurrency || 4;
// One compute worker per core minus two (the page and the engine worker), at most 8; `?threads=1`
// forces the single-threaded build. Never more than the cores: the barriers spin.
const requestedThreads = Number.parseInt(params.get('threads') ?? '', 10);
const THREADS = Math.min(cores, requestedThreads > 0 ? requestedThreads : Math.max(1, Math.min(8, cores - 2)));
// The bundle served next to the page (`just serve` mounts dist/model there); `?model=<url>` loads
// another one, `?build=web-single` pins a runtime build.
const MODEL_URL = new URL(params.get('model') ?? 'model/', document.baseURI).href;

const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

export function onMount({ root, inputs, onCleanup }) {
  const report = (detail) => root.dispatchEvent(new CustomEvent('engine', { detail: JSON.stringify(detail) }));
  const engine = new Worker(new URL('engine/worker.js', document.baseURI), { type: 'module', name: 'phonon-engine' });
  const computePool = new ComputePool(crash);
  const waveform = new Waveform(root);
  let build = null;
  let notice = '';
  let sampleRate = null;
  let resolveSampleRate;
  const sampleRateKnown = new Promise((resolve) => (resolveSampleRate = resolve));
  let loaded = false;
  let broken = false;
  let audio = null;
  let jobs = 0;
  let job = null;
  let reportScheduled = false;
  let wavUrl = null;
  let requestsAtReady = 0;

  const handlers = {
    [SPAWN_COMPUTE]: (message) => computePool.spawn(message),
    runtime: (message) => {
      build = message;
      sampleRate = message.sampleRate;
      resolveSampleRate();
      // Built now, suspended until the first click resumes it: the first synthesis does not wait
      // for the context and the worklet module.
      audioOutput();
    },
    warning: ({ message }) => {
      console.warn(message);
      notice = ` (${message})`;
    },
    progress: ({ done, total, network, cache }) => {
      const source = cache && !network ? 'from this device' : cache ? `${mb(network)} downloaded, ${mb(cache)} cached` : 'downloading';
      report({ type: 'loading', fraction: done / total, detail: `${mb(done)} / ${mb(total)} · ${source}` });
    },
    ready: ({ ms, voices, cache, total }) => {
      loaded = true;
      requestsAtReady = performance.getEntriesByType('resource').length;
      const loadedInfo = { build: `${build.build}${notice}`, threads: build.threads, bundle_bytes: total, load_ms: ms, from_device: cache === total };
      report({ type: 'ready', voices, loaded: loadedInfo });
    },
    frame: (message) => {
      if (message.job !== job?.id) return;
      job.engine = message;
      job.wallMs = performance.now() - job.t0;
      if (message.peaks) waveform.push(message.peaks);
      scheduleProgress();
    },
    done: (message) => finish(message),
    error: ({ message }) => (loaded ? report({ type: 'error', message }) : fail(message)),
    fatal: ({ message }) => fail(message),
  };

  engine.onmessage = ({ data }) => {
    if (!broken) handlers[data.type]?.(data);
  };
  engine.onerror = (event) => crash(event.message || 'the engine worker failed');
  engine.postMessage({ type: 'load', modelUrl: MODEL_URL, threads: THREADS, build: params.get('build') });

  /** The audio output, built once: a context at the model's rate and the playback worklet. */
  function audioOutput() {
    audio ??= (async () => {
      await sampleRateKnown;
      const context = new AudioContext({ sampleRate, latencyHint: 'interactive' });
      await context.audioWorklet.addModule(new URL('engine/playback.js', document.baseURI));
      const node = new AudioWorkletNode(context, 'phonon-playback', { outputChannelCount: [1] });
      node.connect(context.destination);
      node.port.onmessage = ({ data }) => playbackEvent(data);
      const channel = new MessageChannel();
      node.port.postMessage({ type: 'engine', port: channel.port1 }, [channel.port1]);
      engine.postMessage({ type: 'audio', port: channel.port2 }, [channel.port2]);
      return { context, node };
    })();
    return audio;
  }

  /** A click that may start audio: resume the output inside its user activation. */
  function resumeAudio() {
    audioOutput()
      .then(({ context }) => context.resume())
      .catch(() => {}); // a failed output is reported by the synthesis that needs it
  }

  /** Runs the request the page holds, timed from now (the click, or the model being ready). */
  async function dispatch() {
    job = { id: ++jobs, t0: performance.now(), heardMs: null, wallMs: 0, underruns: 0, engine: null, done: false, stopped: false };
    const current = job;
    waveform.reset();
    try {
      const { context } = await audioOutput();
      await context.resume();
    } catch (error) {
      audio = null;
      report({ type: 'error', message: `no audio output (${error?.message ?? error})` });
      return;
    }
    if (current.stopped) {
      report({ type: 'done', status: 'stopped', audio: null, metrics: metrics() });
      report({ type: 'played' });
      return;
    }
    engine.postMessage({ type: 'generate', job: current.id, request: inputs.request.get() });
  }

  function stop() {
    if (!job) return;
    job.stopped = true;
    engine.postMessage({ type: 'stop', job: job.id });
    const id = job.id;
    audio?.then(({ node }) => node.port.postMessage({ type: 'flush', job: id }));
  }

  function playbackEvent({ type, job: id, rendered }) {
    if (id !== job?.id) return;
    if (type === 'started') {
      job.heardMs = performance.now() - job.t0;
      scheduleProgress();
    } else if (type === 'underrun') {
      job.underruns++;
      scheduleProgress();
    } else if (type === 'position') {
      waveform.play(rendered / Math.max(1, job.engine?.samples ?? 1));
    } else if (type === 'drained') {
      waveform.play(1);
      report({ type: 'played' });
    }
  }

  function scheduleProgress() {
    if (reportScheduled) return;
    reportScheduled = true;
    requestAnimationFrame(() => {
      reportScheduled = false;
      if (!job) return;
      if (job.done) {
        report({ type: 'measured', metrics: metrics() });
        return;
      }
      const seconds = (job.engine?.samples ?? 0) / sampleRate;
      report({ type: 'progress', status: `speaking · frame ${job.engine?.frames ?? 0} · ${seconds.toFixed(2)} s of audio`, metrics: metrics() });
    });
  }

  function metrics() {
    const engineStats = job.engine ?? { computeMs: 0, frames: 0, samples: 0, engineFirstMs: null };
    const requests = performance.getEntriesByType('resource').length - requestsAtReady + (engineStats.networkRequests ?? 0);
    return {
      heard_ms: job.heardMs,
      engine_first_ms: engineStats.engineFirstMs,
      wall_ms: job.wallMs,
      compute_ms: engineStats.computeMs,
      frames: engineStats.frames,
      audio_seconds: engineStats.samples / sampleRate,
      underruns: job.underruns,
      requests,
    };
  }

  function finish(message) {
    if (message.job !== job?.id) return;
    job.engine = message;
    job.wallMs = performance.now() - job.t0;
    job.done = true;
    if (wavUrl) URL.revokeObjectURL(wavUrl);
    wavUrl = message.samples ? URL.createObjectURL(new Blob([message.wav], { type: 'audio/wav' })) : null;
    report({ type: 'done', status: message.stopped ? 'stopped' : 'done', audio: wavUrl, metrics: metrics() });
    if (!message.samples) report({ type: 'played' });
  }

  /** The model could not load, or the engine or a compute thread died. */
  function fail(message) {
    broken = true;
    engine.terminate();
    computePool.terminate();
    if (job) audio?.then(({ node }) => node.port.postMessage({ type: 'flush', job: job.id }));
    report({ type: 'broken', message });
  }

  function crash(message) {
    fail(`The engine stopped: ${message}.`);
  }

  onCleanup(onClicks(inputs.clicks, resumeAudio));
  onCleanup(onClicks(inputs.starts, dispatch));
  onCleanup(onClicks(inputs.stops, stop));
  onCleanup(() => {
    engine.terminate();
    computePool.terminate();
    audio?.then(({ context }) => context.close());
    if (wavUrl) URL.revokeObjectURL(wavUrl);
  });
}

/** Runs `action` once per click a click counter counts, clicks before this module loaded included. */
function onClicks(counter, action) {
  let seen = 0;
  return counter.subscribe((count) => {
    for (; seen < count; seen++) action();
  });
}
