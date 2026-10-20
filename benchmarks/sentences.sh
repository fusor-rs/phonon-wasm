#!/bin/bash
# The three benchmark sentences, shared by every script here (the same three as ming-wasm's).
#   source benchmarks/sentences.sh; text S1
text() {
  case $1 in
    S1) echo "Please remember to water the plants on Tuesday, and call the dentist about the appointment at three o'clock." ;;
    S2) echo "The evening wind drifted down from the mountain pass, and the distant clouds slowly turned gold." ;;
    S3) echo "Glaciers move slowly, carving valleys over thousands of years while the rivers below carry the silt to the sea." ;;
    *) echo "unknown sentence $1" >&2; exit 2 ;;
  esac
}
# Both runtimes' built-in defaults, passed explicitly so neither side relies on a default.
TEMPERATURE=0.3
SEED=4242424242424242
loadavg() { sysctl -n vm.loadavg | awk '{print $2}'; }
