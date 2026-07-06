#!/bin/zsh
# Package the built Ditherlab.app into a distributable drag-to-Applications
# DMG at dist/Ditherlab-<version>.dmg. Runs build-app.sh first so the DMG
# always contains a fresh, self-contained build.
#
# The app is ad-hoc signed. Downloads from the web will still trip
# Gatekeeper ("Apple could not verify..."), which users bypass once via
# System Settings → Privacy & Security → Open Anyway. To remove that
# friction entirely, sign with a Developer ID and notarize — see
# docs/DISTRIBUTION.md.
set -euo pipefail
cd "$(dirname "$0")"

./build-app.sh

APP="$HOME/Applications/Ditherlab.app"
VERSION="$(defaults read "$APP/Contents/Info" CFBundleShortVersionString)"
DIST="$(cd .. && pwd)/dist"
DMG="$DIST/Ditherlab-$VERSION.dmg"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo "→ stage"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"

echo "→ dmg"
mkdir -p "$DIST"
rm -f "$DMG"
hdiutil create -volname "Ditherlab" -srcfolder "$STAGE" -ov -format UDZO -quiet "$DMG"

echo "✓ $DMG ($(du -h "$DMG" | cut -f1 | tr -d ' '))"
