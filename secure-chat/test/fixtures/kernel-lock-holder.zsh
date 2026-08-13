#!/bin/zsh
set -euo pipefail

readonly helper_path="$1"
readonly lock_path="$2"
readonly ready_path="$3"

source "$helper_path"
local_ai_kernel_lock_acquire "$lock_path"
print -r -- "ready" >| "$ready_path"
zmodload zsh/zselect
while true; do
  zselect -t 100 || true
done
