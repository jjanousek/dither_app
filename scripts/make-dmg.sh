#!/bin/zsh
# Package the built Ditherlab.app into a distributable drag-to-Applications
# DMG at dist/Ditherlab-<version>.dmg. Runs build-app.sh first so the DMG
# always contains a fresh, self-contained build.
#
# Two modes, chosen by whether signing credentials are present:
#
#   1. Ad-hoc (default, free). No Apple Developer account. The download is
#      NOT notarized, so on macOS 15 (Sequoia) first launch is BLOCKED with
#      "…can't be opened… This software needs to be updated. Contact the
#      developer." The user must clear it manually (see docs/DISTRIBUTION.md).
#      Fine for you and technical friends; a poor front door for the public.
#
#   2. Signed + notarized (frictionless). Set these env vars and it signs
#      with your Developer ID, notarizes the DMG with Apple, and staples the
#      ticket so it opens with a normal double-click on every Mac:
#        DEVELOPER_ID="Developer ID Application: Your Name (TEAMID)"
#        NOTARY_PROFILE="ditherlab"   # from: xcrun notarytool store-credentials
#      Requires the Apple Developer Program ($99/yr). See docs/DISTRIBUTION.md.
set -euo pipefail
cd "$(dirname "$0")"

: "${DEVELOPER_ID:=}"
: "${NOTARY_PROFILE:=}"

DEVELOPER_ID="$DEVELOPER_ID" ./build-app.sh

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

if [[ -n "$DEVELOPER_ID" && -n "$NOTARY_PROFILE" ]]; then
  echo "→ sign dmg"
  codesign --force -s "$DEVELOPER_ID" "$DMG"
  echo "→ notarize (this uploads to Apple and can take a few minutes)"
  xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
  echo "→ staple"
  xcrun stapler staple "$DMG"
  echo "✓ NOTARIZED $DMG ($(du -h "$DMG" | cut -f1 | tr -d ' ')) — opens cleanly on any Mac"
else
  echo "✓ $DMG ($(du -h "$DMG" | cut -f1 | tr -d ' '))"
  echo "⚠ ad-hoc build: downloads are NOT notarized and will be blocked by"
  echo "  Gatekeeper on first launch. Set DEVELOPER_ID + NOTARY_PROFILE for a"
  echo "  frictionless download (see docs/DISTRIBUTION.md)."
fi
