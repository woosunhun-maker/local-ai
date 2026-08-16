#!/bin/zsh
set -euo pipefail

ROOT="/Users/hun/Documents/로컬ai/secure-chat"
SRC="${ROOT}/macos/LocalAIOrb/main.swift"
APP="${ROOT}/macos/dist/LocalAIOrb.app"
BIN="${APP}/Contents/MacOS/LocalAIOrb"

/bin/mkdir -p "${APP}/Contents/MacOS" "${APP}/Contents/Resources"
/bin/cp "${ROOT}/macos/LocalAIOrb/Info.plist" "${APP}/Contents/Info.plist"
/usr/bin/swiftc -O -o "${BIN}" "${SRC}" -framework AppKit -framework SwiftUI -framework QuartzCore -framework CoreGraphics
/usr/bin/codesign --force --sign - "${APP}" >/dev/null
print "built ${APP}"
