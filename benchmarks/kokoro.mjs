// Runs benchmarks/kokoro/index.html (Kokoro-82M through kokoro-js, onnxruntime-web, wasm) in
// headless Chrome and writes the timings and the first WAV per sentence. The model and the
// library come from the network (jsdelivr, Hugging Face) on each run. fusor-ai's serve.mjs
// sends COOP/COEP, and the CDN and the Hub answer with CORS headers, so the page is
// cross-origin isolated and onnxruntime-web gets its threads (ming-wasm ran it the same way).
//
//   node benchmarks/kokoro.mjs [--dtype q8|fp32] [--repeat 3] [--out benchmarks/out/kokoro] [--port 8796]
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { values } = parseArgs({ options: { dtype: { type: 'string', default: 'q8' }, repeat: { type: 'string', default: '3' }, out: { type: 'string', default: 'benchmarks/out/kokoro' }, port: { type: 'string', default: '8796' } } });
const server = spawn(process.execPath, [join(ROOT, 'vendor/fusor-ai/scripts/serve.mjs'), '--port', values.port, '--mount', '/=benchmarks/kokoro'], { cwd: ROOT, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const outDir = join(ROOT, values.out);
mkdirSync(outDir, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'kokoro-bench-'));
try {
  const context = await chromium.launchPersistentContext(profile, { headless: true });
  const page = context.pages()[0] ?? (await context.newPage());
  page.on('console', (m) => m.type() === 'error' && console.log('console:', m.text()));
  await page.goto(`http://127.0.0.1:${values.port}/?dtype=${values.dtype}&repeat=${values.repeat}`);
  await page.waitForFunction(() => document.body.dataset.done === '1', null, { timeout: 900000, polling: 250 });
  const results = await page.evaluate(() => window.__results);
  console.log(await page.textContent('#log'));
  for (const [key, b64] of Object.entries(results.wavs)) writeFileSync(join(outDir, `kokoro-${values.dtype}-${key}.wav`), Buffer.from(b64, 'base64'));
  delete results.wavs;
  results.chrome = context.browser()?.version?.() ?? null;
  results.loadavg = +loadavg()[0].toFixed(1);
  try {
    const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,command='], { encoding: 'utf8' }).split('\n').map((l) => l.trim().split(/\s+/)).filter((f) => f.length >= 4).map(([pid, ppid, rss, ...cmd]) => ({ pid, ppid, rss: Number(rss), cmd: cmd.join(' ') }));
    const main = rows.find((r) => r.cmd.includes(`--user-data-dir=${profile}`));
    const pids = new Set(main ? [main.pid] : []);
    for (let grew = true; grew; ) { grew = false; for (const r of rows) if (pids.has(r.ppid) && !pids.has(r.pid)) (pids.add(r.pid), (grew = true)); }
    results.rssMb = Math.round(rows.filter((r) => pids.has(r.pid)).reduce((n, r) => n + r.rss, 0) / 1024);
  } catch {}
  writeFileSync(join(outDir, `kokoro-${values.dtype}.json`), JSON.stringify(results, null, 2));
  await context.close();
} finally {
  rmSync(profile, { recursive: true, force: true });
  server.kill();
}
