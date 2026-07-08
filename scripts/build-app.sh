#!/bin/zsh
# Build the native Ditherlab.app (Swift + WKWebView) into ~/Applications.
# The web assets are bundled into Contents/Resources/web, so the built app is
# fully self-contained and can be distributed (see make-dmg.sh).
# Needs the Xcode Command Line Tools (swiftc).
set -euo pipefail
cd "$(dirname "$0")"

VERSION="1.2.3"
DEST="$HOME/Applications/Ditherlab.app"
PROJECT_DIR="$(cd .. && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "→ icon"
python3 make-icon.py "$TMP/icon-1024.png"
ICONSET="$TMP/Ditherlab.iconset"
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$TMP/icon-1024.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2))
  sips -z $d $d "$TMP/icon-1024.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$TMP/Ditherlab.icns"

echo "→ compile (universal)"
mkdir -p "$TMP/Ditherlab.app/Contents/MacOS" "$TMP/Ditherlab.app/Contents/Resources"
swiftc -O -swift-version 5 -target arm64-apple-macos13.5 -o "$TMP/dl-arm64" main.swift
swiftc -O -swift-version 5 -target x86_64-apple-macos13.5 -o "$TMP/dl-x86_64" main.swift
lipo -create "$TMP/dl-arm64" "$TMP/dl-x86_64" -output "$TMP/Ditherlab.app/Contents/MacOS/Ditherlab"

echo "→ bundle"
cp "$TMP/Ditherlab.icns" "$TMP/Ditherlab.app/Contents/Resources/Ditherlab.icns"

# self-contained web assets
WEB="$TMP/Ditherlab.app/Contents/Resources/web"
mkdir -p "$WEB/assets"
cp "$PROJECT_DIR/index.html" "$WEB/"
cp -R "$PROJECT_DIR/js" "$PROJECT_DIR/css" "$WEB/"
cp "$PROJECT_DIR/assets/demo.jpg" "$WEB/assets/"
cat > "$TMP/Ditherlab.app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key><string>Ditherlab</string>
	<key>CFBundleDisplayName</key><string>Ditherlab</string>
	<key>CFBundleIdentifier</key><string>com.ditherlab.app</string>
	<key>CFBundleExecutable</key><string>Ditherlab</string>
	<key>CFBundleIconFile</key><string>Ditherlab</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleShortVersionString</key><string>$VERSION</string>
	<key>CFBundleVersion</key><string>6</string>
	<key>LSMinimumSystemVersion</key><string>13.5</string>
	<key>NSHighResolutionCapable</key><true/>
	<key>NSCameraUsageDescription</key>
	<string>Ditherlab uses the camera for the webcam source.</string>
</dict>
</plist>
PLIST

# Developer ID + hardened runtime when set (required to notarize); else ad-hoc.
# arm64 binaries MUST carry at least an ad-hoc signature or the kernel kills
# them on launch (SIGKILL) — never ship unsigned.
if [[ -n "${DEVELOPER_ID:-}" ]]; then
  codesign --force --options runtime --timestamp -s "$DEVELOPER_ID" "$TMP/Ditherlab.app"
else
  codesign --force -s - "$TMP/Ditherlab.app" 2>/dev/null
fi

mkdir -p "$HOME/Applications"
rm -rf "$DEST"
mv "$TMP/Ditherlab.app" "$DEST"
touch "$DEST"
echo "✓ built $DEST"
