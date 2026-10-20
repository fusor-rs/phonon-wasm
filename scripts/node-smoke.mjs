// Runs a single-threaded wasm runtime build in Node against a bundle: pushes every part the way
// the browser loader does, synthesizes one sentence, prints the real-time factor and the time to
// the first audio, and optionally writes the WAV.
//
//   node scripts/node-smoke.mjs dist/model --build web-single [--text "..."] [--voice id] [--out out.wav]

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    build: { type: 'string', default: 'web-single' },
    text: { type: 'string', default: 'The evening wind drifted down from the mountain pass, and the distant clouds slowly turned gold.' },
    voice: { type: 'string' },
    out: { type: 'string' },
  },
});
const bundle = positionals[0] ?? 'dist/model';
const dist = new URL(`../app/engine/dist/${values.build}/`, import.meta.url);
const glue = await import(new URL('phonon_runtime.js', dist));
glue.initSync({ module: readFileSync(new URL('phonon_runtime_bg.wasm', dist)) });

const CHUNK = 8 << 20;
const t0 = performance.now();
const manifest = readFileSync(join(bundle, 'manifest.json'), 'utf8');
const runtime = new glue.Runtime(manifest);
let ready = false;
JSON.parse(manifest).parts.forEach((part, index) => {
  const bytes = readFileSync(join(bundle, part.file));
  for (let o = 0; o < bytes.length; o += CHUNK) runtime.write_part(index, bytes.subarray(o, o + CHUNK));
  ready = runtime.end_part(index);
});
if (!ready) throw new Error('engine not ready after every part');
const loadMs = performance.now() - t0;

const voice = values.voice ?? JSON.parse(glue.voices())[0].id;
const t1 = performance.now();
runtime.start(JSON.stringify({ text: values.text, voice }));
const chunks = [];
let frames = 0;
let firstAudioMs = null;
for (;;) {
  const progress = JSON.parse(runtime.step());
  frames++;
  const audio = runtime.take_audio();
  if (audio.length) {
    chunks.push(audio);
    firstAudioMs ??= performance.now() - t1;
  }
  if (progress.done) break;
}
const genMs = performance.now() - t1;
const samples = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
let offset = 0;
for (const chunk of chunks) {
  samples.set(chunk, offset);
  offset += chunk.length;
}
const seconds = samples.length / glue.sample_rate();
const peak = samples.reduce((max, s) => Math.max(max, Math.abs(s)), 0);
console.log(`${values.build}: load ${(loadMs / 1000).toFixed(2)}s, ${frames} frames, ${seconds.toFixed(2)}s audio (peak ${peak.toFixed(3)}) in ${(genMs / 1000).toFixed(2)}s: RTF ${(genMs / 1000 / seconds).toFixed(3)}, ${(genMs / frames).toFixed(1)} ms/frame, first audio ${firstAudioMs.toFixed(0)} ms`);

if (values.out) {
  writeFileSync(values.out, glue.wav(samples));
  console.log(`wrote ${values.out}`);
}
