// Copies a bundle into a static site with its tensor parts content-addressed: each part that holds
// tensors becomes parts/<blake3>.bin and the manifest names it so, which makes caching
// /model/parts/ as immutable safe across recompiles. Blob parts (tokenizer.json) keep their names:
// the runtime looks them up by name.
//
//   node scripts/site-bundle.mjs dist/model target/site/model

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [bundle, out] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8'));
const tensorParts = new Set(Object.values(manifest.tensors).map((tensor) => tensor.part));
mkdirSync(join(out, 'parts'), { recursive: true });
manifest.parts.forEach((part, index) => {
  const file = tensorParts.has(index) ? `parts/${part.blake3}.bin` : part.file;
  copyFileSync(join(bundle, part.file), join(out, file));
  part.file = file;
});
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
