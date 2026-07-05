#!/bin/zsh
# Build the native Ditherlab.app (Swift + WKWebView) into ~/Applications.
# Needs the Xcode Command Line Tools (swiftc). Re-run after moving the project.
set -euo pipefail
cd "$(dirname "$0")"

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

echo "→ compile"
# literal substitution (sed would corrupt paths containing & or |)
python3 -c 'import sys; print(open(sys.argv[1]).read().replace("__PROJECT_DIR__", sys.argv[2]), end="")' main.swift "$PROJECT_DIR" > "$TMP/main.swift"
mkdir -p "$TMP/Ditherlab.app/Contents/MacOS" "$TMP/Ditherlab.app/Contents/Resources"
swiftc -O -swift-version 5 -o "$TMP/Ditherlab.app/Contents/MacOS/Ditherlab" "$TMP/main.swift"

echo "→ bundle"
cp "$TMP/Ditherlab.icns" "$TMP/Ditherlab.app/Contents/Resources/Ditherlab.icns"
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
	<key>CFBundleShortVersionString</key><string>1.0.0</string>
	<key>CFBundleVersion</key><string>1</string>
	<key>LSMinimumSystemVersion</key><string>13.5</string>
	<key>NSHighResolutionCapable</key><true/>
	<key>NSCameraUsageDescription</key>
	<string>Ditherlab uses the camera for the webcam source.</string>
</dict>
</plist>
PLIST

codesign --force -s - "$TMP/Ditherlab.app" 2>/dev/null

mkdir -p "$HOME/Applications"
rm -rf "$DEST"
mv "$TMP/Ditherlab.app" "$DEST"
touch "$DEST"
echo "✓ built $DEST"
