# Distributing Ditherlab

## Building a release

```sh
bash scripts/make-dmg.sh
```

This rebuilds the self-contained app (web assets bundled into
`Contents/Resources/web`, served by the in-process Swift server — no Python,
no external files) and packages it as `dist/Ditherlab-<version>.dmg` with a
drag-to-Applications layout. Bump `VERSION` in `scripts/build-app.sh` for a
new release, then copy the DMG to the website's `downloads/` folder and
update the links in its `index.html`.

## Gatekeeper: the current state (unsigned)

The DMG ships ad-hoc signed. Because it is not notarized, macOS shows
"Apple could not verify …" on first launch. Users bypass it once via
**System Settings → Privacy & Security → Open Anyway** (the website's
download section explains this). This is the standard experience for free
unsigned Mac apps.

## Upgrading to a frictionless install (Developer ID + notarization)

With an [Apple Developer Program](https://developer.apple.com/programs/)
membership ($99/year), first launch becomes a plain double-click:

1. In Xcode (or developer.apple.com), create a **Developer ID Application**
   certificate and install it in your keychain.
2. Sign with the hardened runtime (required for notarization). In
   `scripts/build-app.sh`, replace the ad-hoc `codesign -s -` line with:

   ```sh
   codesign --force --deep --options runtime \
     -s "Developer ID Application: YOUR NAME (TEAMID)" \
     "$TMP/Ditherlab.app"
   ```

3. Store notary credentials once:

   ```sh
   xcrun notarytool store-credentials ditherlab \
     --apple-id you@example.com --team-id TEAMID
   ```

   (generate the app-specific password at appleid.apple.com)

4. After `make-dmg.sh`, notarize and staple the DMG:

   ```sh
   xcrun notarytool submit dist/Ditherlab-<v>.dmg --keychain-profile ditherlab --wait
   xcrun stapler staple dist/Ditherlab-<v>.dmg
   ```

The stapled DMG opens cleanly on every Mac, offline included. No code
changes are needed — only the signing identity and the two notary commands.

## Notes

- The app requires macOS 13.5+ (`LSMinimumSystemVersion`), Apple Silicon or
  Intel (built on whatever arch runs `build-app.sh`; for a universal binary
  add `-target arm64-apple-macos13.5` / `x86_64` slices via `lipo`).
- `scripts/serve.py` remains for browser-based development only; the shipped
  app does not use or include it.
- Auto-updates: if release cadence picks up, the standard choice is
  [Sparkle](https://sparkle-project.org) — not currently wired in.
