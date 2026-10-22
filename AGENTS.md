# AGENTS.md

Rules for coding agents in this repository that are its own. fusor-ai's
`vendor/fusor-ai/AGENTS.md` is the standard and binds here too (`CLAUDE.md`
imports both); this file adds what is particular to this product.

phonon-wasm is the Phonon 31M (gradium/phonon-31m-en) text-to-speech app: the
model running in the browser on the CPU, sealed from the network, streaming each
80 ms frame to the speakers as it is computed. The README describes what it does;
don't invent scope, features or options beyond the task.

## Repository

- `vendor/fusor-ai/models/phonon/runtime`: the wasm-bindgen surface of the model
  (bundle parts in, PCM out), built as four browser runtimes.
- `vendor/fusor-ai/models/phonon/cli`: the native CLI `phonon` (`compile`,
  `synth`, `bench`, `parity`).
- `app/`: the page, a [fusor](https://github.com/fusor-rs/fusor) app with its own
  Cargo workspace (fusor pins wasm-bindgen 0.2.117, the runtime 0.2.129): the
  form, the loading and the live measurements as Rust signals in `src/app.rs`,
  the template in `web/index.html`, the engine bridge and the waveform in
  `web/*.js`, and in `engine/` the engine worker and the audio worklet it feeds,
  beside the runtimes `just runtimes` builds.
- `scripts/`: the checkpoint download, the Node smoke test and the ASR check;
  `e2e/run.mjs`: the headless Chrome run; `benchmarks/head-to-head.mjs`: the
  same-browser comparison with Gradium's `phonon-tts`.
- [fusor-ai](https://github.com/fusor-rs/fusor-ai): the model (`phonon`), its
  compiler (`phonon-compile`), the kernels, blocks and bundle format come from
  `vendor/fusor-ai`, a git submodule pinned to a commit pushed to fusor-ai, with
  the browser loader and compute pool, the runtime build, the import check and
  the dev server.

What belongs where: model code (dimensions, tensor names, wiring, sampling,
prompts, the text frontend) and anything another model could reuse go to
fusor-ai, following its `AGENTS.md`. This repository holds what turns the model
into an app: the page, the checks against the reference and the deployment. A
change to fusor-ai lands there first; this repository never patches it.

Constraints that hold everywhere:

- fusor-ai comes only from `vendor/fusor-ai`, never a crates.io version, a
  `[patch]` table or a sibling checkout. The submodule moves to another pushed
  fusor-ai commit in a change of its own, with the parity numbers and the e2e
  result it gave. No copies of fusor-ai code here.
- The page may cache the bundle (OPFS) and measure itself; the runtime may not
  do I/O. Audio leaves the engine worker for the audio worklet directly, so the
  page's main thread only draws.

## Checks

A change is done only when this passes:

```sh
just check
```

It runs formatting and Clippy on the page and syntax checks of the scripts;
fusor-ai's `just check` covers the runtime and the CLI. A change to the runtime,
the page, the CLI or fusor-ai also needs `just runtimes`, `just smoke`, `just
parity` (the same numbers as before unless the change is meant to move them) and
`just e2e`; a change meant to move speed also needs `just head-to-head`. The
model is checked stage by stage against the reference goldens by `phonon
parity`; extend it rather than adding a parallel harness.

## Commits

- Don't commit, push, tag, release or deploy unless asked. Deploying is
  described in `CONTRIBUTING.md` and is done by the maintainer.
