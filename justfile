# Phonon 31M in the browser. `just build` then `just serve` to build everything, the model
# included, from source; `just ui` once the bundle is in dist/model.

import 'vendor/fusor-ai/just/product.just'

name := "phonon"
checkpoint := env_var_or_default("CHECKPOINT", ".cache/phonon-31m-en")
profile := env_var_or_default("PROFILE", "q7")
model_f32 := "dist/model-f32"
goldens := "fixtures/goldens"

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

# Downloads the pinned checkpoint and voices (100 MB, sha256-checked) unless they are already
# there, then compiles the bundle (under a second).
model: native
    scripts/fetch-checkpoint.sh {{checkpoint}}
    rm -rf {{model}}
    target/release/phonon compile {{checkpoint}} {{model}} --profile {{profile}}

# Try it on localhost. The bundle and the runtimes are rebuilt every time (incremental, seconds
# when nothing changed), so they always come from the same fusor-ai.
ui: model runtimes page serve

# Every stage against the reference's goldens (vendor/fusor-ai/models/phonon/reference), with the
# f32 bundle.
parity: native
    test -f {{goldens}}/golden_f32_A.safetensors || just goldens
    scripts/fetch-checkpoint.sh {{checkpoint}}
    rm -rf {{model_f32}}
    target/release/phonon compile {{checkpoint}} {{model_f32}} --profile f32
    target/release/phonon parity {{model_f32}} {{goldens}}/golden_f32_A.safetensors

# Golden tensors and WAVs from the reference runtime (gradium-ai/xn-ptts at a pinned commit).
goldens:
    scripts/fetch-checkpoint.sh {{checkpoint}}
    cargo run --release --manifest-path {{fusor_ai}}/models/phonon/reference/Cargo.toml -- {{checkpoint}} {{goldens}}/golden_f32_A.safetensors {{goldens}}/reference_f32_A.wav f32

bench: native
    target/release/phonon bench {{model}}

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

# The fixed inputs the checks read.
fixtures:
