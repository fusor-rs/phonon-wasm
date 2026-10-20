#!/bin/bash
# Transcribes every benchmark WAV under benchmarks/out with faster-whisper (small, int8, via
# scripts/asr_check.py) and scores its word error rate against the sentence it was made from
# (the sentence key is in the file name: ...-S1.wav, ...-S1-0.wav). Writes <out>/asr.tsv.
#
#   ASR_PYTHON=<python with faster-whisper> benchmarks/asr.sh [benchmarks/out]
set -euo pipefail
cd "$(dirname "$0")/.."
source benchmarks/sentences.sh
ASR_PYTHON=${ASR_PYTHON:?set ASR_PYTHON to a Python with faster-whisper}
out=${1:-benchmarks/out}
tsv="$out/asr.tsv"
printf 'wav\tsentence\twer\ttranscript\n' > "$tsv"
for s in S1 S2 S3; do
  files=$(find "$out" -name "*-$s.wav" -o -name "*-$s-0.wav" | sort)
  [ -n "$files" ] || continue
  # -I: the WAVs are data, and the interpreter must not pick up modules from their directories.
  "$ASR_PYTHON" -I scripts/asr_check.py --text "$(text "$s")" $files | while IFS= read -r line; do
    # "WER=0.000 path | transcript"
    wer=$(sed -E 's/^WER=([0-9.]+) .*/\1/' <<< "$line")
    path=$(sed -E 's/^WER=[0-9.]+ ([^ ]+) \| .*/\1/' <<< "$line")
    transcript=$(sed -E 's/^[^|]*\| //' <<< "$line")
    printf '%s\t%s\t%s\t%s\n' "${path#"$out"/}" "$s" "$wer" "$transcript" | tee -a "$tsv"
  done
done
