# Desktop app wordmark and transparent mark — October 19, 2026

Updated the shared GUI branding to address the faint title and square image
background. The centered title now uses the same five-row block lettering as
the CLI, rendered as SVG geometry. It uses normal theme text contrast instead
of the previous 16% opacity and transient shimmer. It remains part of the
existing new-session screen; session behavior is unchanged.

The supplied white/silver emblem now has a transparent in-app cutout. The
small titlebar badge uses the shared mark rather than the native installer icon,
and no longer adds its rounded tile/shadow. In light themes only the image is
darkened for readability; dark themes retain the white/silver artwork. Theme
selection remains available. The original opaque master and native launcher
icons remain intact.

Asset: `assets/brand/subi-code-mark-transparent.png`, SHA256
`90007D819E2A8611CC5D2A218EFEC3EAC047ED1E3625BA71BA9405AC92842CD9`.
Built-in imagegen performed the transparent cutout; the selected prompt and
source provenance are in `assets/brand/subi-code-mark-transparent.md`.
Generated alpha is preserved. The full-resolution output contains very faint
near-transparent residue; the actual 256px app asset was visually checked on
both backgrounds. The original master remains byte-identical to the upload.

## Verification and installation

- Final root `bun run check`: 36/36 tasks successful (34 cached).
- Final renderer build and Windows NSIS packaging passed.
- Actual packaged app: startup, Build/Plan keyboard switching, one block-wordmark
  SVG at opacity 1, transparent image corner and shared titlebar icon all passed.
- Dark and light screenshots were inspected; the title and icon are readable
  without a background square.
- Windows installer exited 0. Installed executable, app.asar and bundled server
  hashes match the verified package. Accounts/settings/session data preserved.
- Installed-app private-profile checks also passed for startup, both theme
  screenshots, transparent marks, normal wordmark opacity and Build/Plan
  switching. Subi was reopened normally afterward. Evidence is in the sibling
  `desktop-wordmark-dev21-installed` audit directory.
- Desktop GUI version is dev.21, bundling the qualified dev.20 server with the
  independent default-port fix. Global CLI and VS Code extension are unchanged.
- This is a Windows native qualification. Shared source applies to web and other
  desktop platforms; Linux/macOS native execution is still pending.

Installer: `artifacts/2026-10-19/desktop-dev21-wordmark-final/subi-desktop-win-x64.exe`.
The earlier incomplete `desktop-dev21-wordmark` packaging attempt is not the
qualified installer. Development preview attempts hit an occupied debugging
port and left isolated services, which were identified and cleaned up. Native
packaged checks use independent private profiles and passed. An intermediate
prebuild hit a file lock; the already-prebuilt server hash/version were verified
before directly invoking the renderer builder. No server source was changed.

Backups/logs: `C:\Users\Admin\AppData\Local\Temp\subi2-20261019\app-wordmark`.
Native packaged screenshots/results are in
`C:\Users\Admin\AppData\Local\Temp\subi2-20261019\platform-audit\desktop-wordmark-dev21-final`.
No live inference, payment, publishing or backend deployment was performed.
