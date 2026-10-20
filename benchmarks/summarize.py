"""Prints Markdown tables (median and min over the measured repeats, the load average beside
them) from the files under benchmarks/out/: native/native.tsv and parallelism.tsv (native.sh),
browser*/*.json (browser.mjs), node/node.tsv (node.mjs), pocket/*.json (pocket_bench.py),
kokoro/*.json (kokoro.mjs) and asr.tsv (asr.sh).

  python3 -I benchmarks/summarize.py [benchmarks/out]
"""

import csv
import glob
import json
import os
import statistics
import sys
from collections import defaultdict

out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
THREAD_ORDER = [1, 3, 4, 8]


def med_min(values, digits=2):
    values = [float(v) for v in values if v not in ("", None)]
    if not values:
        return "–"
    return f"{statistics.median(values):.{digits}f} ({min(values):.{digits}f})"


def table(title, header, rows):
    print(f"\n### {title}\n")
    print("| " + " | ".join(header) + " |")
    print("|" + "|".join("---:" if i else "---" for i in range(len(header))) + "|")
    for row in rows:
        print("| " + " | ".join(str(c) for c in row) + " |")


def group(items, key):
    groups = defaultdict(list)
    for item in items:
        groups[key(item)].append(item)
    return groups


wer = {}
asr = os.path.join(out, "asr.tsv")
if os.path.exists(asr):
    for row in csv.DictReader(open(asr), delimiter="\t"):
        wer[row["wav"]] = row["wer"]


def wer_of(prefix):
    """WERs of the WAVs whose path starts with prefix, S1/S2/S3 in order."""
    found = [(k, v) for k, v in wer.items() if k.startswith(prefix)]
    return " / ".join(v for _, v in sorted(found)) if found else "–"


# Native
native = os.path.join(out, "native", "native.tsv")
if os.path.exists(native):
    items = list(csv.DictReader(open(native), delimiter="\t"))
    par = {}
    p = os.path.join(out, "native", "parallelism.tsv")
    if os.path.exists(p):
        for row in csv.DictReader(open(p), delimiter="\t"):
            par[(row["runtime"], int(row["threads"]))] = row
    order = ["phonon-q7", "ptts-q8", "ptts-q4k", "phonon-f32", "ptts-f32", "ptts-metal"]
    rows = []
    for key, runs in sorted(group(items, lambda r: (r["runtime"], int(r["threads"]), r["sentence"])).items(),
                            key=lambda kv: (order.index(kv[0][0]) if kv[0][0] in order else 99, kv[0][1], kv[0][2])):
        runtime, threads, sentence = key
        pr = par.get((runtime, threads))
        rows.append([runtime, threads, sentence, runs[0]["frames"], runs[0]["audio_s"], med_min([r["gen_s"] for r in runs], 3),
                     med_min([r["rtf"] for r in runs], 3), med_min([r["ms_frame"] for r in runs], 2),
                     med_min([r["first_audio_ms"] for r in runs], 0), med_min([r["load_s"] for r in runs], 3),
                     med_min([r["peak_rss_mb"] for r in runs], 0), pr["parallelism"] if pr else "–",
                     wer_of(f"native/{runtime}-t{threads}-{sentence}-0.wav"), med_min([r["loadavg"] for r in runs], 1)])
    table("Native CLIs (native.sh)", ["runtime", "threads", "sentence", "frames", "audio s", "gen s", "RTF", "ms/frame",
                                       "first audio ms", "load s", "peak RSS MB", "parallelism (long run)", "WER", "load avg"], rows)
    if par:
        rows = [[k[0], k[1], v["audio_s"], v["gen_s"], v["cpu_s"], v["parallelism"], v["loadavg"]]
                for k, v in sorted(par.items(), key=lambda kv: (order.index(kv[0][0]) if kv[0][0] in order else 99, kv[0][1]))]
        table("Native parallelism check (one long run, about 53 s of audio)", ["runtime", "threads", "audio s", "gen s", "CPU s", "CPU s / wall s", "load avg"], rows)

# Browser
rows = []
for folder in sorted(glob.glob(os.path.join(out, "browser*"))):
    for path in sorted(glob.glob(os.path.join(folder, "*.json"))):
        s = json.load(open(path))
        if s.get("error"):
            print(f"\n{os.path.basename(folder)}/{s['tag']}: error {s['error'][:160]}")
            continue
        label = s["runtime"] + (f" {s['build']}" if s.get("build") else "") + (f" {s['quant']}" if s["runtime"] == "phonon-tts" or s.get("quant") == "f32" else "") + (f" {s['device']}" if s.get("device") not in (None, "cpu") else "") + (" simd128" if s.get("simd") == "simd128" else "")
        engine = s.get("engine", {})
        actual = engine.get("threads")
        par = s.get("parallelism") or {}
        for sentence, runs in sorted(group(s["runs"], lambda r: r["sentence"]).items()):
            rows.append([os.path.basename(folder), label, f"{s['threads']} ({actual})" if actual != s["threads"] else s["threads"], sentence, runs[0]["frames"], runs[0]["audio_s"],
                         med_min([r["wall_s"] for r in runs], 3), med_min([r["rtf"] for r in runs], 3), med_min([r["step_ms"] for r in runs], 2),
                         med_min([r["page_first_ms"] for r in runs], 0), med_min([r["engine_first_ms"] for r in runs], 0),
                         s.get("coldLoadMs", "–"), s.get("warmLoadMs", "–"), f"{s.get('downloadBytes', 0) / 1e6:.1f}", s.get("rssMb", "–"),
                         par.get("parallelism", "–"), wer_of(f"{os.path.basename(folder)}/{s['tag']}-{sentence}.wav"), med_min([r["loadavg"] for r in runs], 1)])
if rows:
    table("Browser (browser.mjs, one page and one clock for both runtimes)",
          ["set", "runtime", "threads", "sentence", "frames", "audio s", "wall s", "RTF", "ms/frame (engine)", "first audio ms (page)",
           "first audio ms (engine)", "cold load ms", "warm load ms", "download MB", "memory MB", "parallelism", "WER", "load avg"], rows)

# Node
rows = []
for node in sorted(glob.glob(os.path.join(out, "node*", "node.tsv"))):
    folder = os.path.basename(os.path.dirname(node))
    items = list(csv.DictReader(open(node), delimiter="\t"))
    for key, runs in group(items, lambda r: (r["runtime"], r["build"], r["quant"], r["sentence"])).items():
        rows.append([folder, *key, runs[0]["load_s"], runs[0]["frames"], runs[0]["audio_s"], med_min([r["gen_s"] for r in runs], 3),
                     med_min([r["rtf"] for r in runs], 3), med_min([r["ms_frame"] for r in runs], 1), med_min([r["first_audio_ms"] for r in runs], 0),
                     wer_of(f"{folder}/{key[0]}-{key[1]}{'-' + key[2] if key[0] == 'phonon-tts' else ''}-{key[3]}.wav"), med_min([r["loadavg"] for r in runs], 1)])
if rows:
    table("Node, one thread (node.mjs)", ["set", "runtime", "build", "quant", "sentence", "load s", "frames", "audio s", "gen s", "RTF", "ms/frame", "first audio ms", "WER", "load avg"], rows)

# Pocket TTS
rows = []
for path in sorted(glob.glob(os.path.join(out, "pocket", "*.json"))):
    s = json.load(open(path))
    for sentence, runs in sorted(group(s["runs"], lambda r: r["sentence"]).items()):
        rows.append([s["threads"], sentence, runs[0]["frames"], runs[0]["audio_s"], med_min([r["gen_s"] for r in runs], 3), med_min([r["rtf"] for r in runs], 3),
                     med_min([r["ms_per_frame"] for r in runs], 1), med_min([r["first_audio_ms"] for r in runs], 0), s["load_s"], s["peak_rss_mb"],
                     wer_of(f"pocket/pocket-tts-t{s['threads']}-{sentence}.wav"), med_min([r["load_avg"] for r in runs], 1)])
if rows:
    table("Pocket TTS, PyTorch, its own English model (a different model)", ["torch threads", "sentence", "frames", "audio s", "gen s", "RTF", "ms/frame", "first audio ms", "load s", "peak RSS MB", "WER", "load avg"], rows)

# Kokoro
rows = []
for path in sorted(glob.glob(os.path.join(out, "kokoro", "*.json"))):
    s = json.load(open(path))
    if s.get("error"):
        print(f"\nkokoro {s['dtype']}: error {s['error'][:200]}")
        continue
    for sentence, runs in sorted(group(s["runs"], lambda r: r["sentence"]).items()):
        rows.append([s["dtype"], sentence, runs[0]["audio_s"], med_min([r["gen_s"] for r in runs]), med_min([r["rtf"] for r in runs], 3),
                     f"{s['loadMs'] / 1000:.1f}", s.get("rssMb", "–"), wer_of(f"kokoro/kokoro-{s['dtype']}-{sentence}.wav"), s.get("loadavg", "–")])
if rows:
    table("Kokoro.js in Chrome (a different, 82M model)", ["dtype", "sentence", "audio s", "gen s", "RTF", "load s (network)", "memory MB", "WER", "load avg"], rows)
