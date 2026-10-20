#!/bin/bash
# The whole browser matrix, one configuration at a time (benchmarks/browser.mjs): both runtimes
# at 1, 3, 4 and 8 threads on the CPU in Playwright's headless shell (q7 against q8, then f32
# against f32, then the plain-SIMD128 builds), phonon-tts on WebGPU in Google Chrome's headless
# mode (the headless shell has no GPU), with a CPU control row for each runtime in that Chrome.
#
#   MODEL_F32=<f32 bundle> benchmarks/browser-all.sh
set -euo pipefail
cd "$(dirname "$0")/.."
MODEL_F32=${MODEL_F32:?set MODEL_F32 to an f32 bundle (phonon compile ... --profile f32)}
run() { echo "=== $* (load $(sysctl -n vm.loadavg | awk '{print $2}'))"; nice -n 19 node benchmarks/browser.mjs "$@"; }

run --runtime phonon-wasm --threads 1,3,4,8
run --runtime phonon-tts --threads 1,3,4,8
MODEL=$MODEL_F32 MODEL_QUANT=f32 run --runtime phonon-wasm --threads 1,8 --out benchmarks/out/browser-f32
run --runtime phonon-tts --quant f32 --threads 1,8 --out benchmarks/out/browser-f32
run --runtime phonon-wasm --build web-single --threads 1 --skip-long
run --runtime phonon-wasm --build web-threaded --threads 8 --skip-long
run --runtime phonon-tts --simd simd128 --threads 1,8 --skip-long
run --runtime phonon-tts --device webgpu --threads 1 --channel chrome --out benchmarks/out/browser-chrome
run --runtime phonon-wasm --threads 8 --channel chrome --sentences S1 --out benchmarks/out/browser-chrome
run --runtime phonon-tts --threads 8 --channel chrome --sentences S1 --out benchmarks/out/browser-chrome
