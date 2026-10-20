// Gradium's phonon-tts (the npm build of their Rust runtime) on the same checkpoint files, for
// benchmarks/head-to-head.mjs: `window.reference` resolves once loaded, `window.speak(text)`
// streams one synthesis and returns its timings.
//
//   /reference/?threads=3&quant=q8

import { PhononTTS } from '/phonon-tts/index.js';

const params = new URLSearchParams(location.search);
const CHECKPOINT = new URL('/checkpoint/', location.href).href;

window.reference = (async () => {
  const t0 = performance.now();
  const tts = await PhononTTS.load({
    lang: 'en',
    quant: params.get('quant') ?? 'q8',
    threads: Number(params.get('threads') ?? 3),
    cache: false,
    model: {
      weights: { q8: `${CHECKPOINT}model.q8.gguf`, f32: `${CHECKPOINT}model.safetensors` },
      tokenizer: `${CHECKPOINT}tokenizer.json`,
      config: `${CHECKPOINT}config.json`,
      voices: { default: `${CHECKPOINT}default-voice.safetensors` },
      defaultVoice: 'default',
    },
  });
  window.speak = async (text) => {
    const start = performance.now();
    const speech = tts.stream(text);
    let pageFirstMs = null;
    let samples = 0;
    for await (const pcm of speech) {
      pageFirstMs ??= performance.now() - start;
      samples += pcm.length;
    }
    return { pageFirstMs, wallMs: performance.now() - start, samples, stats: await speech.done };
  };
  return { loadMs: performance.now() - t0, threads: tts.threads, device: tts.device, sampleRate: tts.sampleRate };
})();
