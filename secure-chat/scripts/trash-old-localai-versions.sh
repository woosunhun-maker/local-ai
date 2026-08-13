#!/bin/zsh
set -euo pipefail

readonly CURRENT_VERSION="1.2.0"
readonly CURRENT_BUILD="9"
readonly RUNTIME_ROOT="/Users/hun/PrivateAI/app/secure-chat"
readonly TRASH_ROOT="/Users/hun/.Trash"
readonly STAMP="$(/bin/date -u +%Y%m%dT%H%M%SZ)"
readonly TRASH_BATCH="${TRASH_ROOT}/LocalAI-old-versions-${STAMP}"

if [[ "$(/opt/homebrew/bin/node -p "require('${RUNTIME_ROOT}/package.json').version")" != "$CURRENT_VERSION" ]]; then
  print -u2 "Current 1.1 runtime is not deployed; refusing old-version cleanup."
  exit 1
fi
if [[ "$(/usr/bin/curl --silent --output /dev/null --write-out '%{http_code}' --max-time 3 http://127.0.0.1:18791/health)" != "200" ]]; then
  print -u2 "Current runtime is not healthy; refusing old-version cleanup."
  exit 1
fi

typeset -a candidates
candidates=(
  "/private/tmp/LocalAIDerivedData"
  "/private/tmp/LocalAIQualityDerivedData"
  "/private/tmp/LocalAIPhysicalDerivedData"
  "/private/tmp/localai-ux-derived"
  "/private/tmp/localai-derived"
  "/private/tmp/localai-audit-derived.HlBioX"
  "/private/tmp/localai-regression.xddg4Q"
  "/private/tmp/localai-final-derived"
  "/private/tmp/localai-device-release"
  "/private/tmp/LocalAI-FinalTests.xcresult"
  "/private/tmp/LocalAI-FinalTests-2.xcresult"
  "/private/tmp/LocalAI-FinalTests-3.xcresult"
  "/private/tmp/localai-mlx.XliH35"
  "/Users/hun/Library/Developer/Xcode/DerivedData/LocalAI-fqffjgynpfypbcfiqxurfztbgltb"
  "/Users/hun/PrivateAI/backups/secure-chat/launchagents-20260804T173348Z"
  "/Users/hun/PrivateAI/backups/secure-chat/1.0.0-20260804T173900Z"
  "/Users/hun/PrivateAI/backups/secure-chat/1.0.0-20260804T173328Z"
  "/Users/hun/PrivateAI/backups/secure-chat/1.0.0-20260804T175851Z"
  "/Users/hun/PrivateAI/backups/secure-chat/1.0.0-20260804T173709Z"
  "/Users/hun/PrivateAI/backups/secure-chat/1.0.0-20260804T174609Z"
  "/Users/hun/PrivateAI/backups/secure-chat/1.0.0-20260804T173340Z"
  "/Users/hun/PrivateAI/backups/secure-chat/1.0.0-20260804T175112Z"
  "/Users/hun/PrivateAI/backups/secure-chat/.launchagents-rollback-pbzugz"
  "/Users/hun/PrivateAI/backups/tts/worker-regex-20260804T1759Z"
  "/Users/hun/PrivateAI/backups/tts/worker-20260804T1747Z"
  "/Users/hun/PrivateAI/app/cloud-consultant"
)

for protected in \
  "/private/tmp/localai-1.1-device-derived" \
  "/private/tmp/localai-1.1-sim-derived" \
  "/Users/hun/Documents/로컬ai/secure-chat" \
  "/Users/hun/PrivateAI/app/secure-chat" \
  "/Users/hun/PrivateAI/runtime" \
  "/Users/hun/PrivateAI/models" \
  "/Users/hun/PrivateAI/data"; do
  if (( ${candidates[(Ie)$protected]} )); then
    print -u2 "Protected current path appeared in cleanup list: ${protected}"
    exit 1
  fi
done

typeset -a existing
for path in "${candidates[@]}"; do
  [[ -e "$path" ]] && existing+=("$path")
done
if (( ${#existing[@]} == 0 )); then
  print "No old Local AI versions remain."
  exit 0
fi

/bin/mkdir -p "$TRASH_ROOT"
/bin/mkdir "$TRASH_BATCH"
/bin/chmod 700 "$TRASH_BATCH"

integer index=0
for path in "${existing[@]}"; do
  (( index += 1 ))
  destination="${TRASH_BATCH}/$(printf '%02d' "$index")-$(/usr/bin/basename "$path")"
  /bin/mv -- "$path" "$destination"
  print "trashed: ${path}"
done

print "Old Local AI versions moved to: ${TRASH_BATCH}"
print "Items moved: ${#existing[@]}"
