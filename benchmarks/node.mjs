// The single-threaded wasm builds in Node, both runtimes through the same loop and clock:
// phonon-wasm's web-single / web-single-relaxed (the glue in app/engine/dist, the bundle
// pushed part by part as scripts/node-smoke.mjs does) and phonon-tts 0.4.0's wasm/ build
// (relaxed SIMD: phonon_tts_bg.wasm; plain SIMD128: phonon_tts_simd_bg.wasm) through its raw
// wasm-bindgen API, as its worker drives it. Per build: load once, one warm-up, then each
// sentence `--repeat` times. Load is from the files on disk to a ready model. First audio is
// request → first non-empty PCM; wall is request → done. Writes <out>/node.tsv and the first
// WAV of each sentence.
//
//   node benchmarks/node.mjs --runtime phonon-wasm --build web-single-relaxed [--repeat 3]   (MODEL=<f32 bundle> MODEL_QUANT=f32 for the f32 bundle)
//   node benchmarks/node.mjs --runtime phonon-tts --build relaxed|simd128 [--quant q8|f32]
//   [--sentences S1,S2,S3] [--out benchmarks/out/node]

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SENTENCES = {
  S1: "Please remember to water the plants on Tuesday, and call the dentist about the appointment at three o'clock.",
  S2: 'The evening wind drifted down from the mountain pass, and the distant clouds slowly turned gold.',
  S3: 'Glaciers move slowly, carving valleys over thousands of years while the rivers below carry the silt to the sea.',
};
const TEMPERATURE = 0.3;
const SEED = 4242424242424242n;
const { values } = parseArgs({
  options: {
    runtime: { type: 'string', default: 'phonon-wasm' },
    build: { type: 'string', default: 'web-single-relaxed' },
    quant: { type: 'string', default: 'q8' },
    repeat: { type: 'string', default: '3' },
    sentences: { type: 'string', default: 'S1,S2,S3' },
    out: { type: 'string', default: 'benchmarks/out/node' },
  },
});
const MODEL = process.env.MODEL ?? join(ROOT, 'dist/model');
const CHECKPOINT = process.env.CHECKPOINT ?? join(ROOT, '.cache/phonon-31m-en');
// The profile of the phonon-wasm bundle under MODEL, for the label only (q7 unless told otherwise).
const MODEL_QUANT = process.env.MODEL_QUANT ?? 'q7';

function wav(chunks, sampleRate) {
  const length = chunks.reduce((n, c) => n + c.length, 0);
  const buffer = Buffer.alloc(44 + length * 2);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + length * 2, 4); buffer.write('WAVE', 8); buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(length * 2, 40);
  let o = 44;
  for (const c of chunks) for (let i = 0; i < c.length; i++, o += 2) buffer.writeInt16LE(Math.max(-1, Math.min(1, c[i])) * 32767, o);
  return buffer;
}

/** Returns { sampleRate, speak(text) → { chunks, frames, firstMs, wallMs } } for phonon-wasm. */
async function phononWasm() {
  const dist = pathToFileURL(join(ROOT, `app/engine/dist/${values.build}/`));
  const glue = await import(new URL('phonon_runtime.js', dist));
  glue.initSync({ module: readFileSync(new URL('phonon_runtime_bg.wasm', dist)) });
  const manifest = readFileSync(join(MODEL, 'manifest.json'), 'utf8');
  const runtime = new glue.Runtime(manifest);
  JSON.parse(manifest).parts.forEach((part, index) => {
    const bytes = readFileSync(join(MODEL, part.file));
    for (let o = 0; o < bytes.length; o += 8 << 20) runtime.write_part(index, bytes.subarray(o, o + (8 << 20)));
    runtime.end_part(index);
  });
  return {
    sampleRate: glue.sample_rate(),
    async speak(text) {
      const t0 = performance.now();
      runtime.start(JSON.stringify({ text, voice: 'default', temperature: TEMPERATURE, seed: Number(SEED) }));
      const chunks = [];
      let frames = 0;
      let firstMs = null;
      for (;;) {
        const progress = JSON.parse(runtime.step());
        frames++;
        const audio = runtime.take_audio();
        if (audio.length) {
          firstMs ??= performance.now() - t0;
          chunks.push(audio);
        }
        if (progress.done) break;
      }
      return { chunks, frames, firstMs, wallMs: performance.now() - t0 };
    },
  };
}

/** The same for phonon-tts's single-threaded build, through its raw API as worker.js drives it. */
async function phononTts() {
  const pkg = join(ROOT, 'benchmarks/node_modules/phonon-tts/wasm/');
  const glue = await import(pathToFileURL(join(pkg, 'phonon_tts.js')));
  const file = values.build === 'simd128' ? 'phonon_tts_simd_bg.wasm' : 'phonon_tts_bg.wasm';
  await glue.default({ module_or_path: readFileSync(join(pkg, file)) });
  const weights = readFileSync(join(CHECKPOINT, values.quant === 'f32' ? 'model.safetensors' : 'model.q8.gguf'));
  const model = await glue.Model.load(new Uint8Array(weights), new Uint8Array(readFileSync(join(CHECKPOINT, 'tokenizer.json'))), new Uint8Array(readFileSync(join(CHECKPOINT, 'config.json'))), values.quant, 'en', undefined, undefined, 'cpu');
  const voice = model.add_voice(new Uint8Array(readFileSync(join(CHECKPOINT, 'default-voice.safetensors'))));
  await model.flush();
  const frameSize = model.frame_size();
  return {
    sampleRate: model.sample_rate(),
    async speak(text) {
      const t0 = performance.now();
      model.start_generation(voice, text, TEMPERATURE, SEED);
      const chunks = [];
      let frames = 0;
      let firstMs = null;
      try {
        for (;;) {
          if (model.next_chunk() === undefined) break;
          for (;;) {
            const pcm = await model.generation_step();
            if (pcm === undefined) break;
            frames += Math.max(1, Math.round(pcm.length / frameSize));
            firstMs ??= performance.now() - t0;
            chunks.push(pcm);
          }
        }
      } finally {
        model.stop_generation();
      }
      return { chunks, frames, firstMs, wallMs: performance.now() - t0 };
    },
  };
}

const outDir = join(ROOT, values.out);
mkdirSync(outDir, { recursive: true });
const tsv = join(outDir, 'node.tsv');
if (!existsSync(tsv)) writeFileSync(tsv, 'runtime\tbuild\tquant\tsentence\trun\tload_s\tframes\taudio_s\tgen_s\trtf\tms_frame\tfirst_audio_ms\tloadavg\n');
const tag = `${values.runtime}-${values.build}${values.runtime === 'phonon-tts' ? `-${values.quant}` : ''}`;
const t0 = performance.now();
const engine = await (values.runtime === 'phonon-tts' ? phononTts() : phononWasm());
const loadS = (performance.now() - t0) / 1000;
console.log(`${tag}: loaded in ${loadS.toFixed(2)} s`);
await engine.speak('Warm up, warm up, warm up.');
for (const key of values.sentences.split(',')) {
  for (let i = 0; i < Number(values.repeat); i++) {
    const r = await engine.speak(SENTENCES[key]);
    const samples = r.chunks.reduce((n, c) => n + c.length, 0);
    const audioS = samples / engine.sampleRate;
    const row = [values.runtime, values.build, values.runtime === 'phonon-tts' ? values.quant : MODEL_QUANT, key, i, loadS.toFixed(3), r.frames, audioS.toFixed(3), (r.wallMs / 1000).toFixed(4), (r.wallMs / 1000 / audioS).toFixed(4), (r.wallMs / r.frames).toFixed(2), r.firstMs.toFixed(1), loadavg()[0].toFixed(1)];
    console.log(row.join('\t'));
    appendFileSync(tsv, row.join('\t') + '\n');
    if (i === 0) writeFileSync(join(outDir, `${tag}-${key}.wav`), wav(r.chunks, engine.sampleRate));
  }
}
