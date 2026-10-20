# Phonon 31M in the browser. `just build` then `just serve` to build everything, the model
# included, from source; `just ui` once the bundle is in dist/model.

fusor_ai := "vendor/fusor-ai"
checkpoint := env_var_or_default("CHECKPOINT", ".cache/phonon-31m-en")
profile := env_var_or_default("PROFILE", "q7")
model := "dist/model"
model_f32 := "dist/model-f32"
goldens := "fixtures/goldens"
app := "app"
engine := "app/engine/dist"
fusor := justfile_directory() / ".tools/bin/fusor"
fusor_version := "0.1.9"
port := env_var_or_default("PORT", "8787")
nice := "nice -n 19"
threads_toolchain := "nightly-2025-11-15"
wasm_bindgen_version := "0.2.129"
variants := "web-single web-single-relaxed web-threaded web-threaded-relaxed"
version := `v=$(cargo pkgid -p phonon-cli); echo "${v##*[#@]}"`

default:
    @just --list

check: lint wasm host

lint:
    cargo fmt --all -- --check
    cargo fmt --manifest-path {{app}}/Cargo.toml -- --check
    cargo clippy --manifest-path {{app}}/Cargo.toml --target wasm32-unknown-unknown --locked -- -D warnings
    cargo test --workspace --locked
    cargo clippy --workspace --all-targets --locked -- -D warnings
    cargo doc --workspace --no-deps --locked

# The runtime compiles a different kernel backend per target feature set: lint each.
wasm:
    cargo clippy -p phonon-runtime --target wasm32-unknown-unknown --locked -- -D warnings
    cargo clippy -p phonon-runtime --target wasm32-unknown-unknown --locked --target-dir target/relaxed \
      --config 'target.wasm32-unknown-unknown.rustflags=["-C", "target-feature=+simd128,+relaxed-simd"]' -- -D warnings

host:
    bash -n scripts/fetch-checkpoint.sh
    node --check app/web/app.js
    node --check app/web/waveform.js
    node --check app/engine/worker.js
    node --check app/engine/playback.js
    node --check scripts/node-smoke.mjs
    node --check scripts/site-bundle.mjs
    node --check e2e/run.mjs
    node --check benchmarks/head-to-head.mjs
    node --check benchmarks/reference/reference.js

build: tools native model runtimes page

# The threads toolchain, and the pinned wasm-bindgen, binaryen and fusor CLI (into .tools/).
tools:
    test -f {{fusor_ai}}/Cargo.toml || { echo "vendor/fusor-ai: check out fusor-ai next to this repository (AGENTS.md)" >&2; exit 1; }
    rustup target list --installed | grep -q wasm32-unknown-unknown || rustup target add wasm32-unknown-unknown
    rustup run {{threads_toolchain}} rustc --version >/dev/null 2>&1 || rustup toolchain install {{threads_toolchain}} --profile minimal --component rust-src --target wasm32-unknown-unknown --no-self-update
    {{fusor_ai}}/scripts/install-tools.sh {{wasm_bindgen_version}} > /dev/null
    {{fusor}} --version 2>/dev/null | grep -qx 'fusor {{fusor_version}}' || cargo install --root .tools fusor-cli --version {{fusor_version}} --locked
    cd {{app}} && {{fusor}} install

native:
    {{nice}} cargo build --release -p phonon-cli

# Downloads the pinned checkpoint and voices (100 MB, sha256-checked) unless they are already
# there, then compiles the bundle (under a second).
model: native
    scripts/fetch-checkpoint.sh {{checkpoint}}
    rm -rf {{model}}
    target/release/phonon compile {{checkpoint}} {{model}} --profile {{profile}}

# The four browser runtimes, fusor-ai's loader next to them, and the sealed-runtime check.
runtimes: tools
    for variant in {{variants}}; do {{nice}} {{fusor_ai}}/scripts/build-runtime.sh phonon-runtime $variant {{engine}} || exit 1; done
    mkdir -p {{engine}}/host
    cp {{fusor_ai}}/packages/host/loader.js {{engine}}/host/
    for variant in {{variants}}; do \
      flags=""; case $variant in *threaded*) flags="--threaded";; esac; case $variant in *relaxed*) ;; *) flags="$flags --no-relaxed";; esac; \
      node {{fusor_ai}}/scripts/check-wasm-imports.mjs {{engine}}/$variant/phonon_runtime_bg.wasm --glue {{engine}}/$variant/phonon_runtime.js $flags || exit 1; \
    done

# The page, a fusor app, with the runtimes, into app/dist.
page:
    cd {{app}} && {{nice}} {{fusor}} build

serve:
    @echo "open http://localhost:{{port}}/"
    node {{fusor_ai}}/scripts/serve.mjs --port {{port}} --mount /={{app}}/dist --mount /model/={{model}}

# Try it on localhost. The bundle and the runtimes are rebuilt every time (incremental, seconds
# when nothing changed), so they always come from the same fusor-ai.
ui: model runtimes page serve

# Every stage against the reference's goldens (scripts/golden-harness), with the f32 bundle.
parity: native
    test -f {{goldens}}/golden_f32_A.safetensors || just goldens
    scripts/fetch-checkpoint.sh {{checkpoint}}
    rm -rf {{model_f32}}
    target/release/phonon compile {{checkpoint}} {{model_f32}} --profile f32
    target/release/phonon parity {{model_f32}} {{goldens}}/golden_f32_A.safetensors

# Golden tensors and WAVs from the reference runtime (gradium-ai/xn-ptts at a pinned commit).
goldens:
    scripts/fetch-checkpoint.sh {{checkpoint}}
    cargo run --release --manifest-path scripts/golden-harness/Cargo.toml -- {{checkpoint}} {{goldens}}/golden_f32_A.safetensors {{goldens}}/reference_f32_A.wav f32

bench: native
    target/release/phonon bench {{model}}

# The bundle and the runtimes are rebuilt first (seconds when nothing changed): a runtime only
# loads the bundle compiled with the same fusor-ai.
smoke: model runtimes
    node scripts/node-smoke.mjs {{model}} --build web-single
    node scripts/node-smoke.mjs {{model}} --build web-single-relaxed

e2e: model runtimes page
    cd e2e && npm ci --no-audit --no-fund --silent && npx playwright install chromium
    PORT={{port}} node e2e/run.mjs

# Same-browser speed against Gradium's phonon-tts on its q8 weights (benchmarks/head-to-head.mjs).
head-to-head: page
    scripts/fetch-checkpoint.sh {{checkpoint}} --reference
    cd benchmarks && npm ci --no-audit --no-fund --silent && npx playwright install chromium
    node benchmarks/head-to-head.mjs

# The page and the bundle beside it, as one static site in target/site, the bundle's tensor parts
# named by their BLAKE3 (`vercel.json` caches them as immutable).
site: runtimes page
    rm -rf target/site
    mkdir -p target/site
    cp -R {{app}}/dist/. target/site/
    find target/site -name '.fusor-*.json' -delete
    node scripts/site-bundle.mjs {{model}} target/site/model

# The site to Vercel as prebuilt files (`vercel.json`): `production` or `preview`.
deploy environment="production":
    @case "{{environment}}" in production|preview) ;; *) echo "deploy: expected production or preview, got {{environment}}" >&2; exit 2 ;; esac
    vercel build {{ if environment == "production" { "--prod" } else { "" } }} --yes
    vercel deploy --prebuilt {{ if environment == "production" { "--prod" } else { "" } }} --yes

# The site to the Hugging Face Space fusorlabs/phonon-wasm, configured by space/README.md.
deploy-space: site
    #!/usr/bin/env bash
    set -euo pipefail
    cp space/README.md target/site/
    uv run --no-project --with huggingface_hub==0.36.2 python - target/site <<'EOF'
    import sys
    from huggingface_hub import HfApi

    HfApi().upload_folder(
        repo_id="fusorlabs/phonon-wasm",
        repo_type="space",
        folder_path=sys.argv[1],
        delete_patterns="*",
        commit_message="Deploy phonon-wasm {{version}}",
    )
    EOF
