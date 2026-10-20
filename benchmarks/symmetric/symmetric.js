// One page that drives either engine the same way, so both are measured on the main thread
// with one definition of every number (benchmarks/browser.mjs drives it):
//
//   /symmetric/?runtime=phonon-wasm&threads=8[&build=web-threaded-relaxed][&model=/model/]
//   /symmetric/?runtime=phonon-tts&threads=8[&quant=q8|f32][&device=cpu|webgpu][&simd=simd128][&cache=1]
//
// `window.ready` resolves with the load time and what ran; `window.speak(text, options)`
// synthesizes once and returns, all from the main thread's clock:
//   - startMs: when the request was posted (performance.now()),
//   - pageFirstMs: request → first PCM chunk arriving on the main thread,
//   - wallMs: request → the engine reporting done (every chunk has arrived),
//   - engineFirstMs: the engine's own request → first PCM, inside its worker,
//   - stepMs: the engine's own mean compute time per frame, inside its worker,
//   - frames, samples, and the WAV (16-bit PCM) as base64 for the intelligibility check.
//
// phonon-wasm: the app's own engine worker (app/engine/worker.js, as the page uses it), given
// a MessagePort in place of the audio worklet's; a 'pcm' message on that port is the first
// audio on the main thread, as the page's worklet would receive it.
// phonon-tts: PhononTTS.load / tts.stream from the npm package, its own worker; the first
// `Float32Array` from the stream is the first audio on the main thread.

const params = new URLSearchParams(location.search);
const runtime = params.get('runtime') ?? 'phonon-wasm';
const threads = Number(params.get('threads') ?? 1);
const log = (s) => (document.getElementById('log').textContent += s + '\n');

function wavBase64(chunks, sampleRate) {
  const length = chunks.reduce((n, c) => n + c.length, 0);
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);
  const str = (o, s) => [...s].forEach((ch, i) => view.setUint8(o + i, ch.charCodeAt(0)));
  str(0, 'RIFF'); view.setUint32(4, 36 + length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); str(36, 'data'); view.setUint32(40, length * 2, true);
  let o = 44;
  for (const c of chunks) for (let i = 0; i < c.length; i++, o += 2) view.setInt16(o, Math.max(-1, Math.min(1, c[i])) * 32767, true);
  const bytes = new Uint8Array(buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function phononWasm() {
  // Threaded builds ask the page for their compute workers (fusor-ai's ComputePool), as app.js does.
  const { ComputePool, SPAWN_COMPUTE } = await import('/host/compute.js');
  const computePool = new ComputePool((message) => log('compute thread crashed: ' + message));
  const t0 = performance.now();
  const worker = new Worker(new URL(params.get('worker') ?? '/engine/worker.js', location.href), { type: 'module' });
  const channel = new MessageChannel();
  worker.postMessage({ type: 'audio', port: channel.port2 }, [channel.port2]);
  let info = null;
  const listeners = new Set();
  worker.onmessage = ({ data }) => {
    if (data.type === SPAWN_COMPUTE) return computePool.spawn(data);
    if (data.type === 'runtime') info = data;
    for (const fn of listeners) fn(data);
  };
  let audioListener = null;
  channel.port1.onmessage = ({ data }) => audioListener?.(data);
  const ready = await new Promise((resolve, reject) => {
    listeners.add((m) => (m.type === 'ready' ? resolve(m) : /^(error|fatal)$/.test(m.type) ? reject(new Error(m.message)) : null));
    worker.postMessage({ type: 'load', modelUrl: new URL(params.get('model') ?? '/model/', location.href).href, threads, build: params.get('build') });
  });
  const loadMs = performance.now() - t0;
  let jobs = 0;
  window.speak = (text, { voice = 'default', temperature = 0.3, seed = 4242424242424242 } = {}) =>
    new Promise((resolve, reject) => {
      const job = ++jobs;
      let pageFirstMs = null;
      const start = performance.now();
      audioListener = (m) => {
        if (m.type === 'pcm' && m.job === job) pageFirstMs ??= performance.now() - start;
      };
      const onDone = (m) => {
        if (m.type === 'done' && m.job === job) {
          listeners.delete(onDone);
          const wallMs = performance.now() - start;
          const bytes = m.wav;
          let s = '';
          for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          resolve({
            startMs: start, pageFirstMs, wallMs, engineFirstMs: m.engineFirstMs, engineWallMs: m.wallMs,
            stepMs: m.computeMs / m.frames, frames: m.frames, samples: m.samples, sampleRate: info.sampleRate,
            networkRequests: m.networkRequests, wav: btoa(s),
          });
        } else if (/^(error|fatal)$/.test(m.type)) reject(new Error(m.message));
      };
      listeners.add(onDone);
      worker.postMessage({ type: 'generate', job, request: JSON.stringify({ text, voice, temperature, seed }) });
    });
  return { loadMs, engineLoadMs: ready.ms, build: info.build, threads: info.threads, sampleRate: info.sampleRate, bundleBytes: ready.total ?? null, fromCache: ready.cache ?? null };
}

async function phononTts() {
  const { PhononTTS } = await import('/phonon-tts/index.js');
  const checkpoint = new URL(params.get('checkpoint') ?? '/checkpoint/', location.href).href;
  const t0 = performance.now();
  const tts = await PhononTTS.load({
    lang: 'en',
    quant: params.get('quant') ?? 'q8',
    threads,
    device: params.get('device') ?? 'cpu',
    cache: params.get('cache') === '1',
    // simd=simd128 forces the package's plain-SIMD128 builds (what it picks where relaxed SIMD
    // is missing, e.g. Safari); by default it picks its relaxed-SIMD builds (phonon_tts_bg.wasm).
    ...(params.get('simd') === 'simd128' ? { wasmUrl: '/phonon-tts/wasm/phonon_tts_simd_bg.wasm', threadsWasmUrl: '/phonon-tts/wasm-threads/phonon_tts_simd_bg.wasm' } : {}),
    model: {
      weights: { q8: `${checkpoint}model.q8.gguf`, f32: `${checkpoint}model.safetensors` },
      tokenizer: `${checkpoint}tokenizer.json`,
      config: `${checkpoint}config.json`,
      voices: { default: `${checkpoint}default-voice.safetensors` },
      defaultVoice: 'default',
    },
  });
  const loadMs = performance.now() - t0;
  window.speak = async (text, { temperature = 0.3, seed = 4242424242424242 } = {}) => {
    const start = performance.now();
    const speech = tts.stream(text, { voice: 'default', temperature, seed: BigInt(seed) });
    let pageFirstMs = null;
    const chunks = [];
    for await (const pcm of speech) {
      pageFirstMs ??= performance.now() - start;
      chunks.push(pcm);
    }
    const stats = await speech.done;
    const wallMs = performance.now() - start;
    return {
      startMs: start, pageFirstMs, wallMs, engineFirstMs: stats.firstAudioMs, engineWallMs: stats.totalMs,
      stepMs: stats.stepMs.avg, frames: stats.frames, samples: stats.samples, sampleRate: tts.sampleRate,
      networkRequests: null, wav: wavBase64(chunks, tts.sampleRate),
    };
  };
  return { loadMs, build: `phonon-tts ${tts.device}`, device: tts.device, deviceReason: tts.deviceReason, threads: tts.threads, threadsReason: tts.threadsReason, sampleRate: tts.sampleRate };
}

window.ready = (runtime === 'phonon-tts' ? phononTts() : phononWasm()).then(
  (info) => (log(JSON.stringify(info)), info),
  (e) => (log('error: ' + (e?.stack ?? e)), Promise.reject(e)),
);
