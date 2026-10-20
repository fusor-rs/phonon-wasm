"""Times the PyTorch `pocket-tts` package (kyutai-labs/pocket-tts) on its own English model, a
different and larger model than Phonon 31M (Pocket TTS cannot load Phonon's weights: its
loader has no `num_speakers` / `duration_delta` conditioners). Labelled as such everywhere.

The package pins `torch.set_num_threads(1)` at import; `--threads` overrides that after the
import, so the 1-thread rows are the package as shipped and the others its best case. Streams
through `generate_audio_stream`, so first audio is request → first chunk, as for the others.
Default voice (the package's default for English), temperature as given (the model's default
is 0.3; it has no seed option exposed on the model, so the noise differs per run).

  venv/bin/python -I benchmarks/pocket_bench.py --threads 1 --repeat 3 --out benchmarks/out/pocket
"""

import argparse
import json
import os
import resource
import sys
import time


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--threads", type=int, default=1)
    ap.add_argument("--repeat", type=int, default=3)
    ap.add_argument("--temperature", type=float, default=0.3)
    ap.add_argument("--out", default="benchmarks/out/pocket")
    args = ap.parse_args()
    sentences = {
        "S1": "Please remember to water the plants on Tuesday, and call the dentist about the appointment at three o'clock.",
        "S2": "The evening wind drifted down from the mountain pass, and the distant clouds slowly turned gold.",
        "S3": "Glaciers move slowly, carving valleys over thousands of years while the rivers below carry the silt to the sea.",
    }
    os.makedirs(args.out, exist_ok=True)

    import torch
    from pocket_tts import TTSModel
    from pocket_tts.main import get_default_voice_for_language

    torch.set_num_threads(args.threads)
    t0 = time.perf_counter()
    model = TTSModel.load_model(language="english", temp=args.temperature)
    voice = get_default_voice_for_language("english", None)
    state = model.get_state_for_audio_prompt(voice)
    load_s = time.perf_counter() - t0
    params = sum(p.numel() for p in model.parameters())
    rate = model.sample_rate
    result = {
        "runtime": "pocket-tts", "version": __import__("pocket_tts").__version__ if hasattr(__import__("pocket_tts"), "__version__") else "4.0.0",
        "torch": torch.__version__, "threads": torch.get_num_threads(), "parameters": params, "voice": str(voice), "load_s": round(load_s, 3), "runs": [],
    }
    print(f"loaded in {load_s:.2f} s, {params / 1e6:.1f}M parameters, torch threads {torch.get_num_threads()}", file=sys.stderr)

    def speak(text):
        t = time.perf_counter()
        first = None
        chunks = []
        for chunk in model.generate_audio_stream(state, text):
            first = first if first is not None else time.perf_counter() - t
            chunks.append(chunk.reshape(-1))
        wall = time.perf_counter() - t
        audio = torch.cat(chunks) if chunks else torch.zeros(0)
        return audio, first, wall

    speak("Warm up, warm up, warm up.")
    for key, text in sentences.items():
        for i in range(args.repeat):
            audio, first, wall = speak(text)
            audio_s = audio.numel() / rate
            frames = round(audio_s * 12.5)
            run = {"sentence": key, "run": i, "audio_s": round(audio_s, 3), "frames": frames, "gen_s": round(wall, 4), "rtf": round(wall / audio_s, 4),
                   "ms_per_frame": round(1000 * wall / max(1, frames), 2), "first_audio_ms": round(1000 * first, 1), "load_avg": round(os.getloadavg()[0], 1)}
            result["runs"].append(run)
            print(json.dumps(run), file=sys.stderr)
            if i == 0:
                import scipy.io.wavfile
                scipy.io.wavfile.write(os.path.join(args.out, f"pocket-tts-t{args.threads}-{key}.wav"), rate, audio.numpy())
    result["peak_rss_mb"] = round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e6)
    with open(os.path.join(args.out, f"pocket-tts-t{args.threads}.json"), "w") as f:
        json.dump(result, f, indent=2)


if __name__ == "__main__":
    main()
