# Subi Code CLI welcome wordmark — dev.18

The user's follow-up requests a large centered SUBICODE wordmark on the fresh
welcome screen. It is implemented and the Windows CLI is installed as
`subi v2.0.0-dev.18`.

The Home route renders the existing five-line Subi Code lettering centered above
the composer, in the current theme's base text color. It stays visible while
drafting. Sending a message navigates to the existing session route and unmounts
the banner; creating a fresh session returns to Home and restores it. Explicitly
resuming an existing conversation keeps that conversation's normal session view.
Narrow or short terminals use compact lettering; the editor and shortcut hints
remain accessible. The theme selector and existing logo artwork defaults remain.

Changed sources are `packages/tui/src/routes/home.tsx`,
`packages/tui/src/component/logo.tsx` and `packages/tui/test/cli-design.test.tsx`.
The logo component accepts optional color and compact presentation inputs; its
existing default behavior and original lettering tests remain intact.

Verification:

- Design, logo and real-app send/new-session lifecycle: 100 pass, zero failures
  over ten repetitions, 550 assertions.
- Existing app lifecycle and session Home regression tests: 49 pass, 2 existing
  skips, zero failures, 297 assertions.
- Root `bun run check`: 36/36 successful tasks.
- Actual Windows ConPTY: large lettering, welcome, model/menu shortcuts, all
  existing Settings choices, terminal title and resizing to 44×26 pass in a
  private profile. No provider inference or billing calls.
- Normal installed `subi --version` prints dev.18; installed native bytes match
  the built artifact. Changed-file whitespace checks pass.

The first repetition run caught a fixture readiness error: the test submitted
before its sample model was loaded. Waiting for the rendered model selection
before submission fixes it; no timeout or assertion was loosened.

Native binary:
`packages/cli/dist/subi-welcome-banner-20261019/cli-windows-x64-baseline/bin/subi.exe`.
SHA256: `20962773CFF30452EF538D6FB32F90E598FB3E554967E9AE0282CB184DBC6290`.
Offline installation package:
`artifacts/2026-10-19/learnsmart-subi-cli-2.0.0-dev.18.tgz`.

[Welcome preview](../artifacts/2026-10-19/welcome-banner-preview/home.png) and
[narrow preview](../artifacts/2026-10-19/welcome-banner-preview/narrow.png) show
captured cells from the production TUI with a sample catalog, rendered to PNG.
They are not live account or inference evidence.

Before replacement, dev.17 package/shims were copied to
`C:\Users\Admin\AppData\Local\Temp\subi2-20261019\welcome-banner-cli-backup`.
Source baselines are in `welcome-banner-before` under that same external directory.
Build/check/native/package results are also there; reused suite logs are in
`C:\Users\Admin\AppData\Local\Temp\subi2-20261018\welcome-banner-*.log`.

Close an older CLI and launch `subi --standalone` from your project to see dev.18.
Extension and desktop installed packages remain dev.16 for their separate phases.
This change does not alter account/model permissions or qualify a full release.
