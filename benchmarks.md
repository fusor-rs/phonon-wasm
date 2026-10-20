# Benchmarks

How fast Phonon 31M speaks on one machine, in every runtime of it that runs here: this repository's phonon-wasm (the native `phonon` CLI, the four WebAssembly builds in Chrome, the single-threaded ones in Node) against Gradium's own runtime of the same model, [xn-ptts](https://github.com/gradium-ai/xn-ptts) (the native `ptts` CLI in f32, q8 and q4k on the CPU and f32 on Metal; its npm package `phonon-tts` in Chrome on the CPU and on WebGPU, and in Node). For scale, two different models: Kyutai's Pocket TTS (the PyTorch package, its own 110M-parameter English model) and Kokoro.js (82M). Everything here was measured on 2026-10-20 on the machine below, by scripts in `benchmarks/`; nothing is quoted from elsewhere, and the raw data is in `benchmarks/out/`.

**Real-time factor (RTF)** is generation time divided by the duration of the audio produced: 0.05 means a second of speech took 50 ms to compute, and anything below 1 is faster than real time. Phonon produces speech in 80 ms frames, so RTF is also ms per frame divided by 80. Beside RTF: the **time to first audio** (request to the first PCM frame, defined the same way on both sides, see below), the **model load time** cold and warm, the **memory** of the process, the **download** of the browser builds, and the **word error rate (WER)** of faster-whisper's transcription of the output against the input, so that speed is never bought with unintelligible audio.

Three sentences, the same three as ming-wasm's benchmarks, all with the checkpoint's default voice, temperature 0.3 and seed 4242424242424242 (both runtimes' defaults, passed explicitly):

| | Sentence |
|---|---|
| S1 | Please remember to water the plants on Tuesday, and call the dentist about the appointment at three o'clock. |
| S2 | The evening wind drifted down from the mountain pass, and the distant clouds slowly turned gold. |
| S3 | Glaciers move slowly, carving valleys over thousands of years while the rivers below carry the silt to the sea. |

Every number is the **median of three measured runs after one warm-up run**, with the minimum in parentheses, unless stated otherwise. Each sentence gives 5.5–6.6 s of audio.

## Headline

Sentence S1. phonon-wasm's app bundle is q7 (7-bit weights); Gradium's quantized weights are q8, so the like-for-like pairs are **q7 against q8** and **f32 against f32**. Threads are the compute threads each runtime was told to use, and "parallelism" is the CPU time over the wall time of one long synthesis (53 s of audio), the check that the setting took.

| Runtime | Weights | Threads (parallelism) | RTF | First audio | Load (cold / warm) | Memory | WER |
|---|---|---:|---:|---:|---:|---:|---:|
| **native, this machine's CPU** | | | | | | | |
| `phonon synth` (phonon-wasm) | q7 | 1 (1.0) | 0.070 (0.070) | 15 ms | 0.07 s | 142 MB | 0 |
| `ptts` (xn-ptts) | q8 | 1 (1.7) | **0.020 (0.020)** | 15 ms | 0.05 s | 316 MB | 0 |
| `phonon synth` | q7 | 4 (3.8) | 0.022 (0.022) | **5 ms** | 0.04 s | 143 MB | 0 |
| `ptts` | q8 | 4 (3.7) | **0.018 (0.018)** | 15 ms | 0.05 s | 315 MB | 0 |
| `phonon synth` | q7 | 8 (7.3) | 0.040 (0.038) † | 8 ms | 0.05 s | 148 MB | 0 |
| `ptts` | q8 | 8 (5.3) | **0.019 (0.019)** | 14 ms | 0.05 s | 291 MB | 0 |
| `ptts` | q4k | 4 (3.7) | 0.022 (0.021) | 32 ms | 0.02 s | 283 MB | 0 |
| `phonon synth` | f32 | 1 (1.0) | 0.265 (0.264) | 61 ms | 0.24 s | 263 MB | 0 |
| `ptts` (Accelerate) | f32 | 1 (1.6) | **0.025 (0.024)** | 20 ms | 0.02 s | 292 MB | 0 |
| `phonon synth` | f32 | 8 (7.6) | 0.062 (0.053) | 14 ms | 0.13 s | 267 MB | 0 |
| `ptts` (Accelerate) | f32 | 8 (4.6) | **0.031 (0.026)** | 22 ms | 0.02 s | 291 MB | 0 |
| `ptts --device metal` (Apple GPU) | f32 | – (0.3) | 0.047 (0.042) | 25 ms | 0.03 s | 250 MB | 0 |
| **Chrome, CPU (Playwright's headless shell)** | | | | | | | |
| phonon-wasm `web-single-relaxed` | q7 | 1 (1.0) | **0.098 (0.098)** | **21 ms** | 221 / 173 ms | 397 MB | 0 |
| phonon-tts 0.4.0, relaxed SIMD | q8 | 1 (1.0) | 0.129 (0.125) | 26 ms | 348 / 174 ms | 673 MB | 0 |
| phonon-wasm `web-threaded-relaxed` | q7 | 3 (2.9) | **0.038 (0.038)** | **8 ms** | 216 / 120 ms | 491 MB | 0 |
| phonon-tts, relaxed SIMD | q8 | 3 (3.0) | 0.063 (0.063) | 13 ms | 318 / 167 ms | 682 MB | 0 |
| phonon-wasm `web-threaded-relaxed` | q7 | 4 (3.8) | **0.031 (0.031)** | **6 ms** | 197 / 104 ms | 566 MB | 0 |
| phonon-tts, relaxed SIMD | q8 | 4 (4.0) | 0.053 (0.053) | 11 ms | 273 / 159 ms | 681 MB | 0 |
| phonon-wasm `web-threaded-relaxed` | q7 | 8 (7.5) | **0.022 (0.022)** | **4 ms** | 203 / 100 ms | 582 MB | 0 |
| phonon-tts, relaxed SIMD | q8 | 8 (7.6) | 0.053 (0.048) | 12 ms | 310 / 144 ms | 721 MB | 0 |
| phonon-wasm `web-single` (SIMD128) | q7 | 1 | **0.150 (0.149)** | 33 ms | 285 / 212 ms | 394 MB | 0 |
| phonon-tts, SIMD128 | q8 | 1 | 0.186 (0.185) | 50 ms | 434 / 252 ms | 656 MB | 0 |
| phonon-wasm `web-threaded` (SIMD128) | q7 | 8 | **0.038 (0.031)** | 6 ms | 230 / 121 ms | 544 MB | 0 |
| phonon-tts, SIMD128 | q8 | 8 | 0.057 (0.056) | 14 ms | 333 / 167 ms | 711 MB | 0 |
| phonon-wasm `web-single-relaxed` | f32 | 1 (1.0) | 0.242 (0.242) | 54 ms | 424 / 318 ms | 686 MB | 0 |
| phonon-tts, relaxed SIMD | f32 | 1 (1.0) | **0.150 (0.149)** | 29 ms | 437 / 190 ms | 704 MB | 0 |
| phonon-wasm `web-threaded-relaxed` | f32 | 8 (7.7) | **0.044 (0.044)** | 11 ms | 369 / 220 ms | 721 MB | 0 |
| phonon-tts, relaxed SIMD | f32 | 8 (7.6) | 0.055 (0.054) | 8 ms | 417 / 182 ms | 783 MB | 0 |
| **Google Chrome 155 headless (the one browser here with a GPU)** | | | | | | | |
| phonon-tts, WebGPU | q8 | GPU (1.3) | 0.024 (0.024) | 15 ms | 465 / 192 ms | 1178 MB | 0 |
| phonon-wasm `web-threaded-relaxed` | q7 | 8 (7.5) | 0.032 (0.026) † | 8 ms | 229 / 127 ms | 1244 MB | 0 |
| phonon-tts, relaxed SIMD | q8 | 8 (7.7) | 0.050 (0.050) | 10 ms | 317 / 156 ms | 1398 MB | 0 |
| **Node 22, one thread** | | | | | | | |
| phonon-wasm `web-single-relaxed` | q7 | 1 | **0.098 (0.097)** | 20 ms | 0.15 s | – | 0 |
| phonon-tts, relaxed SIMD | q8 | 1 | 0.123 (0.122) | 25 ms | 0.27 s | – | 0 |
| **Different models, for scale** | | | | | | | |
| *Pocket TTS 4.0.0, PyTorch, its 110M English model* | f32 | 1 (as shipped) | 0.076 (0.076) | 24 ms | 0.77 s | 1006 MB | 0 |
| *Kokoro.js 1.2.1, Kokoro-82M, Chrome, onnxruntime-web* | fp32 | ORT default | 0.405 (0.401) | = total, 2.6 s | 11.7 s from the network | 1265 MB | 0 |
| *Kokoro.js, Kokoro-82M, Chrome* | q8 | ORT default | 0.719 (0.705) | = total, 4.7 s | 4.7 s from the network | 649 MB | 0 |

Download for the browser rows is in the browser section (48.5 MB for phonon-wasm q7, 69.4 MB for phonon-tts q8, 108 MB for phonon-tts f32, 164 MB for phonon-wasm f32: the model files plus the wasm build that ran, uncompressed). Memory is the peak resident set of the process (`/usr/bin/time -l`), or for Chrome the sum of the resident sets of every process of the browser profile right after synthesis, which includes the browser's own baseline (about 400 MB in the headless shell, 1.1 GB in Google Chrome). † marks rows whose three runs spread widely (minimum well below the median), see the native section: eight threads on this shared, loaded 14-core machine is where our spinning barriers suffer.

In short:

- **Natively, phonon-wasm loses, clearly.** Gradium's `ptts` built with its own flags (KleidiAI SME2 kernels for q8, Apple Accelerate for f32, `target-cpu=native`) is 3.5× faster than our `phonon` CLI on one thread with quantized weights (RTF 0.020 against 0.070) and 10× faster in f32 (0.025 against 0.265). At four threads the gap closes to 20% (0.018 against 0.022); at eight our CLI gets slower, theirs does not. Our CLI wins only on first audio at four or more threads (5 ms against 15 ms), on load time in q7 (70 ms against 50 ms is a loss, but our bundle is 46 MB against 65 MB), and on memory (142 MB against 290–320 MB).
- **In the browser on the CPU, phonon-wasm wins at every thread count**, by 1.3× on one thread (RTF 0.098 against 0.129) and 2.4× on eight (0.022 against 0.053), with first audio 4–21 ms against 12–26 ms, a 30% smaller download, a faster cold load and less memory. The thread counts are real on both sides (parallelism 7.5 and 7.6 at eight). In f32 the picture flips on one thread: their f32 kernels are 1.6× faster than ours (0.150 against 0.242); at eight threads ours is 20% faster.
- **phonon-tts's WebGPU backend ties our best CPU row**: RTF 0.024 on the Apple GPU against 0.022 for our eight CPU threads in the headless shell, and ahead of our 0.032 in the same Google Chrome. It needs no cross-origin isolation and no threads, and it loads in 465 ms. We have no GPU backend.
- Without worker threads, both runtimes in the browser are about 8–10× faster than real time with quantized weights; with eight threads, 20–45×. Both runtimes' output transcribed with WER 0 in every configuration (149 WAVs).

## The machine

| | |
|---|---|
| Computer | Apple M4 Pro, 14 cores (10 performance, 4 efficiency), 24 GB; SME2 present (`hw.optional.arm.FEAT_SME2: 1`) |
| OS | macOS 27.0.1 (Darwin 27.0.0) |
| phonon-wasm | `phonon` 0.1.0, release build, Rust 1.99.0, against fusor-ai at commit 42856a6 (a local checkout with 21 uncommitted changes), the q7 bundle `dist/model` (46.1 MB) and an f32 bundle compiled from the same checkpoint; wasm builds in `app/engine/dist` (2.4–2.5 MB each) |
| xn-ptts | commit 6f42148 (2026-10-20, `ptts` 0.4.0), built here with `cargo build --release --locked -p ptts --features cli,accelerate,kai,metal` and the repository's own `.cargo/config.toml` (`-C target-cpu=native`); the build log confirms the KleidiAI kernels compiled (`cargo:rustc-cfg=xn_kai`). The clone found on this machine had that config file deleted and a binary of unknown flags; both were replaced. |
| phonon-tts | npm 0.4.0 (the latest), the package's own builds: `wasm/` and `wasm-threads/`, relaxed-SIMD by default (`phonon_tts_bg.wasm`) or SIMD128 (`phonon_tts_simd_bg.wasm`) |
| Checkpoint | `gradium/phonon-31m-en` at revision 52433c4 (`scripts/fetch-checkpoint.sh`): `model.safetensors` (f32, 102.8 MB), `model.q8.gguf` (64.5 MB), `model.q4k.gguf` (55.1 MB, downloaded for this), `default-voice.safetensors`; the same files for both runtimes |
| Browser | Chrome headless shell 156.0.8078.4 (Playwright 1.64.1) for the CPU rows; Google Chrome 155.0.8059.85 (`--channel chrome`, new headless) for WebGPU, which the headless shell has no GPU for; Node 22.16.0 |
| Pocket TTS | pocket-tts 4.0.0, torch 2.14.1, Python 3.12, the package's default English model (`kyutai/pocket-tts`, 109.5M parameters), default voice |
| Kokoro.js | kokoro-js 1.2.1 (transformers.js, onnxruntime-web, wasm backend), `onnx-community/Kokoro-82M-v1.0-ONNX`, voice `af_heart` |
| ASR | faster-whisper 1.2.1, model `small`, int8 (`scripts/asr_check.py`) |

The machine was in use by other processes throughout (load average 6–9 on 14 cores). Every benchmark ran one at a time under `nice -n 19`, and the 1-minute load average is recorded next to every measurement in the raw data. No row was taken above a load average of 9.

## What was measured, and the same way on both sides

- **RTF** and **generation time**: wall time from the request to the last audio arriving, over audio duration. Natively, each CLI's own report (`phonon synth` prints it; `ptts` logs `generated Xs in Ys`); both count from the start of generation to the end of it. In the browser, the one page `benchmarks/symmetric/` drives either engine and times it from the main thread's clock, from posting the request to the engine reporting done, every chunk received. Ours is the app's own engine worker (`app/engine/worker.js`, as the page uses it); theirs is `PhononTTS.load` / `tts.stream` from the npm package.
- **First audio**: request to the first non-empty PCM frame. Natively: `phonon synth`'s `first audio` and `ptts`'s `first chunk`, both measured inside the process from the start of generation. In the browser: the first PCM message reaching the main thread (ours: the engine's first `pcm` message on the port the audio worklet would hold; theirs: the first `Float32Array` from the stream). Neither includes audio output latency, which the app's page adds (14–21 ms from click to the worklet's output on this machine, per its README).
- **Load**: natively, from the start of reading the files to a ready model (`phonon`'s `loaded ... in`; `ptts`'s `loading model` → `model loaded` log timestamps), files in the OS cache. In the browser: `PhononTTS.load` or our worker's `load` → `ready`, from localhost; **cold** in a fresh profile with no cache, **warm** on reloading the same profile (our OPFS part cache; their Cache API).
- **Threads**: `--threads N` natively (both default differently: ours to min(8, cores − 2) = 8, theirs to one per logical core = 14; both were pinned). In the browser, `threads: N` to phonon-tts and `?threads=N` to our page. The two count differently: ours starts N compute workers beside the engine worker (which does not compute, parallelism 2.9 at N = 3), theirs N − 1 workers plus the owner thread, which does compute. The measured parallelism (CPU time of every process of the browser over the wall time of a 53 s synthesis) shows both get N: 1.0 / 2.9 / 3.8 / 7.5 for ours, 1.0 / 3.0 / 4.0 / 7.6 for theirs, at 1 / 3 / 4 / 8. Natively, `ptts` at `--threads 1` used 1.7 cores (its decoder runs pipelined on a second thread) and 5.3 at 8; `phonon` 1.0 and 7.3.
- **Equivalence**: both normalize the text (ours mirrors their frontend; `ptts --lang en`, `lang: 'en'`), use the same voice embedding, temperature and seed. The audio differs by one frame: 72 / 70 / 80 frames (ours) against 71 / 71 / 79 (theirs) for S1 / S2 / S3 in the browser; 73 / 70 / 79 against 70 / 71 / 81 natively (the native and wasm kernels round differently, so our native q7 gives 73 frames for S1 where the wasm build gives 72; phonon-tts's SIMD128 build gives 69 where its relaxed build gives 71). RTF and ms per frame normalize this; generation times do not.
- **WER**: `benchmarks/asr.sh` transcribes the first measured WAV of every configuration and sentence (149 files) with faster-whisper small int8 and scores it against the input with `scripts/asr_check.py`. Every one scored 0.

## Native CLIs

`benchmarks/native.sh`: every run through `nice -n 19 /usr/bin/time -l`, which gives the peak RSS and CPU time. Load is from the files in the OS cache (there is no cold-cache measurement natively; `purge` needs root).

| Runtime | Weights | Threads | Sentence | Frames | Audio | RTF | ms / frame | First audio | Load | Peak RSS | Parallelism | Load avg. |
|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| phonon | q7 | 1 | S1 / S2 / S3 | 73 / 70 / 79 | 5.84 / 5.60 / 6.32 s | 0.070 / 0.070 / 0.071 | 5.6 / 5.6 / 5.7 | 15 / 14 / 18 ms | 0.07 s | 142 MB | 1.00 | 6.4–6.6 |
| phonon | q7 | 3 | S1 / S2 / S3 | 73 / 70 / 79 | | 0.028 / 0.029 (0.027) / 0.029 | 2.2 / 2.3 / 2.3 | 7 / 7 / 9 ms | 0.05 s | 144 MB | 2.90 | 6.5 |
| phonon | q7 | 4 | S1 / S2 / S3 | 73 / 70 / 79 | | 0.022 / 0.022 / 0.022 | 1.8 / 1.8 / 1.8 | 5 / 5 / 6 ms | 0.04 s | 143 MB | 3.84 | 6.9 |
| phonon | q7 | 8 | S1 / S2 / S3 | 73 / 70 / 79 | | 0.040 (0.038) / 0.032 (0.018) / 0.032 (0.024) | 3.2 / 2.6 / 2.6 | 8 / 7 / 8 ms | 0.05 s | 148 MB | 7.25 | 7.0 |
| ptts | q8 | 1 | S1 / S2 / S3 | 70 / 71 / 81 | 5.60 / 5.68 / 6.48 s | 0.020 / 0.021 / 0.021 | 1.6 / 1.7 / 1.7 | 15 / 14 / 16 ms | 0.05 s | 290–316 MB | 1.74 | 8.9 |
| ptts | q8 | 3 | S1 / S2 / S3 | 70 / 71 / 81 | | 0.019 / 0.018 / 0.018 | 1.6 / 1.4 / 1.5 | 15 / 14 / 15 ms | 0.05 s | 305 MB | 2.75 | 8.6–8.9 |
| ptts | q8 | 4 | S1 / S2 / S3 | 70 / 71 / 81 | | 0.018 / 0.017 / 0.018 | 1.4 / 1.4 / 1.4 | 15 / 13 / 15 ms | 0.05 s | 302–315 MB | 3.69 | 8.6 |
| ptts | q8 | 8 | S1 / S2 / S3 | 70 / 71 / 81 | | 0.019 / 0.019 / 0.020 | 1.6 / 1.6 / 1.6 | 14 / 15 / 16 ms | 0.05 s | 291–320 MB | 5.27 | 8.7 |
| ptts | q4k | 1 | S1 / S2 / S3 | 70 / 70 / 80 | 5.60 / 5.60 / 6.40 s | 0.033 / 0.033 / 0.032 | 2.7 / 2.6 / 2.5 | 76 / 76 / 81 ms | 0.02 s | 287–297 MB | 1.91 | 8.4 |
| ptts | q4k | 3 | S1 / S2 / S3 | 70 / 70 / 80 | | 0.023 / 0.023 / 0.024 | 1.9 / 1.9 / 1.9 | 40 / 40 / 44 ms | 0.02 s | 291–325 MB | 3.33 | 8.0 |
| ptts | q4k | 4 | S1 / S2 / S3 | 70 / 70 / 80 | | 0.022 / 0.021 / 0.021 | 1.7 / 1.7 / 1.8 | 32 / 32 / 34 ms | 0.02 s | 279–299 MB | 3.73 | 8.0 |
| ptts | q4k | 8 | S1 / S2 / S3 | 70 / 70 / 80 | | 0.024 / 0.027 (0.024) / 0.024 | 1.9 / 2.1 / 1.9 | 39 / 39 / 39 ms | 0.02 s | 276–297 MB | 6.20 | 8.0 |
| phonon | f32 | 1 | S1 / S2 / S3 | 72 / 70 / 81 | 5.76 / 5.60 / 6.48 s | 0.265 / 0.268 / 0.271 | 21.2 / 21.4 / 21.6 | 61 / 62 / 76 ms | 0.24 s | 263 MB | 0.99 | 6.9–8.5 |
| phonon | f32 | 3 | S1 / S2 / S3 | 72 / 70 / 81 | | 0.093 / 0.095 / 0.100 (0.096) | 7.5 / 7.6 / 8.0 | 23 / 22 / 28 ms | 0.15 s | 265 MB | 2.88 | 7.9–8.2 |
| phonon | f32 | 4 | S1 / S2 / S3 | 72 / 70 / 81 | | 0.070 / 0.073 (0.070) / 0.070 | 5.6 / 5.8 / 5.6 | 17 / 16 / 20 ms | 0.14 s | 264 MB | 3.90 | 7.9–8.4 |
| phonon | f32 | 8 | S1 / S2 / S3 | 72 / 70 / 81 | | 0.062 (0.053) / 0.066 (0.058) / 0.056 (0.053) | 4.9 / 5.3 / 4.5 | 14 / 14 / 20 ms | 0.13 s | 267 MB | 7.62 | 8.6–9.0 |
| ptts | f32 | 1 | S1 / S2 / S3 | 71 / 71 / 82 | 5.68 / 5.68 / 6.56 s | 0.025 / 0.025 / 0.026 | 2.0 / 2.0 / 2.1 | 20 / 19 / 21 ms | 0.02 s | 292 MB | 1.56 | 7.9 |
| ptts | f32 | 3 | S1 / S2 / S3 | 71 / 71 / 82 | | 0.024 / 0.025 / 0.025 | 1.8 / 2.0 / 2.1 | 17 / 17 / 19 ms | 0.02 s | 292 MB | 3.04 | 7.6 |
| ptts | f32 | 4 | S1 / S2 / S3 | 71 / 71 / 82 | | 0.024 / 0.024 / 0.025 | 2.0 / 2.0 / 2.0 | 18 / 17 / 18 ms | 0.02 s | 292 MB | 3.25 | 8.0 |
| ptts | f32 | 8 | S1 / S2 / S3 | 71 / 71 / 82 | | 0.031 (0.026) / 0.029 (0.026) / 0.029 (0.027) | 2.4 / 2.3 / 2.3 | 22 / 19 / 20 ms | 0.02 s | 292 MB | 4.62 | 8.5 |
| ptts, Metal | f32 | – | S1 / S2 / S3 | 70 / 69 / 78 | 5.60 / 5.52 / 6.24 s | 0.047 (0.042) / 0.048 (0.045) / 0.046 (0.039) | 3.7 / 3.8 / 3.7 | 25 (15) / 20 (15) / 16 ms | 0.03 s | 250 MB | 0.27 | 8.3 |

Where one number is given per sentence, the minimum was within 0.001 of the median.

What this says: `ptts` with q8 weights computes a frame in 1.4–1.7 ms on any number of threads from one to eight; it is nearly flat because its q8 matmuls go through KleidiAI's SME2 kernels, which saturate the chip's matrix unit from a single thread (its 1-thread run already used 1.7 cores, the Mimi decoder being pipelined on a second thread). `phonon` scales almost linearly to four threads (5.6 → 1.8 ms) and reaches the same 1.8 ms there, but its one-thread cost is 3.5× theirs, and at eight threads it got slower (3.2 ms median, 1.5 ms minimum): with the machine's load average at 7 on 14 cores, eight spinning worker threads keep landing on busy or efficiency cores, and our barriers wait for the slowest. `ptts` degrades much less at eight (1.6 ms). In f32 the difference is Apple's Accelerate framework, which `ptts` links and which runs the f32 matmuls on the AMX/SME unit: 2.0 ms per frame on one thread against our 21 ms; our f32 kernels are plain NEON. `ptts`'s q4k weights are slower than its q8 (2.6 against 1.6 ms on one thread) and have a much longer first audio (76 ms against 15 ms: the prompt runs on q4k kernels without the SME2 path); on Metal, the GPU round trips make it slower than its CPU (3.7 ms per frame), as Gradium's own CLI guide warns.

### Per-stage cost of a frame (`phonon bench`, this repository only)

Each stage timed in isolation on sentence S1's prompt (27 tokens).

| ms per frame | q7, 1 thread | q7, 4 threads | q7, 8 threads | f32, 8 threads |
|---|---:|---:|---:|---:|
| flow (one step) | 0.69 | 0.30 | 0.27 | 0.82 |
| Mimi decode | 4.50 | 1.38 | 1.35 | 2.49 |
| **frame** | **5.19 (RTF 0.065)** | **1.68 (RTF 0.021)** | **1.62 (RTF 0.020)** | **3.31 (RTF 0.041)** |
| voice + text prompt | 8.78 per chunk | 2.69 | 2.80 | 11.24 |

The Mimi decoder is 85% of a frame; that is where `ptts`'s advantage is. `phonon bench` at eight threads (1.62 ms, repeated calls in a tight loop) is better than `phonon synth`'s eight-thread median (2.6–3.2 ms) because the loop keeps the pool hot; `synth` measures what a user gets.

## WebAssembly in Chrome

`benchmarks/browser.mjs` through `benchmarks/symmetric/`: a fresh Chrome profile per thread count (cold load), one warm-up, each sentence three times, one long synthesis for the parallelism check, the browser's memory, then a reload (warm load). CPU rows in Playwright's headless shell 156, cross-origin isolated (served by fusor-ai's `serve.mjs` with COOP/COEP).

| Runtime | Weights | Threads | Sentence | Frames | Audio | RTF | ms / frame (engine) | First audio | Cold / warm load | Download | Memory | WER | Load avg. |
|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| phonon-wasm `web-single-relaxed` | q7 | 1 | S1 / S2 / S3 | 72 / 70 / 80 | 5.76 / 5.60 / 6.40 s | 0.098 / 0.098 / 0.100 | 7.8 / 7.8 / 7.9 | 21 / 19 / 25 ms | 221 / 173 ms | 48.5 MB | 397 MB | 0 / 0 / 0 | 6.2 |
| phonon-tts, relaxed SIMD | q8 | 1 | S1 / S2 / S3 | 71 / 71 / 79 | 5.68 / 5.68 / 6.32 s | 0.129 (0.125) / 0.124 / 0.124 | 10.0 / 9.7 / 9.6 | 26 / 25 / 30 ms | 348 / 174 ms | 69.4 MB | 673 MB | 0 / 0 / 0 | 7.3 |
| phonon-wasm `web-threaded-relaxed` | q7 | 3 | S1 / S2 / S3 | 72 / 70 / 80 | | 0.038 / 0.038 / 0.039 (0.037) | 3.0 / 3.0 / 3.0 | 8 / 8 / 10 ms | 216 / 120 ms | 48.6 MB | 491 MB | 0 / 0 / 0 | 6.6 |
| phonon-tts, relaxed SIMD | q8 | 3 | S1 / S2 / S3 | 71 / 71 / 79 | | 0.063 / 0.062 / 0.063 | 4.9 / 4.9 / 4.9 | 13 / 12 / 15 ms | 318 / 167 ms | 69.5 MB | 682 MB | 0 / 0 / 0 | 7.4 |
| phonon-wasm `web-threaded-relaxed` | q7 | 4 | S1 / S2 / S3 | 72 / 70 / 80 | | 0.031 / 0.032 (0.031) / 0.035 (0.033) | 2.4 / 2.5 / 2.7 | 6 / 6 / 8 ms | 197 / 104 ms | 48.6 MB | 566 MB | 0 / 0 / 0 | 6.4 |
| phonon-tts, relaxed SIMD | q8 | 4 | S1 / S2 / S3 | 71 / 71 / 79 | | 0.053 / 0.053 / 0.053 | 4.1 / 4.1 / 4.1 | 11 / 10 / 13 ms | 273 / 159 ms | 69.5 MB | 681 MB | 0 / 0 / 0 | 7.5 |
| phonon-wasm `web-threaded-relaxed` | q7 | 8 | S1 / S2 / S3 | 72 / 70 / 80 | | 0.022 / 0.033 (0.025) / 0.026 (0.022) | 1.7 / 2.6 / 2.1 | 4 / 6 (4) / 6 (5) ms | 203 / 100 ms | 48.6 MB | 582 MB | 0 / 0 / 0 | 7.0 |
| phonon-tts, relaxed SIMD | q8 | 8 | S1 / S2 / S3 | 71 / 71 / 79 | | 0.053 (0.048) / 0.051 / 0.047 | 4.1 / 3.9 / 3.6 | 12 / 11 / 11 ms | 310 / 144 ms | 69.5 MB | 721 MB | 0 / 0 / 0 | 7.5–8.2 |
| phonon-wasm `web-single` (SIMD128) | q7 | 1 | S1 / S2 / S3 | 73 / 70 / 81 | 5.84 / 5.60 / 6.48 s | 0.150 / 0.148 / 0.149 | 11.9 / 11.8 / 11.9 | 33 / 31 / 40 ms | 285 / 212 ms | 48.5 MB | 394 MB | 0 / 0 / 0 | 7.6–8.0 |
| phonon-tts, SIMD128 | q8 | 1 | S1 / S2 / S3 | 69 / 71 / 82 | 5.52 / 5.68 / 6.56 s | 0.186 / 0.184 / 0.187 | 14.3 / 14.3 / 14.3 | 50 / 46 / 60 ms | 434 / 252 ms | 69.4 MB | 656 MB | 0 / 0 / 0 | 8.1 |
| phonon-wasm `web-threaded` (SIMD128) | q7 | 8 | S1 / S2 / S3 | 73 / 70 / 81 | | 0.038 (0.031) / 0.033 (0.030) / 0.032 | 3.0 / 2.6 / 2.5 | 6 / 6 / 7 ms | 230 / 121 ms | 48.7 MB | 544 MB | 0 / 0 / 0 | 7.6–8.1 |
| phonon-tts, SIMD128 | q8 | 8 | S1 / S2 / S3 | 69 / 71 / 82 | | 0.057 / 0.061 (0.058) / 0.062 (0.056) | 4.4 / 4.7 / 4.8 | 14 / 13 / 16 ms | 333 / 167 ms | 69.4 MB | 711 MB | 0 / 0 / 0 | 8.2–8.4 |
| phonon-wasm `web-single-relaxed` | f32 | 1 | S1 / S2 / S3 | 72 / 70 / 81 | 5.76 / 5.60 / 6.48 s | 0.242 / 0.243 / 0.245 | 19.3 / 19.4 / 19.5 | 54 / 52 / 65 ms | 424 / 318 ms | 164.4 MB | 686 MB | 0 / 0 / 0 | 7.7–8.3 |
| phonon-tts, relaxed SIMD | f32 | 1 | S1 / S2 / S3 | 71 / 71 / 82 | 5.68 / 5.68 / 6.56 s | 0.150 / 0.151 (0.148) / 0.151 | 11.7 / 11.8 / 11.8 | 29 / 27 / 33 ms | 437 / 190 ms | 107.7 MB | 704 MB | 0 / 0 / 0 | 8.3 |
| phonon-wasm `web-threaded-relaxed` | f32 | 8 | S1 / S2 / S3 | 72 / 70 / 81 | | 0.044 / 0.045 / 0.046 (0.044) | 3.5 / 3.5 / 3.6 | 11 (8) / 8 / 13 ms | 369 / 220 ms | 164.5 MB | 721 MB | 0 / 0 / 0 | 8.0 |
| phonon-tts, relaxed SIMD | f32 | 8 | S1 / S2 / S3 | 71 / 71 / 82 | | 0.055 / 0.054 (0.052) / 0.054 | 4.3 / 4.2 / 4.3 | 8 / 8 / 10 ms | 417 / 182 ms | 107.8 MB | 783 MB | 0 / 0 / 0 | 7.6 |

Google Chrome 155, new headless mode, `--channel chrome` (`benchmarks/out/browser-chrome/`): the only way to a WebGPU adapter here. Chrome's memory baseline is a GPU process and more helpers, about 1.1 GB on its own.

| Runtime | Weights | Device | Sentence | Frames | RTF | ms / frame (engine) | First audio | Cold / warm load | Memory | Parallelism | WER |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| phonon-tts, `device: 'webgpu'` | q8 | Apple M4 Pro GPU | S1 / S2 / S3 | 71 / 71 / 82 | 0.024 / 0.023 / 0.024 | 1.9 / 1.9 / 1.9 | 15 / 14 / 14 ms | 465 / 192 ms | 1178 MB | 1.28 (CPU) | 0 / 0 / 0 |
| phonon-wasm `web-threaded-relaxed` | q7 | CPU, 8 threads | S1 | 72 | 0.032 (0.026) | 2.5 (2.0) | 8 (4) ms | 229 / 127 ms | 1244 MB | 7.52 | 0 |
| phonon-tts, relaxed SIMD | q8 | CPU, 8 threads | S1 | 71 | 0.050 (0.050) | 3.9 | 10 ms | 317 / 156 ms | 1398 MB | 7.66 | 0 |

The Chrome CPU control rows are within noise of the headless shell's (0.050 against 0.053 for theirs; 0.032 median but 0.026 minimum against 0.022 for ours, the eight-thread spread again). On WebGPU, phonon-tts's per-frame time (1.9 ms) is within 10% of our eight-thread CPU time in the headless shell (1.7 ms) and better than our eight threads in the same Chrome (2.0–2.5 ms), with a longer first audio (14 ms against 4–8: the GPU generates several frames per round trip) and about 1.3 cores of CPU used while it runs.

Relaxed SIMD is worth 1.5× over plain SIMD128 for both runtimes on one thread (ours 0.098 against 0.150, theirs 0.124 against 0.186). Worker threads are worth 4.5× for ours at eight (0.098 → 0.022) and 2.4× for theirs (0.124 → 0.051): phonon-tts's threaded builds stop scaling past four threads here (4.1 ms per frame at four, 3.6–4.1 at eight) while ours keeps scaling to eight (2.4 → 1.7 ms).

**Load and download.** From localhost with no cache, our page's engine is ready in 200–290 ms (46.1 MB bundle, verified by BLAKE3, written to OPFS) and phonon-tts's `load` in 270–350 ms (65 MB, written to the Cache API); on the revisit, 100–180 ms for ours (from OPFS) and 145–175 ms for theirs (from the Cache API). The f32 bundles are 164 MB (ours, every tensor f32) and 108 MB (theirs: its `model.safetensors` is 103 MB, so our f32 bundle is 60% bigger than the checkpoint it was compiled from, while the q7 bundle is 28% smaller than their q8 GGUF).

## WebAssembly in Node, one thread

`benchmarks/node.mjs`: both runtimes through the same loop (ours through the glue in `app/engine/dist`, theirs through the package's raw wasm-bindgen API as its worker drives it). Load is from the files on disk to a ready model.

| Runtime | Build | Weights | Sentence | Load | Frames | RTF | ms / frame | First audio | WER |
|---|---|---|---|---:|---:|---:|---:|---:|---:|
| phonon-wasm | `web-single-relaxed` | q7 | S1 / S2 / S3 | 0.15 s | 72 / 70 / 80 | 0.098 / 0.097 / 0.098 | 7.8 / 7.8 / 7.8 | 20 / 19 / 25 ms | 0 / 0 / 0 |
| phonon-tts | relaxed SIMD | q8 | S1 / S2 / S3 | 0.27 s | 71 / 71 / 79 | 0.123 / 0.124 / 0.123 | 9.8 / 9.9 / 9.8 | 25 / 24 / 30 ms | 0 / 0 / 0 |
| phonon-wasm | `web-single` (SIMD128) | q7 | S1 / S2 / S3 | 0.19 s | 73 / 70 / 81 | 0.149 / 0.152 / 0.152 | 11.9 / 12.2 / 12.2 | 32 / 31 / 40 ms | 0 / 0 / 0 |
| phonon-tts | SIMD128 | q8 | S1 / S2 / S3 | 0.24 s | 69 / 71 / 82 | 0.185 / 0.184 / 0.185 | 14.8 / 14.7 / 14.8 | 50 / 46 / 60 ms | 0 / 0 / 0 |
| phonon-wasm | `web-single-relaxed` | f32 | S1 / S2 / S3 | 0.31 s | 72 / 70 / 81 | 0.250 / 0.249 / 0.251 | 20.0 / 20.0 / 20.1 | 56 / 53 / 67 ms | 0 / 0 / 0 |
| phonon-tts | relaxed SIMD | f32 | S1 / S2 / S3 | 0.29 s | 71 / 71 / 82 | 0.148 / 0.148 / 0.149 | 11.9 / 11.8 / 12.0 | 28 / 27 / 32 ms | 0 / 0 / 0 |

Node's V8 is the same engine as Chrome's, and the figures are within 2% of the browser's single-threaded rows.

## Pocket TTS, PyTorch, for scale (a different model)

`benchmarks/pocket_bench.py`: the `pocket-tts` 4.0.0 package on its own default English model (109.5M parameters, d_model 1024 against Phonon 31M's 512), through `generate_audio_stream`, default voice, temperature 0.3. It **cannot load Phonon 31M's weights**: Phonon's checkpoint carries `num_speakers` and `duration_delta` conditioners and a different tokenizer that Pocket TTS's loader has no configuration for, so this is the ancestor model, not another runtime of ours. The package pins `torch.set_num_threads(1)` at import; the 4- and 8-thread rows override that after the import and gain nothing. Its seed is not exposed, so the frame counts differ per run.

| Torch threads | Sentence | Frames | Audio | RTF | ms / frame | First audio | Load | Peak RSS | WER | Load avg. |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 (as shipped) | S1 / S2 / S3 | 56 / 68 / 75 | 4.5 / 5.4 / 6.0 s | 0.076 / 0.076 / 0.082 | 6.1 / 6.1 / 6.5 | 24 / 26 / 27 ms | 0.77 s | 1006 MB | 0 / 0 / 0 | 7.1 |
| 4 | S1 / S2 / S3 | 62 / 61 / 74 | 5.0 / 4.9 / 5.9 s | 0.080 (0.078) / 0.093 (0.077) / 0.076 | 6.4 / 7.4 / 6.0 | 26 / 26 / 25 ms | 0.36 s | 1043 MB | 0 / 0 / 0 | 7.3–7.5 |
| 8 | S1 / S2 / S3 | 64 / 65 / 74 | 5.1 / 5.2 / 5.9 s | 0.078 / 0.077 / 0.077 | 6.3 / 6.2 / 6.2 | 25 / 25 / 26 ms | 0.40 s | 1043 MB | 0 / 0 / 0 | 7.1–7.3 |

Eager PyTorch on one CPU thread runs this 3.5× larger model at RTF 0.076, about the same per-frame time as our native q7 CLI on one thread (5.6 ms against 6.1 ms) and 3.8× slower than `ptts` q8. Pocket TTS's README lists further community ports (ONNX Runtime Web, Candle, jax-js, sherpa-onnx, MLX); they all run Pocket TTS's own models, not Phonon's, and were skipped (see Caveats).

## Kokoro.js, for scale (a different model)

`benchmarks/kokoro.mjs`: kokoro-js 1.2.1 from jsdelivr, the model from Hugging Face on every run, onnxruntime-web's wasm backend with its default thread count, voice `af_heart`, in the headless shell.

| Precision | Sentence | Audio | Generation | RTF | Load (from the network) | Memory | WER |
|---|---|---:|---:|---:|---:|---:|---:|
| fp32 | S1 / S2 / S3 | 6.5 / 6.3 / 7.3 s | 2.62 / 2.50 / 2.89 s | 0.405 / 0.397 / 0.399 | 11.7 s | 1265 MB | 0 / 0 / 0 |
| q8 | S1 / S2 / S3 | 6.5 / 6.3 / 7.2 s | 4.69 / 4.57 / 5.19 s | 0.719 / 0.729 / 0.718 | 4.7 s | 649 MB | 0 / 0 / 0 |

Kokoro produces a whole sentence at once, so its first audio is its total time (2.5–2.9 s in fp32). Both Phonon runtimes in the same browser are 4–30× faster than it and start playing within 30 ms.

## Where phonon-wasm loses or ties

- **Native CLI, every quantized row**: `ptts` q8 is 3.5× faster on one thread (RTF 0.020 against 0.070), 1.5× at three, 1.2× at four, and 2× at eight, where our CLI gets slower on this loaded machine. Our CLI matches it only in per-frame time at four threads in `phonon bench`'s hot loop (1.68 against 1.43 ms). Its q4k is as fast as our q7 at four threads.
- **Native CLI, f32**: 10× slower on one thread (0.265 against 0.025), 2× at eight. Their f32 path is Accelerate; ours is NEON.
- **Native load time**: 70 ms against 50 ms for quantized weights (ours hashes every part with BLAKE3), 240 ms against 20 ms for f32 (162 MB read and hashed; `ptts` reads its 103 MB safetensors in 20 ms).
- **Native first audio on one thread**: a tie at 15 ms.
- **Browser, f32, one thread**: 1.6× slower (0.242 against 0.150) with a 50% larger download (164 against 108 MB) and a slower warm load (318 against 190 ms).
- **Browser, f32 first audio at eight threads**: 11 ms against 8 ms.
- **WebGPU**: phonon-tts on the GPU (RTF 0.024, no threads, no cross-origin isolation needed) ties our best CPU row (0.022 in the headless shell) and beats us in the same Google Chrome (0.032 median, 0.026 minimum). We have no GPU backend, so a page that cannot be cross-origin isolated gets our 0.098 against their 0.024.
- **Eight threads is noisy for us.** In every eight-thread row ours has a wider spread than theirs (native S2: median 0.032, minimum 0.018; Chrome: median 0.032, minimum 0.026). Their runtime's eight-thread rows are flat. On an idle machine the minimum is the better guide; on a busy one, four threads is our safer setting natively.
- **Warm load in the browser** is close: 100–173 ms for ours against 144–175 ms for theirs.

Where it wins: every browser CPU row with quantized weights (1.3× on one thread to 2.4× on eight), first audio in the browser (4–21 ms against 11–26), download (48.5 against 69.4 MB), cold load (200–290 against 270–350 ms), memory (397–582 against 673–721 MB including Chrome), f32 in the browser at eight threads (0.044 against 0.055), native memory (142 against 300 MB) and native first audio from three threads up (5–8 ms against 14–16).

## Audit of the existing harness (`benchmarks/head-to-head.mjs`)

The harness our implementer wrote (and the README's table) measures ours through the app's page and theirs through `benchmarks/reference/`. Read for bias before this work:

- No bias in its favour was found in what it measures: same text, voice, temperature (0.3) and seed (both defaults), one warm-up and medians of three for both, their relaxed-SIMD build chosen (as their package does by itself), RTF defined the same way on both sides (request to the last audio on the main thread), engine first audio as each engine reports it.
- Two of its columns are not like for like and the README says so: its page first audio is click → worklet output for ours but stream call → first chunk for theirs (no playback), and its load is page open → ready for ours but the `load` call alone for theirs. This document replaces both with one definition through `benchmarks/symmetric/`.
- It did not check that `threads=N` meant the same thing on both sides. It does not: ours starts N compute workers, theirs N − 1 plus the owner. Measured parallelism shows both get N cores, so the numbers stand; the check is now part of `browser.mjs`.
- Its defaults cover 1, 3 and 8 threads but not 4, and it reports no WER, memory or load average. Nothing in it was changed; the new scripts cover these.
- **A bug in this work's own harness, for the record:** the first run of `browser.mjs` hung at the first threaded configuration (`phonon-wasm`, 3 threads) for 32 minutes, until it was killed. The cause was the harness, not the runtime: our threaded builds ask the page for their compute workers with fusor-ai's `SPAWN_COMPUTE` message (`app/web/app.js` answers it with `ComputePool`), and `symmetric.js` had no handler, so the engine waited for a pool that never came. With the handler, every threaded row loaded in about 200 ms and ran; the runtime neither hung nor crashed in any browser run that followed (19 configurations, 3 runs per sentence plus warm-ups and a 53 s synthesis each).

## Caveats

- **One machine, shared and busy.** A single Apple M4 Pro that other processes were using throughout (load average 6–9 on 14 cores). Medians of three with the minimum beside them; the minimum is the better estimate of an idle machine. The eight-thread rows are the most affected, ours more than theirs. Different CPUs will give different absolute numbers, and in particular `ptts`'s native advantage comes from SME2 and Accelerate, which an Intel or older Arm CPU does not have.
- **q7 against q8 is not the same arithmetic.** Our bundle stores weights in 7 bits, theirs in 8 (Q8_0 blocks). Both transcribe with WER 0 on these sentences; this document does not measure audio quality beyond that, and parity with the reference is `just parity`'s job (f32 bundle, per the README).
- **`ptts`'s "1 thread" uses 1.7 cores natively.** Its `--threads` sets the tensor-op threads; its decoder is pipelined on another thread. Our `--threads 1` uses one core. The per-frame comparison at one thread is therefore a little generous to `ptts`; at four threads both use about 3.7–3.8 cores and the comparison is even.
- **Different browsers for the GPU row.** WebGPU needed Google Chrome 155's new headless mode; the CPU rows are in Playwright's headless shell 156. Control rows for both runtimes on the CPU in Chrome are within noise of the shell's, except our eight-thread median (0.032 against 0.022; minimum 0.026).
- **Load times are warm and local.** Files in the OS cache for native; localhost for the browser, where a real first visit is the download. Cold-cache native loads were not measured (`purge` needs root).
- **Slightly different audio lengths.** The two runtimes differ by one frame on the same input (72 against 71 frames for S1 in the browser); our native and wasm builds differ by one too. RTF and ms per frame normalize this.
- **Pocket TTS and Kokoro are different models**, 3.5× and 2.6× larger, in other runtimes (eager PyTorch; onnxruntime-web). Their rows are there for scale only.
- **Skipped**: Pocket TTS's community ports (KevinAHM's ONNX Runtime Web export, babybirdprd's Candle port, ekzhang's jax-js, sherpa-onnx, PocketTTS.cpp, MLX) because all of them run Pocket TTS's own weights, not Phonon's, so they would add nothing a Pocket TTS row does not; and the exported ONNX/Candle models are not published for a quick, pinned setup. xn-ptts's Core ML (Swift/iOS) and QNN (Android) backends need Xcode or an Android device. phonon-tts on WebGPU in the headless shell (no adapter). `ptts`'s q4k in the browser (phonon-tts loads q8 or f32 only).

## How to reproduce

From a checkout with the page built and served (`just build`), the e2e dependencies in `benchmarks/node_modules` (`cd benchmarks && npm ci && npx playwright install chromium`; Google Chrome installed for the WebGPU row), and xn-ptts built at commit 6f42148 with its own flags. The raw outputs of every script (TSV, JSON, WAV) land in `benchmarks/out/`, and `python3 -I benchmarks/summarize.py` prints the median/min tables from them.

```sh
# Gradium's ptts, built as its release workflow builds the Apple silicon archive
git clone https://github.com/gradium-ai/xn-ptts && git -C xn-ptts checkout 6f42148
(cd xn-ptts && cargo build --release --locked -p ptts --features cli,accelerate,kai,metal --bin ptts)
grep -l 'cargo:rustc-cfg=xn_kai' xn-ptts/target/release/build/xn-*/output   # the KleidiAI kernels compiled

# The checkpoint files for both runtimes (scripts/fetch-checkpoint.sh gets all but the q4k GGUF)
scripts/fetch-checkpoint.sh .cache/phonon-31m-en --reference
mkdir ckpt && ln -s "$PWD"/.cache/phonon-31m-en/* ckpt/
curl -Lo ckpt/model.q4k.gguf https://huggingface.co/gradium/phonon-31m-en/resolve/52433c46975bfa13144c56204c9f4ee1c5b148aa/model.q4k.gguf
target/release/phonon compile .cache/phonon-31m-en model-f32 --profile f32

# Native CLIs: both, q7/q8/q4k/f32/Metal, 1/3/4/8 threads, S1–S3, warm-up + 3 (benchmarks/out/native)
PHONON_F32=model-f32 PTTS=xn-ptts/target/release/ptts CKPT=ckpt benchmarks/native.sh
RUNTIMES="phonon-q7 ptts-q8" THREADS="4" SENTENCES="S1" PHONON_F32=... PTTS=... CKPT=... benchmarks/native.sh   # a subset

# Chrome: the whole matrix (benchmarks/out/browser, browser-f32, browser-chrome), or one configuration
MODEL_F32=model-f32 benchmarks/browser-all.sh
node benchmarks/browser.mjs --runtime phonon-wasm --threads 8
node benchmarks/browser.mjs --runtime phonon-tts --threads 8 [--quant f32] [--simd simd128]
node benchmarks/browser.mjs --runtime phonon-tts --device webgpu --threads 1 --channel chrome

# Node, one thread (benchmarks/out/node)
node benchmarks/node.mjs --runtime phonon-wasm --build web-single-relaxed
node benchmarks/node.mjs --runtime phonon-tts --build relaxed

# Pocket TTS (a venv outside any download directory, python -I) and Kokoro.js (needs the network)
uv venv venv-pocket --python 3.12 && uv pip install --python venv-pocket/bin/python pocket-tts==4.0.0
venv-pocket/bin/python -I benchmarks/pocket_bench.py --threads 1
node benchmarks/kokoro.mjs --dtype q8 && node benchmarks/kokoro.mjs --dtype fp32

# Intelligibility of every WAV under benchmarks/out (faster-whisper small int8), then the tables
ASR_PYTHON=<python with faster-whisper> benchmarks/asr.sh
python3 -I benchmarks/summarize.py
```

`benchmarks/head-to-head.mjs` (`just head-to-head`) is the earlier harness through the app's page, kept as is.
