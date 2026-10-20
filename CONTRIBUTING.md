# Contributing

Use Rust 1.99 or later, edition 2024, Node.js 22 or later, and `just`. Check
[fusor-ai](https://github.com/fusor-rs/fusor-ai) out next to this repository: `vendor/fusor-ai`
is a symlink to `../../fusor-ai`, and the model, its compiler and the toolkit crates are path
dependencies into it until fusor-ai publishes the Phonon crates. `unsafe` is denied except in
the module that states why it needs it (see `AGENTS.md`).

Run `just check` before considering a change complete. It formats, tests and lints the crates
natively, the runtime for `wasm32-unknown-unknown` (SIMD128 and relaxed SIMD) and the page,
and syntax-checks the scripts. `just ui` builds the page and serves it; the page is a
[fusor](https://github.com/fusor-rs/fusor) app in `app/`, built with the fusor CLI that
`just tools` installs into `.tools/`. A change to the runtime, the page, the CLI or fusor-ai
also needs `just build` once, then `just runtimes`, `just smoke`, `just parity` and
`just e2e`, and a change meant to move speed `just head-to-head`. Say in the pull request what
they showed (parity numbers, real-time factor, first-audio latency, word error rate) and which
fusor-ai commit they ran against.

`just parity` compares every stage with goldens from Gradium's reference runtime, which
`just goldens` makes with `scripts/golden-harness` (it builds that runtime at a pinned commit, a
few minutes); `just parity` runs it first when the goldens are missing. `just e2e` checks the speech it makes with
faster-whisper and needs `ASR_PYTHON`, a Python that has it:

```sh
uv venv .cache/asr && uv pip install --python .cache/asr/bin/python faster-whisper==1.2.1
ASR_PYTHON=.cache/asr/bin/python just e2e
```

Without `ASR_PYTHON` the e2e fails; `node e2e/run.mjs --skip-asr` runs it without that check and
says so.

The threaded runtimes need `nightly-2025-11-15` with `rust-src`; `just tools` installs it,
and fusor-ai's `scripts/install-tools.sh` the pinned wasm-bindgen and binaryen into `.tools/`.

## Deploying the site

`just site` puts the page, its four runtimes and the bundle beside it into `target/site`, a
static site that must be served cross-origin isolated to get the threaded runtimes. The bundle's
tensor parts are named by their BLAKE3 there, so caching `/model/parts/` as immutable stays
correct across recompiles, and the page deletes the parts of earlier bundles from its OPFS cache
after loading a new one.
[vercel.json](vercel.json) does that for Vercel (`just deploy`, prebuilt files, after
`vercel link`), and [space/README.md](space/README.md) for a static Hugging Face Space
(`just deploy-space`, with [uv](https://docs.astral.sh/uv/) after `hf auth login`).

## Using AI tools

You're welcome to use AI tools, but you're responsible for everything you submit. Read and
understand every line, make sure the tests you add would fail without your change, and be ready
to explain your reasoning in review. Please don't open pull requests or issues generated
without that review.

Coding agents follow `AGENTS.md`, which is also the code standard for every change.
