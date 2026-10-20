// The engine's home: a module Worker that loads the model and runs synthesis, off the page's
// main thread.
//
// Load: the manifest download overlaps the runtime's compile; fusor-ai's loader picks and starts
// the best runtime build (threaded builds get their compute workers from the page) and streams
// every part of the bundle into it, from OPFS when cached there, else from the network; the
// runtime checks each part's size and BLAKE3. The runtime itself does no I/O.
//
// Generate: one `step()` (one 80 ms frame) per macrotask, so a stop request is seen between
// frames. Every frame's PCM goes straight to the page's audio worklet through `audioPort`, and a
// summary of it (peaks, timings) to the page. At the end the page gets the whole WAV.
//
// After the model is loaded nothing else is fetched: synthesis is entirely local.

import { describe, errorKind, fetchOk, loadParts, startRuntime } from './dist/host/loader.js';

const CACHE_DIR = 'phonon-parts';
const DIST_URL = new URL('./dist/', import.meta.url);
// Waveform bars per frame the page draws.
const PEAKS_PER_FRAME = 24;

const post = (message, transfer) => self.postMessage(message, transfer ?? []);
// A macrotask without setTimeout's 4 ms clamp on nested timers.
const ticks = new MessageChannel();
const yieldTask = () => new Promise((resolve) => {
  ticks.port1.onmessage = resolve;
  ticks.port2.postMessage(null);
});

let runtime = null;
let audioPort = null;
let stoppedJob = null;
// Resource-timing entries of this worker when the model was ready: every later one is a request
// made during synthesis (the page shows the count; it should stay 0).
let entriesAtReady = 0;
const requestsSinceReady = () => performance.getEntriesByType('resource').length - entriesAtReady;

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'load') await load(data);
    else if (data.type === 'audio') audioPort = data.port;
    else if (data.type === 'generate') await generate(data);
    else if (data.type === 'stop') stoppedJob = data.job;
  } catch (error) {
    // A runtime error is `{"kind","message"}` JSON and leaves the engine usable. Anything else is
    // a trap (the runtimes abort on panic) or a bug: the module's state is lost.
    post({ type: errorKind(error) ? 'error' : 'fatal', message: describe(error, runtime?.glue) });
  }
};

async function load({ modelUrl, threads, build: requested }) {
  const t0 = performance.now();
  const [manifestText, started] = await Promise.all([
    fetchOk(new URL('manifest.json', modelUrl)).then((response) => response.text()),
    startRuntime({
      distUrl: DIST_URL,
      glueName: 'phonon_runtime',
      threads,
      requested,
      onWarning: (message) => post({ type: 'warning', message }),
    }),
  ]);
  const rt = new started.glue.Runtime(manifestText);
  runtime = { rt, glue: started.glue };
  post({ type: 'runtime', build: started.build.name, threads: started.threads, sampleRate: started.glue.sample_rate() });
  const progress = await loadParts({
    runtime: rt,
    manifest: JSON.parse(manifestText),
    baseUrl: modelUrl,
    cacheName: CACHE_DIR,
    onProgress: (p) => post({ type: 'progress', ...p }),
  });
  entriesAtReady = performance.getEntriesByType('resource').length;
  post({ type: 'ready', ms: performance.now() - t0, voices: JSON.parse(started.glue.voices()), ...progress });
  await evictStaleParts(JSON.parse(manifestText));
}

/** Deletes cached parts this bundle does not name: those of earlier bundles. */
async function evictStaleParts(manifest) {
  const keep = new Set(manifest.parts.map((part) => part.blake3));
  let dir;
  try {
    dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(CACHE_DIR);
  } catch {
    return; // no OPFS, or nothing was cached
  }
  for await (const name of dir.keys()) {
    if (!keep.has(name)) await dir.removeEntry(name);
  }
}

async function generate({ job, request }) {
  const { rt, glue } = runtime;
  audioPort.postMessage({ type: 'start', job });
  const t0 = performance.now();
  const timing = { computeMs: 0, frames: 0, samples: 0, engineFirstMs: null };
  const chunks = [];
  try {
    rt.start(request);
    await frames(job, t0, timing, chunks);
  } finally {
    audioPort.postMessage({ type: 'end', job });
  }
  const wav = glue.wav(concat(chunks, timing.samples));
  const stats = { job, wallMs: performance.now() - t0, ...timing, networkRequests: requestsSinceReady() };
  post({ type: 'done', stopped: stoppedJob === job, wav, ...stats }, [wav.buffer]);
}

/** Steps `job` to its end or its stop, sending each frame's PCM to the worklet. */
async function frames(job, t0, timing, chunks) {
  const { rt } = runtime;
  for (;;) {
    if (stoppedJob === job) {
      rt.cancel();
      return;
    }
    const stepStart = performance.now();
    const progress = JSON.parse(rt.step());
    const samples = rt.take_audio();
    timing.computeMs += performance.now() - stepStart;
    timing.frames++;
    let framePeaks = null;
    if (samples.length) {
      timing.engineFirstMs ??= performance.now() - t0;
      timing.samples += samples.length;
      framePeaks = peaks(samples);
      chunks.push(samples.slice());
      audioPort.postMessage({ type: 'pcm', job, samples }, [samples.buffer]);
    }
    post({ type: 'frame', job, peaks: framePeaks, wallMs: performance.now() - t0, ...timing });
    if (progress.done) return;
    await yieldTask();
  }
}

function peaks(samples) {
  const out = new Float32Array(PEAKS_PER_FRAME);
  const width = Math.ceil(samples.length / PEAKS_PER_FRAME);
  samples.forEach((s, i) => {
    const bin = Math.floor(i / width);
    out[bin] = Math.max(out[bin], Math.abs(s));
  });
  return out;
}

function concat(chunks, length) {
  const out = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
