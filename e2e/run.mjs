// End-to-end run in headless Chrome, in a fresh profile:
//
// 1. Open the page and press Speak while the model is still loading: the request is queued and
//    runs the moment the model is ready (measures page open → first audio).
// 2. Pick another voice: picking it plays a preview.
// 3. Speak in that voice with the model warm (measures click → first audio, the real-time factor
//    and the time per frame), and check that audio came out, that nothing was requested after the
//    model was ready, that playback had no gaps, and that the WAV the page offers is intelligible
//    (faster-whisper word error rate).
// 4. Reload: the revisit must load every part from OPFS.
//
//   ASR_PYTHON=<python with faster-whisper> PORT=8787 node e2e/run.mjs [--threads 8] [--build web-threaded]
//       [--voice maeve] [--text "..."]
//   node e2e/run.mjs --url https://example.org    # a deployed page, no local server
//
// The intelligibility check needs ASR_PYTHON, a Python with faster-whisper (scripts/asr_check.py);
// without it the run fails, unless --skip-asr says to accept a run without that check.
// Results (JSON, WAV, screenshots) go to e2e/results/<timestamp>-*.

import { chromium } from 'playwright';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { values } = parseArgs({
  options: {
    threads: { type: 'string' },
    build: { type: 'string' },
    text: { type: 'string', default: 'Please remember to water the plants on Tuesday, and call the dentist about the appointment at three o\'clock.' },
    voice: { type: 'string', default: 'maeve' },
    'max-wer': { type: 'string', default: '0.15' },
    'skip-asr': { type: 'boolean', default: false },
    url: { type: 'string' },
    model: { type: 'string' },
  },
});
const PORT = process.env.PORT ?? '8787';
const BASE = (values.url ?? `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
const ASR_PYTHON = process.env.ASR_PYTHON;
const DEADLINE_MS = 10 * 60 * 1000;
const RUN_DIR = join(ROOT, 'e2e/results');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const up = async () => {
  try {
    return (await fetch(`${BASE}/model/manifest.json`)).ok;
  } catch {
    return false;
  }
};
let server = null;
if (!values.url && !(await up())) {
  log(`starting fusor-ai's serve.mjs on :${PORT}`);
  const serve = join(ROOT, 'vendor/fusor-ai/scripts/serve.mjs');
  const mounts = ['--mount', '/=app/dist', '--mount', '/model/=dist/model'];
  server = spawn(process.execPath, [serve, '--port', PORT, ...mounts], { cwd: ROOT, stdio: 'inherit' });
  for (let i = 0; i < 50 && !(await up()); i++) await new Promise((r) => setTimeout(r, 200));
}

mkdirSync(RUN_DIR, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'phonon-e2e-'));
// The page's state machine is `main[data-phase]`: loading, ready, generating, broken.
const settled = () => /^(ready|broken)$/.test(document.querySelector('main')?.dataset.phase ?? '');
const finished = () => /^(done|stopped|error)/.test(document.getElementById('status')?.textContent ?? '');
const heard = () => /\d/.test(document.getElementById('heard')?.textContent ?? '');
const results = { started: new Date().toISOString(), base: BASE, text: values.text };
const failures = [];
const check = (ok, message) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) failures.push(message);
};

/** The live metric tiles, as the page shows them. */
async function metrics(page) {
  const tiles = ['heard', 'rtf', 'per-frame', 'audio-seconds', 'requests'];
  const texts = await Promise.all(tiles.map((id) => page.textContent(`#${id}`)));
  const notes = await page.$$eval('.metrics dd.muted', (nodes) => nodes.map((node) => node.textContent));
  return { ...Object.fromEntries(tiles.map((id, i) => [id, texts[i]])), notes };
}

/** Clicks `selector` (Speak, a voice) and waits for its synthesis to finish; returns the page's numbers. */
async function speak(page, requests, selector) {
  const requestsBefore = requests.length;
  await page.click(selector);
  await page.waitForFunction(finished, null, { timeout: DEADLINE_MS, polling: 'raf' });
  await page.waitForFunction(heard, null, { timeout: DEADLINE_MS, polling: 'raf' });
  const run = { status: await page.textContent('#status'), ...(await metrics(page)) };
  run.requestsDuringSynthesis = requests.slice(requestsBefore).filter((u) => !u.startsWith('blob:'));
  return run;
}

try {
  const context = await chromium.launchPersistentContext(profile, { headless: true });
  const requests = [];
  context.on('request', (r) => requests.push(r.url()));
  const page = context.pages()[0] ?? (await context.newPage());
  page.on('console', (m) => m.type() === 'error' && log('console:', m.text()));
  page.on('pageerror', (e) => log('pageerror:', e.message));
  const query = `?${new URLSearchParams(Object.entries({ threads: values.threads, build: values.build, model: values.model }).filter(([, v]) => v))}`;

  const t0 = Date.now();
  await page.goto(`${BASE}/${query}`);
  await page.fill('#text', values.text);
  results.queuedAt = await page.getAttribute('main', 'data-phase');
  await page.click('#generate');
  await page.waitForFunction(heard, null, { timeout: DEADLINE_MS, polling: 'raf' });
  results.openToFirstAudioMs = Date.now() - t0;
  await page.waitForFunction(finished, null, { timeout: DEADLINE_MS, polling: 'raf' });
  results.runtime = await page.textContent('#runtime');
  results.cold = await metrics(page);
  check(results.cold['audio-seconds'] !== '0.00 s', `queued run (clicked while ${results.queuedAt}): page open to first audio ${results.openToFirstAudioMs} ms; ${results.runtime}`);

  const playedOut = () => document.querySelector('.live')?.dataset.playing === 'false';
  await page.waitForFunction(playedOut, null, { timeout: DEADLINE_MS });
  const preview = await speak(page, requests, `label.voice:has(input[value="${values.voice}"])`);
  results.preview = preview;
  check(preview.status === 'done' && preview['audio-seconds'] !== '0.00 s', `${values.voice} preview: ${preview['audio-seconds']}, first audio ${preview.heard} (${preview.notes[0]})`);
  await page.waitForFunction(playedOut, null, { timeout: DEADLINE_MS });
  const warm = await speak(page, requests, '#generate');
  results.warm = warm;
  check(warm.status === 'done', `warm run: first audio ${warm.heard} (${warm.notes[0]}), RTF ${warm.rtf}, ${warm['per-frame']} per frame, ${warm['audio-seconds']} (${warm.notes[3]})`);
  check(warm.requestsDuringSynthesis.length === 0 && warm.requests === '0', `requests during synthesis: ${warm.requestsDuringSynthesis.length} seen, page counts ${warm.requests}`);
  await page.waitForFunction(playedOut, null, { timeout: DEADLINE_MS });
  results.played = await metrics(page);
  check(/no gaps/.test(results.played.notes[3]), `playback: ${results.played.notes[3]}`);
  await page.screenshot({ path: join(RUN_DIR, `${STAMP}-done.png`), fullPage: true });

  const wavBase64 = await page.evaluate(async () => {
    const bytes = new Uint8Array(await (await fetch(document.getElementById('download').href)).arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  });
  const wavPath = join(RUN_DIR, `${STAMP}.wav`);
  writeFileSync(wavPath, Buffer.from(wavBase64, 'base64'));
  results.wavBytes = Buffer.from(wavBase64, 'base64').length;
  check(results.wavBytes > 44 + 48000, `WAV ${(results.wavBytes / 1e6).toFixed(2)} MB -> ${wavPath}`);

  if (ASR_PYTHON) {
    const out = execFileSync(ASR_PYTHON, [join(ROOT, 'scripts/asr_check.py'), '--text', values.text, wavPath], { encoding: 'utf8' });
    results.asr = out.trim().split('\n').at(-1);
    const wer = Number(/WER=([\d.]+)/.exec(results.asr)[1]);
    check(wer <= Number(values['max-wer']), `ASR ${results.asr}`);
  } else {
    results.asr = 'not checked';
    check(values['skip-asr'], 'ASR not checked: set ASR_PYTHON to a Python with faster-whisper, or pass --skip-asr');
  }

  const t2 = Date.now();
  await page.reload();
  await page.waitForFunction(settled, null, { timeout: DEADLINE_MS, polling: 250 });
  results.revisitMs = Date.now() - t2;
  results.revisitDetail = await page.textContent('#runtime');
  check(/model loaded from this device/.test(results.revisitDetail), `revisit in ${(results.revisitMs / 1000).toFixed(1)} s: ${results.revisitDetail}`);
  await context.close();
} finally {
  rmSync(profile, { recursive: true, force: true });
  server?.kill();
}

results.failures = failures;
writeFileSync(join(RUN_DIR, `${STAMP}.json`), JSON.stringify(results, null, 2));
const verdict = failures.length ? `e2e FAILED (${failures.length})` : `e2e passed${ASR_PYTHON ? '' : ' WITHOUT the word error rate check'}`;
log(verdict, `-> e2e/results/${STAMP}.json`);
process.exit(failures.length ? 1 : 0);
