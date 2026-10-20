# SubiCode in-session Extensions design — October 19, 2026

The session details/Extensions flyout in the user's screenshot used independent
styling and had not picked up the earlier shell and Settings redesign.

## Changes

The shared GUI extension now uses a single outlined details surface, a divider
between project and extension controls, aligned disclosure indicators and more
consistent row spacing. MCP, Plugins, Skills and LSP popovers use matching theme
surfaces, borders, corners, list headings and configuration footers. Empty,
loading, failed and configured states retain their existing implementations.
Narrow screens continue to use one drawer with back navigation, without nesting
desktop popovers inside it. Theme selection remains available.

Production source change: `packages/gui-extensions/src/details/details.css`.
No action handlers, authentication, connection APIs, persisted preferences or
session execution code changed.

## Verification

- Canonical `bun run check`: all 36 tasks successful.
- Production web and Electron builds completed. The first desktop invocation
  correctly rejected a missing local CLI distribution; the build was rerun
  with the existing qualified dev.25 distribution.
- Session summary and mobile extension keeper suites: 19/19 pass in the final
  complete run. Coverage includes disclosure persistence, shortcut ownership,
  project/worktree navigation, LTR/RTL placement, cached refresh, loading/errors,
  MCP toggle hit areas, authentication and remote configuration-path copying.
- Production visual checks: dark wide, light wide, dark narrow and light mobile,
  with all four extension menus and focus return: 4/4 pass, no page errors.
- The initial keeper run passed 16 and failed three because it used old storage
  keys/tab seeding. The tests now use the existing shared seed helper and read
  current SubiCode preference keys. Mobile theme seeding was corrected too.
- Explicit lint of the two touched test files: zero warnings/errors.
  `lint:changed` cannot resolve a base ref in this copied repository, which has
  no usable Git base. Its error log is retained; canonical lint/check passed.

- Packaged native recheck: pass, zero renderer errors. It covers Build/Plan,
  twelve Settings pages, themes, account navigation, real local MCP save/tools/
  disconnect/reconnect/refresh/removal and a compiled CLI addition reflected in
  the GUI. An empty session was created in a private profile, without inference,
  to check all four in-session extension menus and configuration actions.
- The first private native check stopped because its Skills assertion expected
  an empty list; the real service discovered configured skills. The recheck
  compares that menu against the actual service inventory instead.
- Installed normal profile: pass, frontend 2.0.0-dev.28, title SubiCode, no
  renderer errors. All four extension menus, configuration controls, focus
  return, twelve Settings pages, account navigation and MCP form/API passed.
  Twelve saved tasks were found; reopening, search and Commands passed. The
  existing dark theme was preserved. The app is left on the Extensions panel.
- Windows installer completed; installed executable, archive and bundled CLI
  hashes match the packaged build. The installer exit code was not captured.
  The first installed probe asserted a literal 1px computed border; Windows
  at 125% display scaling reports 0.8px. The corrected probe checks a visible
  border and the intended panel width; no production change was needed.

## Installed package hashes

| File | SHA-256 |
| --- | --- |
| SubiCode.exe | E2268910D0BDC0640D59D4285E66DB0990E813077EE90A411F4D956856821402 |
| resources/app.asar | D7FFD7B05F9D048CBB80552C3110A0F7794708BCB930AF765C244F72DB789EF5 |
| resources/opencode-cli.exe | E2C70F99A2BDCF5D047F54415D51E3F1EF553FCF971D6BA5370D68947186EFFD |

Installed at `C:\Users\Admin\AppData\Local\Programs\subicode-desktop\SubiCode.exe`.

Screenshots: [Installed panel](previews/subicode-session-extensions-installed.png),
[dark MCP menu](previews/subicode-session-extensions-dark.png),
[light details](previews/subicode-session-extensions-light.png),
[mobile drawer](previews/subicode-session-extensions-mobile.png).

## Distribution scope

Frontend target: 2.0.0-dev.28; qualified bundled CLI remains 2.0.0-dev.25.
This is the app's built-in Extensions/details UI, not a replacement of the CLI
terminal design or VS Code extension. Windows, macOS and Linux use the same
updated renderer. Native macOS/Linux installation and testing need those hosts.

Artifacts: `artifacts/2026-10-19/extension-ui-dev28/desktop`.
Backups, raw test failures, traces and checks:
`C:\Users\Admin\AppData\Local\Temp\subi2-20261019\extension-ui-dev28`.
