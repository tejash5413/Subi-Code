# Subi Code CLI design — October 19, 2026

Follow-up: the user requested the large centered welcome wordmark again. It is
now restored in installed dev.18; see [welcome update](subi-cli-welcome-2026-10-19.md).
The dev.17 implementation and qualification below remain historical evidence.

The approved minimal CLI design is implemented in `D:\LearnSmart\Subi 2.0`.
The CLI is the first presentation phase. Extension and desktop GUI designs are
still separate follow-up work; their installed October 18 dev.16 builds are retained.

## Behavior

- Small `subi code` masthead and workspace name, a simple welcome message, and a
  neutral rounded composer replace the large Home logo and colored prompt rail.
- The default Subi Code theme uses neutral surfaces, text, syntax, feedback and
  agent shades in light/dark modes. Distinct panel backgrounds and category shades
  preserve pane boundaries and agent identities. Diff additions/removals retain
  their existing markers and readable foregrounds.
- Theme display aliases, saved theme IDs, custom themes, all other built-in themes,
  Color mode, Animations, Sidebar, Scrollbar and Thinking controls are preserved.
  A saved Carbonfox preference remains Carbonfox; select Subi Code in Settings to
  use the new neutral palette.
- Hints read the registered, configured key bindings. They do not install a second
  input handler. Default hints cover Ctrl+P commands, Shift+Tab agent, Ctrl+X then M
  models, @ files, Ctrl+V paste, up/down history and Escape stop. Under 44 columns,
  the shortcut row supplies the menu hint that the compact existing footer hides.
- Existing textarea cursor, navigation, paste, attachment and submission handlers
  remain. The session composer uses less padding so it does not crowd the transcript.
- Account/model fetching, limits, credits, permission enforcement and inference
  execution were not changed by this presentation work.

## Source

Changed: `packages/tui/src/routes/home.tsx`,
`packages/tui/src/component/prompt/index.tsx`,
`packages/tui/src/feature-plugins/prompt/footer.tsx`,
`packages/tui/src/theme/assets/v2/opencode.json`, and `packages/tui/test/theme.test.ts`.
Added: `packages/tui/src/component/prompt/shortcuts.tsx` and
`packages/tui/test/cli-design.test.tsx`.

The internal default theme key is retained for compatibility; its displayed name
remains Subi Code. Chromatic reference ramps remain available to V1 theme migration;
the default UI consumes the neutral semantic tokens and distinct gray categories.

An attempted shared dialog border was reverted after renderer tests showed width
and height regressions. The early prompt spacing and equal surface/category grays
were corrected instead of weakening existing tests. A later light-mode gray tint
was corrected after the new monochrome check caught it.

## Verification

The canonical root `bun run check` passes 36/36 tasks. New CLI design and theme
tests pass ten repetitions: 220 pass, zero failures, 940 assertions. The production
app fixture checks 100×30, 44×30, 32×26 and 44×18 terminal sizes; it edits `abc` to
`abXc` with the left arrow, exercises bracketed paste, verifies remapped shortcuts,
and preserves a saved Carbonfox/light configuration.

The final full TUI suite passes 1,507 tests, with 12 existing skips, zero failures,
across 180 files (172.13 seconds). The preceding complete run also passed 1,507
tests. Changed-file whitespace checks pass. No existing assertion was weakened or
test skipped to accommodate the redesign.

The built dev.17 executable passed actual Windows ConPTY checks in a private
profile: welcome and shortcut hints, Ctrl+X/M model menu, Ctrl+P commands, branded
settings and all six existing setting choices, plus resizing to 44×26. This did
not use the normal profile or make inference/billing calls. Other operating
systems and live account/provider/payment flows were not qualified by this work.

## Artifacts

Native executable:
`packages/cli/dist/subi-ui-release-20261019/cli-windows-x64-baseline/bin/subi.exe`.
Version: `subi v2.0.0-dev.17`.
SHA256: `AD683EC705284B9B218B311E1036A0C86CC98DD18D851FEFFE9DD02E7C8CCF7C`.

Local offline npm package:
`artifacts/2026-10-19/learnsmart-subi-cli-2.0.0-dev.17.tgz`.
SHA256: `E216484051792076D68FD4C6E4802BA3E4EA1EE1C1C5E28A624810F1E97C0065`.
It contains the qualified native binary, existing launcher signal/stdio handling,
and original license. It has no dependencies or install scripts.

The global `@learnsmart/subi-cli` package is updated offline to dev.17. The
installed native binary under
`C:\Users\Admin\AppData\Roaming\npm\node_modules\@learnsmart\subi-cli\bin\subi.exe`
matches the artifact hash above, and the normal PowerShell `subi --version`
command prints `subi v2.0.0-dev.17`. Close an older running CLI and run `subi` in
the project directory to see the new build. Installed extension/desktop packages
remain dev.16 for their later presentation phases.

Production-renderer cell captures, rendered to PNG for inspection:

- [Home](../artifacts/2026-10-19/cli-ui-preview/home.png)
- [Commands](../artifacts/2026-10-19/cli-ui-preview/commands.png)
- [Settings](../artifacts/2026-10-19/cli-ui-preview/settings.png)
- [32-column terminal](../artifacts/2026-10-19/cli-ui-preview/narrow.png)

These captures use a sample model catalog in the actual production TUI fixture.
They are not proof of a live authenticated account or provider inference.

## Backups and logs

Original changed-file baselines and the previous installed dev.16 CLI package and
npm shims were copied before replacement. They are in
`C:\Users\Admin\AppData\Local\Temp\subi2-20261019\cli-ui-before` and
`C:\Users\Admin\AppData\Local\Temp\subi2-20261019\install-cli-backup`.
External build/check/native/capture/package helpers and results are in that same
October 19 directory. The reused isolated suite runner writes these logs under
`C:\Users\Admin\AppData\Local\Temp\subi2-20261018`:

- `cli-ui-regressions-20261019.log` — 246 pass, 6 skip after the layout repair.
- `cli-ui-qualified-suite-20261019.log` — 1,507 pass, 12 skip, zero failures.
- `cli-ui-final-repeat-20261019.log` — 220 pass, zero failures.
- `cli-ui-release-suite-20261019.log` — final complete suite.
- `cli-ui-capture-final-20261019.log` — production-renderer capture fixture.

No repository commit was possible because this copy has no Git metadata. Preserve
the earlier broader NOT READY release verdict: completing this CLI design does
not qualify all integrations, operating systems or release recovery paths.
