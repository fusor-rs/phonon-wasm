// Both browser runtimes in one headless Chrome through benchmarks/symmetric (one page, one
// clock, one definition of every number), per thread count: a fresh profile (cold load: no
// cache, no OPFS), one warm-up synthesis, then every sentence `--repeat` times, one long
// synthesis for the parallelism check (CPU time of every Chrome process over wall time), the
// memory of every Chrome process right after synthesis, and a reload of the same profile (warm
// load: OPFS for phonon-wasm, the Cache API for phonon-tts). The first measured WAV of each
// sentence is kept for the ASR check. Results: <out>/<tag>.json and <tag>-<sentence>.wav.
//
//   node benchmarks/browser.mjs --runtime phonon-wasm --threads 1,3,4,8 [--build web-threaded]
//   node benchmarks/browser.mjs --runtime phonon-tts --threads 1,3,4,8 [--quant q8|f32] [--device cpu|webgpu]
//   [--repeat 3] [--sentences S1,S2,S3] [--out benchmarks/out/browser] [--port 8795] [--channel chromium]
//
// Everything is served by fusor-ai's serve.mjs with COOP/COEP (threads), from these mounts:
// / = app/dist, /host/ = vendor/fusor-ai/packages/host (the compute pool), /model/ = dist/model
// (or $MODEL), /symmetric/ = benchmarks/symmetric,
// /phonon-tts/ = benchmarks/node_modules/phonon-tts, /checkpoint/ = $CHECKPOINT
// (.cache/phonon-31m-en: their q8 GGUF, f32 safetensors, tokenizer, config, default voice).

import { chromium } from 'playwright';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SENTENCES = {
  S1: "Please remember to water the plants on Tuesday, and call the dentist about the appointment at three o'clock.",
  S2: 'The evening wind drifted down from the mountain pass, and the distant clouds slowly turned gold.',
  S3: 'Glaciers move slowly, carving valleys over thousands of years while the rivers below carry the silt to the sea.',
};
const LONG = Array(3).fill(Object.values(SENTENCES).join(' ')).join(' ');
const OPTIONS = { temperature: 0.3, seed: 4242424242424242 };
const { values } = parseArgs({
  options: {
    runtime: { type: 'string', default: 'phonon-wasm' },
    threads: { type: 'string', default: '1,3,4,8' },
    build: { type: 'string' },
    quant: { type: 'string', default: 'q8' },
    device: { type: 'string', default: 'cpu' },
    simd: { type: 'string', default: 'relaxed' },
    repeat: { type: 'string', default: '3' },
    sentences: { type: 'string', default: 'S1,S2,S3' },
    out: { type: 'string', default: 'benchmarks/out/browser' },
    port: { type: 'string', default: '8795' },
    channel: { type: 'string' },
    'skip-long': { type: 'boolean', default: false },
  },
});
const BASE = `http://127.0.0.1:${values.port}`;
const DEADLINE = 10 * 60 * 1000;
const MODEL = process.env.MODEL ?? 'dist/model';
const CHECKPOINT = process.env.CHECKPOINT ?? '.cache/phonon-31m-en';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const mounts = { '/': 'app/dist', '/host/': 'vendor/fusor-ai/packages/host', '/model/': MODEL, '/symmetric/': 'benchmarks/symmetric', '/phonon-tts/': 'benchmarks/node_modules/phonon-tts', '/checkpoint/': CHECKPOINT };
const server = spawn(process.execPath, [join(ROOT, 'vendor/fusor-ai/scripts/serve.mjs'), '--port', values.port, ...Object.entries(mounts).flatMap(([p, d]) => ['--mount', `${p}=${d}`])], { cwd: ROOT, stdio: 'ignore' });
for (let i = 0; i < 50; i++) {
  try { if ((await fetch(`${BASE}/symmetric/`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 200));
}

/** Every process of the Chrome whose main process carries this profile: pid, RSS (kB), CPU seconds. */
function chromeProcesses(profile) {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,time=,command='], { encoding: 'utf8' })
    .split('\n').map((l) => l.trim().split(/\s+/)).filter((f) => f.length >= 5)
    .map(([pid, ppid, rss, time, ...cmd]) => ({ pid, ppid, rss: Number(rss), cpu: time.split(':').reduce((s, part) => s * 60 + Number(part), 0), cmd: cmd.join(' ') }));
  const main = rows.find((r) => r.cmd.includes(`--user-data-dir=${profile}`));
  const pids = new Set(main ? [main.pid] : []);
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of rows) if (pids.has(r.ppid) && !pids.has(r.pid)) (pids.add(r.pid), (grew = true));
  }
  const mine = rows.filter((r) => pids.has(r.pid));
  return { rssMb: Math.round(mine.reduce((n, r) => n + r.rss, 0) / 1024), cpuS: mine.reduce((n, r) => n + r.cpu, 0), count: mine.length };
}

const query = (threads) => {
  const q = new URLSearchParams({ runtime: values.runtime, threads: String(threads) });
  if (values.runtime === 'phonon-wasm') { if (values.build) q.set('build', values.build); }
  else { q.set('quant', values.quant); q.set('device', values.device); q.set('simd', values.simd); q.set('cache', '1'); }
  return `${BASE}/symmetric/?${q}`;
};

/** Navigates and waits for the engine, returning its load info and the bytes the page fetched. */
async function load(page, threads) {
  let fetched = 0;
  const files = new Set();
  const onResponse = async (response) => {
    try {
      if (response.fromServiceWorker()) return;
      const body = await response.body();
      fetched += body.length;
      files.add(new URL(response.url()).pathname);
    } catch {}
  };
  page.on('response', onResponse);
  const t0 = performance.now();
  await page.goto(query(threads));
  const info = await page.evaluate(() => window.ready);
  const navMs = performance.now() - t0;
  await new Promise((r) => setTimeout(r, 300));
  page.off('response', onResponse);
  return { info, navMs, fetchedBytes: fetched, files: [...files] };
}

/** The model files plus the wasm build that ran, from the files on disk (what a first visit downloads, before compression). */
function downloadBytes(info) {
  const size = (p) => statSync(join(ROOT, p)).size;
  if (values.runtime === 'phonon-wasm') {
    const manifest = JSON.parse(readFileSync(join(MODEL, 'manifest.json'), 'utf8'));
    return manifest.parts.reduce((n, part) => n + part.bytes, 0) + size(`app/engine/dist/${info.build}/phonon_runtime_bg.wasm`);
  }
  const pkg = 'benchmarks/node_modules/phonon-tts';
  const wasm = `${pkg}/${info.threads > 1 ? 'wasm-threads' : 'wasm'}/${values.simd === 'simd128' ? 'phonon_tts_simd_bg.wasm' : 'phonon_tts_bg.wasm'}`;
  const model = ['tokenizer.json', 'config.json', 'default-voice.safetensors', values.quant === 'f32' ? 'model.safetensors' : 'model.q8.gguf'].map((f) => join(CHECKPOINT, f));
  return model.reduce((n, f) => n + statSync(f).size, 0) + size(wasm);
}

const outDir = join(ROOT, values.out);
mkdirSync(outDir, { recursive: true });
const results = [];
for (const threads of values.threads.split(',').map(Number)) {
  const tag = `${values.runtime}${values.build ? `-${values.build}` : ''}${values.runtime === 'phonon-tts' ? `-${values.quant}-${values.device}-${values.simd}` : ''}-t${threads}`;
  const profile = mkdtempSync(join(tmpdir(), 'phonon-bench-'));
  const result = { tag, runtime: values.runtime, threads, build: values.build ?? null, quant: values.runtime === 'phonon-tts' ? values.quant : process.env.MODEL_QUANT ?? 'q7', device: values.runtime === 'phonon-tts' ? values.device : 'cpu', simd: values.runtime === 'phonon-tts' ? values.simd : null, runs: [] };
  log(`${tag}: load ${(loadavg()[0]).toFixed(1)}`);
  try {
    const context = await chromium.launchPersistentContext(profile, { headless: true, channel: values.channel, args: values.device === 'webgpu' ? ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=metal', '--ignore-gpu-blocklist'] : [] });
    result.chrome = context.browser()?.version?.() ?? null;
    const page = context.pages()[0] ?? (await context.newPage());
    page.on('pageerror', (e) => log('pageerror:', e.message));
    page.on('console', (m) => m.type() === 'error' && log('console:', m.text()));
    const cold = await load(page, threads);
    result.coldLoadMs = Math.round(cold.info.loadMs);
    result.coldNavMs = Math.round(cold.navMs);
    result.fetchedBytes = cold.fetchedBytes;
    result.files = cold.files.filter((f) => /\.(wasm|gguf|safetensors|json)$|parts/.test(f));
    result.engine = cold.info;
    result.downloadBytes = downloadBytes(cold.info);
    log(`  loaded in ${result.coldLoadMs} ms (${(result.downloadBytes / 1e6).toFixed(1)} MB model + wasm): ${JSON.stringify(cold.info)}`);
    await page.evaluate((o) => window.speak('Warm up, warm up, warm up.', o), OPTIONS);
    for (const key of values.sentences.split(',')) {
      for (let i = 0; i < Number(values.repeat); i++) {
        const r = await page.evaluate(([text, o]) => window.speak(text, o), [SENTENCES[key], OPTIONS]);
        const wav = r.wav;
        delete r.wav;
        const run = { sentence: key, run: i, audio_s: +(r.samples / r.sampleRate).toFixed(3), frames: r.frames, wall_s: +(r.wallMs / 1000).toFixed(4), rtf: +(r.wallMs / 1000 / (r.samples / r.sampleRate)).toFixed(4), page_first_ms: +r.pageFirstMs.toFixed(1), engine_first_ms: +r.engineFirstMs.toFixed(1), step_ms: +r.stepMs.toFixed(2), engine_wall_s: +(r.engineWallMs / 1000).toFixed(4), network_requests: r.networkRequests, loadavg: +loadavg()[0].toFixed(1) };
        result.runs.push(run);
        log(`  ${key} run ${i}: ${run.frames} frames, ${run.audio_s} s in ${run.wall_s} s, RTF ${run.rtf}, first ${run.page_first_ms} ms (engine ${run.engine_first_ms}), ${run.step_ms} ms/frame`);
        if (i === 0) writeFileSync(join(outDir, `${tag}-${key}.wav`), Buffer.from(wav, 'base64'));
      }
    }
    if (!values['skip-long']) {
      const before = chromeProcesses(profile);
      const t0 = performance.now();
      const r = await page.evaluate(([text, o]) => window.speak(text, o), [LONG, OPTIONS]);
      const wallS = (performance.now() - t0) / 1000;
      const after = chromeProcesses(profile);
      result.parallelism = { audio_s: +(r.samples / r.sampleRate).toFixed(2), wall_s: +wallS.toFixed(3), rtf: +(r.wallMs / 1000 / (r.samples / r.sampleRate)).toFixed(4), cpu_s: +(after.cpuS - before.cpuS).toFixed(2), parallelism: +((after.cpuS - before.cpuS) / wallS).toFixed(2), processes: after.count, loadavg: +loadavg()[0].toFixed(1) };
      log(`  long: ${result.parallelism.audio_s} s audio in ${wallS.toFixed(2)} s, RTF ${result.parallelism.rtf}, CPU ${result.parallelism.cpu_s} s → parallelism ${result.parallelism.parallelism}`);
    }
    result.rssMb = chromeProcesses(profile).rssMb;
    const warm = await load(page, threads);
    result.warmLoadMs = Math.round(warm.info.loadMs);
    result.warmNavMs = Math.round(warm.navMs);
    result.warmFetchedBytes = warm.fetchedBytes;
    result.warmEngine = warm.info;
    log(`  memory ${result.rssMb} MB; revisit loaded in ${result.warmLoadMs} ms (${warm.fetchedBytes / 1e6 | 0} MB fetched)`);
    await context.close();
  } catch (e) {
    result.error = String(e?.stack ?? e);
    log('  error:', result.error.split('\n')[0]);
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
  results.push(result);
  writeFileSync(join(outDir, `${tag}.json`), JSON.stringify(result, null, 2));
}
server.kill();
log(`-> ${values.out}/`);
