#!/bin/zsh
# Build Ditherlab.app (launcher + icon) into ~/Applications.
set -euo pipefail
cd "$(dirname "$0")"

DEST="$HOME/Applications/Ditherlab.app"
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

echo "→ app bundle"
mkdir -p "$HOME/Applications"
rm -rf "$DEST"
PROJECT_DIR="$(cd .. && pwd)"
sed "s|__PROJECT_DIR__|$PROJECT_DIR|" launcher.applescript > "$TMP/launcher.applescript"
osacompile -o "$DEST" "$TMP/launcher.applescript"
cp "$TMP/Ditherlab.icns" "$DEST/Contents/Resources/applet.icns"
/usr/libexec/PlistBuddy -c "Set :CFBundleName Ditherlab" "$DEST/Contents/Info.plist" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :CFBundleName string Ditherlab" "$DEST/Contents/Info.plist"
touch "$DEST"

echo "✓ built $DEST"
