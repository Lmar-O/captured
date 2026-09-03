# Captured

A macOS app for importing videos from an SD card to your computer.

Pick a card on the left, review the clips in the middle, choose where they go on the right. Files can be sorted into dated folders automatically, and existing folders are reused rather than duplicated.

## Install

Download the `.dmg` from [Releases](https://github.com/Lmar-O/captured/releases), open it, and drag **Captured** to Applications.

The app is not signed with an Apple Developer ID, so the first launch needs a right-click → **Open** → **Open** instead of a double-click. macOS only asks once.

## Run from source

```bash
npm install
npm start
```

## Build a .dmg

```bash
npm run dist
```

Output lands in `dist/`. To regenerate the app icon after editing `build/icon.svg`:

```bash
npx electron build/make-icon.js
```
