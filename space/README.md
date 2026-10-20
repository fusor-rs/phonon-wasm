---
title: phonon-wasm
short_description: Phonon 31M text to speech in the browser
sdk: static
app_file: index.html
pinned: false
license: mit
models:
  - gradium/phonon-31m-en
custom_headers:
  cross-origin-embedder-policy: require-corp
  cross-origin-opener-policy: same-origin
  cross-origin-resource-policy: cross-origin
---

Text to speech with [Phonon 31M](https://huggingface.co/gradium/phonon-31m-en), computed on your
own CPU in the browser: the model, compiled to WebAssembly with fusor-ai, downloads once and then
runs sealed from the network, streaming each 80 ms frame to the speakers as it is computed. The
source is [github.com/fusor-rs/phonon-wasm](https://github.com/fusor-rs/phonon-wasm).
