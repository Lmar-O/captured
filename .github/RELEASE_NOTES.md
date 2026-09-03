Universal build — runs on both Apple Silicon and Intel Macs.

## Installing

Open the `.dmg` and drag **Captured** to Applications.

The app is signed ad-hoc rather than with an Apple Developer ID, so macOS
blocks it the first time. To allow it:

**System Settings → Privacy & Security**, scroll to **Security**, and click
**Open Anyway** next to the message about Captured. Then open the app again
and confirm.

Control-clicking the app and choosing *Open* does **not** work on macOS 15
(Sequoia) or later — Apple removed that bypass.

If you would rather do it in one line:

```bash
xattr -dr com.apple.quarantine /Applications/Captured.app
```
