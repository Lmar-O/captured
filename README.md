# Captured

A macOS app for importing videos from an SD card to your computer.

Pick a card on the left, review the clips in the middle, choose where they go on the right. Files can be sorted into dated folders automatically, and existing folders are reused rather than duplicated.

## Install

Download the `.dmg` from [Releases](https://github.com/Lmar-O/captured/releases/latest), open it, and drag **Captured** to Applications. The build is universal — Apple Silicon and Intel.

macOS blocks the app on first launch, because it is signed ad-hoc rather than with an Apple Developer ID. To allow it:

**System Settings → Privacy & Security**, scroll to **Security**, and click **Open Anyway** next to the message about Captured. Then open the app again and confirm.

> Control-clicking the app and choosing *Open* does **not** work on macOS 15 (Sequoia) or later — Apple removed that bypass. Older advice you may find elsewhere is out of date.

One-line alternative:

```bash
xattr -dr com.apple.quarantine /Applications/Captured.app
```

## Run from source

```bash
npm install
npm start
```

## Build a .dmg

```bash
npm run dist
```

Output lands in `dist/`. To regenerate the app icon after editing `build/icon-source.png`:

```bash
npx electron build/make-icon.js
```

## Releasing

Pushing a `v*` tag builds the universal DMG on a macOS runner and attaches it to the release:

```bash
git tag v1.1.0 && git push origin v1.1.0
```

`.github/workflows/release.yml` also accepts a manual run against an existing tag.
