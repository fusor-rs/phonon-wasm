#!/usr/bin/env bash
# Downloads what `phonon compile` reads into $1, each file pinned by revision and checked by
# sha256 (files already present are only checked): gradium/phonon-31m-en's config, tokenizer,
# weights and default voice, and the catalog voices from gradium/phonon-voices under voices/.
# `--reference` also downloads the q8 GGUF weights Gradium's own runtime loads (for
# benchmarks/head-to-head.mjs).
set -euo pipefail
DIR="$1"
MODEL="https://huggingface.co/gradium/phonon-31m-en/resolve/52433c46975bfa13144c56204c9f4ee1c5b148aa"
VOICES="https://huggingface.co/gradium/phonon-voices/resolve/0ee17205f254b5abc43b266c8a0f215565c352f7"
FILES="
7062ea376e6b158543c8abec8e5af67df171c49ad70eb7e2a0fb25c16f265e06  config.json  $MODEL
691a00068fa7b989f2f3e5ae5daa2d1a5bb319f2d5360deafcfb19a8bb6e7936  tokenizer.json  $MODEL
8a04cf833cfe69b67c2ec968b2d31244655b9accc84ade9c0ebcc176f2074607  model.safetensors  $MODEL
f739e8c4c76ee7f92e7c94a82002748c8cd22e99582ac49f7b9b94cd63786e18  default-voice.safetensors  $MODEL
6b3da6e2d796a20c51af892c482bd6509fb88267a221aff83c870843dee2a123  voices/4SZHfMpw-p46Ywgs.safetensors  $VOICES
eab20e4f159b48cfbc01b1885804e24f681f80e7a64f909182763a4e3361bee8  voices/d9XCyhjo4JhkHF1d.safetensors  $VOICES
a0c3dcb91b2247eca56536be9ae8e8becc1c807b1136c5fe101552d6a155b24a  voices/nGzMHMPAWGaJFHOo.safetensors  $VOICES
6e04b84d3ae8751b22bca0a4f63936f9cb648f4f2182b2d0788071ea1c0b68a1  voices/qIxlZ7Ei8KvWlyQH.safetensors  $VOICES
56494ee67d533ad227ff0dfd0b1c13ff5aa91f1ad6e596e66c2986ba3005e844  voices/6PWnV0Nq4wu7RVBT.safetensors  $VOICES
ff1d0735b8b45710462b1d1f846da040f970c6eb62c7c2f36dbfb8e5bde74f1e  voices/zUCxzrOrugTSis03.safetensors  $VOICES
"
if [ "${2:-}" = --reference ]; then
  FILES="$FILES
a7d9aad2cd6dc66473f24a08bc6d2939030ef4d751ef82349361fbef3272dbae  model.q8.gguf  $MODEL"
fi
mkdir -p "$DIR/voices"
while read -r _ file base; do
  if [ -z "$file" ] || [ -s "$DIR/$file" ]; then continue; fi
  echo "downloading $file"
  curl -fsSL --retry 3 -o "$DIR/$file.part" "$base/$file"
  mv "$DIR/$file.part" "$DIR/$file"
done <<< "$FILES"
(cd "$DIR" && awk 'NF { print $1 "  " $2 }' <<< "$FILES" | shasum -a 256 -c --quiet -)
