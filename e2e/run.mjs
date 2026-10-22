// End-to-end run in headless Chrome, in a fresh profile:
//
// 1. Open the page and press Speak while the model is still loading: the request is queued and
//    runs the moment the model is ready (measures page open → first audio).
// 2. Pick another voice: picking it only selects it, nothing plays.
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
// Results (JSON, WAV, screenshots) go to e2e/results/<timestamp>-*, or to `--out <dir>`.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetched, flags, run, STAMP } from '../vendor/fusor-ai/packages/e2e/kit.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const values = flags({
  text: { type: 'string', default: 'Please remember to water the plants on Tuesday, and call the dentist about the appointment at three o\'clock.' },
  voice: { type: 'string', default: 'maeve' },
  'max-wer': { type: 'string', default: '0.15' },
  'skip-asr': { type: 'boolean', default: false },
});
const ASR_PYTHON = process.env.ASR_PYTHON;
const DEADLINE_MS = 10 * 60 * 1000;

// The page's state machine is `main[data-phase]`: loading, ready, generating, broken.
const settled = () => /^(ready|broken)$/.test(document.querySelector('main')?.dataset.phase ?? '');
const finished = () => /^(done|stopped|error)/.test(document.getElementById('status')?.textContent ?? '');
const heard = () => /\d/.test(document.getElementById('heard')?.textContent ?? '');

/** The live metric tiles, as the page shows them. */
async function metrics(page) {
  const tiles = ['heard', 'rtf', 'per-frame', 'audio-seconds', 'requests'];
  const texts = await Promise.all(tiles.map((id) => page.textContent(`#${id}`)));
  const notes = await page.$$eval('.metrics dd.muted', (nodes) => nodes.map((node) => node.textContent));
  return { ...Object.fromEntries(tiles.map((id, i) => [id, texts[i]])), notes };
}

/** Clicks `selector` (Speak) and waits for its synthesis to finish; returns the page's numbers. */
async function speak(page, requests, selector) {
  const requestsBefore = requests.length;
  await page.click(selector);
  await page.waitForFunction(finished, null, { timeout: DEADLINE_MS, polling: 'raf' });
  await page.waitForFunction(heard, null, { timeout: DEADLINE_MS, polling: 'raf' });
  const run = { status: await page.textContent('#status'), ...(await metrics(page)) };
  run.requestsDuringSynthesis = fetched(requests, requestsBefore);
  return run;
}

const launch = {
  root: ROOT,
  name: 'phonon',
  values,
  fields: { text: values.text },
};
await run(launch, async ({ page, requests, query, base, runDir, results, check, revisit }) => {
  const t0 = Date.now();
  await page.goto(`${base}/${query}`);
  await page.waitForSelector('main[data-phase]');
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
  await page.click(`label.voice:has(input[value="${values.voice}"])`);
  const picked = await page.isChecked(`input[value="${values.voice}"]`);
  const phaseAfterPick = await page.getAttribute('main', 'data-phase');
  check(picked && phaseAfterPick === 'ready', `${values.voice} picked: selected, nothing plays (phase ${phaseAfterPick})`);
  const warm = await speak(page, requests, '#generate');
  results.warm = warm;
  check(warm.status === 'done', `warm run: first audio ${warm.heard} (${warm.notes[0]}), RTF ${warm.rtf}, ${warm['per-frame']} per frame, ${warm['audio-seconds']} (${warm.notes[3]})`);
  check(warm.requestsDuringSynthesis.length === 0 && warm.requests === '0', `requests during synthesis: ${warm.requestsDuringSynthesis.length} seen, page counts ${warm.requests}`);
  await page.waitForFunction(playedOut, null, { timeout: DEADLINE_MS });
  results.played = await metrics(page);
  check(/no gaps/.test(results.played.notes[3]), `playback: ${results.played.notes[3]}`);
  await page.screenshot({ path: join(runDir, `${STAMP}-done.png`), fullPage: true });

  const wavBase64 = await page.evaluate(async () => {
    const bytes = new Uint8Array(await (await fetch(document.getElementById('download').href)).arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  });
  const wavPath = join(runDir, `${STAMP}.wav`);
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

  await revisit(settled, DEADLINE_MS);
  return ASR_PYTHON ? '' : ' WITHOUT the word error rate check';
});
