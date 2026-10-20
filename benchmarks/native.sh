#!/bin/bash
# Times the two native CLIs on the same sentences, thread counts, voice, temperature and seed:
# this repository's `phonon synth` (q7 and f32 bundles) and Gradium's `ptts` from xn-ptts
# (q8, q4k and f32 weights on the CPU, and f32 on Metal). Every run goes through
# `nice -n 19 /usr/bin/time -l`, which gives the peak RSS and the CPU time (user+sys); CPU time
# over wall time is the parallelism the run actually got, the check that `--threads` took.
#
#   benchmarks/native.sh [out-dir]                      # default benchmarks/out/native
#   RUNTIMES="phonon-q7 ptts-q8" THREADS="1 8" SENTENCES="S1" REPEAT=3 benchmarks/native.sh
#
# Runtimes: phonon-q7 phonon-f32 ptts-q8 ptts-q4k ptts-f32 ptts-metal (Metal ignores threads).
# Needs PTTS (the ptts binary, built with xn-ptts's own flags) and CKPT (a checkpoint directory
# with config.json, tokenizer.json, model.safetensors, model.q8.gguf, model.q4k.gguf,
# default-voice.safetensors). PHONON_F32 is the f32 bundle (`phonon compile ... --profile f32`).
#
# Per run, one warm-up (discarded) precedes REPEAT measured runs of each configuration and
# sentence. Writes one TSV row per measured run to <out>/native.tsv, the WAV of the first
# measured run of each configuration (for the ASR check), and `phonon bench` per thread count.
set -euo pipefail
cd "$(dirname "$0")/.."
source benchmarks/sentences.sh
out=${1:-benchmarks/out/native}
mkdir -p "$out"
PHONON=${PHONON:-target/release/phonon}
PHONON_Q7=${PHONON_Q7:-dist/model}
PHONON_F32=${PHONON_F32:?set PHONON_F32 to an f32 bundle}
PTTS=${PTTS:?set PTTS to the ptts binary}
CKPT=${CKPT:?set CKPT to the checkpoint directory}
RUNTIMES=${RUNTIMES:-"phonon-q7 phonon-f32 ptts-q8 ptts-q4k ptts-f32 ptts-metal"}
THREADS=${THREADS:-"1 3 4 8"}
SENTENCES=${SENTENCES:-"S1 S2 S3"}
REPEAT=${REPEAT:-3}
tsv="$out/native.tsv"
ptsv="$out/parallelism.tsv"
[ -f "$ptsv" ] || printf 'runtime\tthreads\taudio_s\tgen_s\tcpu_s\twall_s\tparallelism\tloadavg\n' > "$ptsv"
[ -f "$tsv" ] || printf 'runtime\tthreads\tsentence\trun\tframes\taudio_s\tgen_s\trtf\tms_frame\tfirst_audio_ms\tload_s\tpeak_rss_mb\tcpu_s\twall_s\tparallelism\tloadavg\n' > "$tsv"

# Sets CMD, the command for a runtime, thread count, sentence text and output WAV.
command_for() {
  local runtime=$1 threads=$2 text=$3 wav=$4
  case $runtime in
    phonon-q7) CMD=("$PHONON" --threads "$threads" synth "$PHONON_Q7" "$text" -o "$wav" --temperature $TEMPERATURE --seed $SEED) ;;
    phonon-f32) CMD=("$PHONON" --threads "$threads" synth "$PHONON_F32" "$text" -o "$wav" --temperature $TEMPERATURE --seed $SEED) ;;
    ptts-q8) CMD=("$PTTS" --model "$CKPT" --lang en --quant q8 --device cpu --threads "$threads" -t $TEMPERATURE -s $SEED "$text" -o "$wav") ;;
    ptts-q4k) CMD=("$PTTS" --model "$CKPT" --lang en --quant q4k --weights model.q4k.gguf --device cpu --threads "$threads" -t $TEMPERATURE -s $SEED "$text" -o "$wav") ;;
    ptts-f32) CMD=("$PTTS" --model "$CKPT" --lang en --device cpu --threads "$threads" -t $TEMPERATURE -s $SEED "$text" -o "$wav") ;;
    ptts-metal) CMD=("$PTTS" --model "$CKPT" --lang en --device metal --threads "$threads" -t $TEMPERATURE -s $SEED "$text" -o "$wav") ;;
    *) echo "unknown runtime $runtime" >&2; exit 2 ;;
  esac
}

# Parses one run's combined output into the TSV fields (frames audio gen rtf msf first load rss cpu wall).
parse() {
  local runtime=$1 log=$2 line frames audio gen rtf msf first load
  if [[ $runtime == phonon-* ]]; then
    # "1 fragment(s), 69 frames, 5.52s audio in 0.52s: RTF 0.094, 7.5 ms/frame, first audio 12 ms -> x.wav"
    line=$(grep -F 'fragment(s)' <<< "$log")
    frames=$(sed -E 's/.*, ([0-9]+) frames.*/\1/' <<< "$line")
    audio=$(sed -E 's/.*frames, ([0-9.]+)s audio.*/\1/' <<< "$line")
    gen=$(sed -E 's/.*audio in ([0-9.]+)s.*/\1/' <<< "$line")
    rtf=$(sed -E 's/.*RTF ([0-9.]+).*/\1/' <<< "$line")
    msf=$(sed -E 's/.*RTF [0-9.]+, ([0-9.]+) ms\/frame.*/\1/' <<< "$line")
    first=$(sed -E 's/.*first audio ([0-9.]+) ms.*/\1/' <<< "$line")
    # "loaded dist/model (46 MB) in 0.05s, 4 threads"
    load=$(grep -F 'loaded ' <<< "$log" | sed -E 's/.* in ([0-9.]+)s.*/\1/')
  else
    # "generated 5.52s in 0.60s (RTF=0.1087, first chunk 24ms)"; frames = samples / 1920 from the WAV
    line=$(grep -F 'generated ' <<< "$log" | sed 's/\x1b\[[0-9;]*m//g')
    audio=$(sed -E 's/.*generated ([0-9.]+)s in.*/\1/' <<< "$line")
    gen=$(sed -E 's/.*s in ([0-9.]+)s \(RTF.*/\1/' <<< "$line")
    rtf=$(sed -E 's/.*RTF=([0-9.]+).*/\1/' <<< "$line")
    first=$(sed -E 's/.*first chunk ([0-9.]+)ms.*/\1/' <<< "$line")
    frames=$(awk -v a="$audio" 'BEGIN { printf "%d", a * 12.5 + 0.5 }')
    msf=$(awk -v g="$gen" -v f="$frames" 'BEGIN { printf "%.2f", 1000 * g / f }')
    # From the first INFO line ("loading model") to "model loaded": wall-clock timestamps.
    local t0 t1
    t0=$(grep -F 'loading model' <<< "$log" | sed 's/\x1b\[[0-9;]*m//g' | head -1 | awk '{print $1}')
    t1=$(grep -F 'model loaded' <<< "$log" | sed 's/\x1b\[[0-9;]*m//g' | head -1 | awk '{print $1}')
    load=$(python3 -I -c "import sys,datetime as d; p=lambda s:d.datetime.fromisoformat(s.replace('Z','+00:00')); print(f'{(p(sys.argv[2])-p(sys.argv[1])).total_seconds():.3f}')" "$t0" "$t1")
  fi
  local rss cpu wall
  rss=$(grep -F 'maximum resident set size' <<< "$log" | awk '{printf "%.0f", $1 / 1e6}')
  # "        0.60 real         2.31 user         0.08 sys"
  read -r wall cpu < <(grep -E '^\s*[0-9.]+ real' <<< "$log" | awk '{printf "%s %.3f\n", $1, $3 + $5}')
  echo "$frames $audio $gen $rtf $msf $first $load $rss $cpu $wall"
}

for runtime in $RUNTIMES; do
  threads_list=$THREADS
  [[ $runtime == ptts-metal ]] && threads_list="1"
  for t in $threads_list; do
    if [[ $runtime == phonon-* && $SENTENCES == *S1* ]]; then
      bundle=$PHONON_Q7; [[ $runtime == phonon-f32 ]] && bundle=$PHONON_F32
      echo "=== bench $runtime threads=$t (load $(loadavg))"
      nice -n 19 "$PHONON" --threads "$t" bench "$bundle" > "$out/bench-$runtime-t$t.txt" 2>&1 || true
    fi
    # Did --threads take? One long run (the three sentences three times, about 50 s of audio) in
    # which generation dominates the process, so CPU time over wall time is its parallelism.
    long="$(text S1) $(text S2) $(text S3) $(text S1) $(text S2) $(text S3) $(text S1) $(text S2) $(text S3)"
    command_for "$runtime" "$t" "$long" "$out/parallelism.wav"
    if log=$(nice -n 19 /usr/bin/time -l "${CMD[@]}" 2>&1); then
      read -r _ audio gen _ _ _ _ _ cpu wall < <(parse "$runtime" "$log")
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$runtime" "$t" "$audio" "$gen" "$cpu" "$wall" \
        "$(awk -v c="$cpu" -v w="$wall" 'BEGIN { printf "%.2f", (w > 0) ? c / w : 0 }')" "$(loadavg)" | tee -a "$ptsv"
    fi
    rm -f "$out/parallelism.wav"
    for s in $SENTENCES; do
      for ((i = -1; i < REPEAT; i++)); do
        wav="$out/$runtime-t$t-$s-$i.wav"
        [ $i -ge 0 ] || wav="$out/warmup.wav"
        command_for "$runtime" "$t" "$(text "$s")" "$wav"
        log=$(nice -n 19 /usr/bin/time -l "${CMD[@]}" 2>&1) || { echo "$log" | tail -5 >&2; continue; }
        [ $i -ge 0 ] || continue
        read -r frames audio gen rtf msf first load rss cpu wall < <(parse "$runtime" "$log")
        par=$(awk -v c="$cpu" -v w="$wall" 'BEGIN { printf "%.2f", (w > 0) ? c / w : 0 }')
        printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
          "$runtime" "$t" "$s" "$i" "$frames" "$audio" "$gen" "$rtf" "$msf" "$first" "$load" "$rss" "$cpu" "$wall" "$par" "$(loadavg)" | tee -a "$tsv"
        [ $i -eq 0 ] || rm -f "$wav"
      done
    done
  done
done
rm -f "$out/warmup.wav"
