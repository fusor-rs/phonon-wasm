// Head-to-head in one headless Chrome: this repository's page (dist/model through the UI, as a
// user drives it) against Gradium's phonon-tts 0.4.0 (benchmarks/reference, their q8 weights),
// both served locally by fusor-ai's serve.mjs with cross-origin isolation, at the same thread
// counts. Per configuration: one warm-up synthesis, then `--runs` measured ones (medians).
//
//   node benchmarks/head-to-head.mjs [--threads 1,3,8] [--runs 3] [--text "..."]
//
// Measured, for both: first audio inside the engine worker (request start → first PCM), first
// audio on the page (ours: click → first sample rendered by the audio worklet; theirs: stream
// call → first chunk on the main thread, not yet played), the real-time factor (wall time on the
// page's main thread, from the click or the stream call to the last audio arriving there, over
// audio time), the mean time per frame inside the worker, the download (model files + the wasm
// build that ran) and the load time (fresh profile, no cache). Results go to
// benchmarks/out/<timestamp>.json.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { values } = parseArgs({
  options: {
    threads: { type: 'string', default: '1,3,8' },
    runs: { type: 'string', default: '3' },
    text: { type: 'string', default: 'The evening wind drifted down from the mountain pass, and the distant clouds slowly turned gold.' },
    port: { type: 'string', default: '8795' },
  },
});
const BASE = `http://127.0.0.1:${values.port}`;
const RUNS = Number(values.runs);
const DEADLINE_MS = 5 * 60 * 1000;
const CHECKPOINT = join(ROOT, '.cache/phonon-31m-en');
const REFERENCE_FILES = ['model.q8.gguf', 'tokenizer.json', 'config.json', 'default-voice.safetensors'];
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
const number = (text) => {
  const match = /[\d.]+/.exec(text ?? '');
  if (!match) throw new Error(`expected a number on the page, found ${JSON.stringify(text)}`);
  return Number(match[0]);
};
const bytes = (path) => statSync(path).size;

const mounts = {
  '/': 'app/dist',
  '/model/': 'dist/model',
  '/reference/': 'benchmarks/reference',
  '/phonon-tts/': 'benchmarks/node_modules/phonon-tts',
  '/checkpoint/': '.cache/phonon-31m-en',
};
const serveArgs = Object.entries(mounts).flatMap(([prefix, dir]) => ['--mount', `${prefix}=${dir}`]);
const server = spawn(process.execPath, [join(ROOT, 'vendor/fusor-ai/scripts/serve.mjs'), '--port', values.port, ...serveArgs], { cwd: ROOT, stdio: 'ignore' });
await new Promise((resolve) => setTimeout(resolve, 500));

/** A page in a fresh context: no cache, no OPFS. */
async function freshPage(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', (e) => log('pageerror:', e.message));
  return { context, page };
}

async function ours(browser, threads) {
  const { context, page } = await freshPage(browser);
  const wasm = [];
  page.on('response', (response) => response.url().endsWith('.wasm') && wasm.push(response.url()));
  const t0 = Date.now();
  await page.goto(`${BASE}/?threads=${threads}`);
  await page.waitForFunction(() => document.querySelector('main')?.dataset.phase === 'ready', null, { timeout: DEADLINE_MS });
  const loadMs = Date.now() - t0;
  const runtime = await page.textContent('#runtime');
  await page.fill('#text', values.text);
  const runs = [];
  for (let run = 0; run <= RUNS; run++) {
    await page.click('#generate');
    await page.waitForFunction(() => /^(done|stopped|error)/.test(document.getElementById('status').textContent), null, { timeout: DEADLINE_MS, polling: 'raf' });
    await page.waitForFunction(() => /\d/.test(document.getElementById('heard').textContent), null, { timeout: DEADLINE_MS, polling: 'raf' });
    const notes = await page.$$eval('.metrics dd.muted', (nodes) => nodes.map((node) => node.textContent));
    const result = {
      engineFirstMs: number(notes[0]),
      pageFirstMs: number(await page.textContent('#heard')),
      rtf: number(await page.textContent('#rtf')),
      frameMs: number(await page.textContent('#per-frame')),
      audioSeconds: number(await page.textContent('#audio-seconds')),
    };
    if (run > 0) runs.push(result);
    await page.waitForFunction(() => document.querySelector('.live')?.dataset.playing === 'false', null, { timeout: DEADLINE_MS });
  }
  await context.close();
  const build = wasm.map((url) => new URL(url).pathname).find((path) => path.endsWith('phonon_runtime_bg.wasm'));
  const manifest = JSON.parse(readFileSync(join(ROOT, 'dist/model/manifest.json'), 'utf8'));
  const download = manifest.parts.reduce((total, part) => total + part.bytes, 0) + bytes(join(ROOT, 'app', build.replace(/^\//, '')));
  return { runtime, loadMs, download, runs };
}

async function reference(browser, threads) {
  const { context, page } = await freshPage(browser);
  const wasm = [];
  page.on('response', (response) => response.url().endsWith('.wasm') && wasm.push(new URL(response.url()).pathname));
  await page.goto(`${BASE}/reference/?threads=${threads}&quant=q8`);
  const loaded = await page.evaluate(() => window.reference);
  const runs = [];
  for (let run = 0; run <= RUNS; run++) {
    const result = await page.evaluate((text) => window.speak(text), values.text);
    const seconds = result.samples / loaded.sampleRate;
    const measured = {
      engineFirstMs: result.stats.firstAudioMs,
      pageFirstMs: result.pageFirstMs,
      rtf: result.wallMs / 1000 / seconds,
      frameMs: result.stats.stepMs.avg,
      audioSeconds: seconds,
    };
    if (run > 0) runs.push(measured);
  }
  await context.close();
  const modelBytes = REFERENCE_FILES.reduce((total, file) => total + bytes(join(CHECKPOINT, file)), 0);
  const wasmBytes = wasm.reduce((total, path) => total + bytes(join(ROOT, 'benchmarks/node_modules', path.replace(/^\//, ''))), 0);
  return { runtime: `${loaded.device} · ${loaded.threads} threads · ${wasm.join(', ')}`, loadMs: loaded.loadMs, download: modelBytes + wasmBytes, runs };
}

function summary(name, threads, result) {
  const pick = (key) => median(result.runs.map((run) => run[key]));
  return {
    name,
    threads,
    runtime: result.runtime,
    downloadMB: +(result.download / 1e6).toFixed(1),
    loadMs: Math.round(result.loadMs),
    engineFirstMs: +pick('engineFirstMs').toFixed(1),
    pageFirstMs: +pick('pageFirstMs').toFixed(1),
    rtf: +pick('rtf').toFixed(3),
    frameMs: +pick('frameMs').toFixed(2),
    audioSeconds: +pick('audioSeconds').toFixed(2),
  };
}

const rows = [];
const browser = await chromium.launch({ headless: true });
try {
  for (const threads of values.threads.split(',').map(Number)) {
    log(`threads ${threads}: phonon-wasm`);
    rows.push(summary('phonon-wasm', threads, await ours(browser, threads)));
    log(`threads ${threads}: phonon-tts 0.4.0`);
    rows.push(summary('phonon-tts', threads, await reference(browser, threads)));
  }
} finally {
  await browser.close();
  server.kill();
}

console.log('\n| runtime | threads | download MB | load ms | first audio, engine ms | first audio, page ms | RTF | ms/frame | audio s |');
console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const row of rows) {
  console.log(`| ${row.name} | ${row.threads} | ${row.downloadMB} | ${row.loadMs} | ${row.engineFirstMs} | ${row.pageFirstMs} | ${row.rtf} | ${row.frameMs} | ${row.audioSeconds} |`);
}
const out = join(ROOT, 'benchmarks/out');
mkdirSync(out, { recursive: true });
const file = join(out, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(file, JSON.stringify({ text: values.text, runs: RUNS, rows }, null, 2));
log(`-> ${file}`);
