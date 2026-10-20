# Add MCP connection from a session — October 19, 2026

The in-session MCP menu now offers **Add MCP connection** in both empty and
configured lists. It opens the same App name, MCP server URL, Authentication
and advanced OAuth form used by Settings.

The form is shared through a host-independent UI component. The session action
targets the session's server and saves a durable server-wide MCP configuration,
then runs connection discovery and the existing browser sign-in flow when
needed. This also works for remote servers and the mobile details drawer.
Existing MCP switches use the same connection/sign-in helper.

## Verification

- The new keeper failed against the previous production bundle because
  Configuration file was still shown in the MCP menu.
- Final production keeper run: 23/23 pass. Includes desktop/local and
  mobile/remote Add MCP flows, browser sign-in, visibility in another session,
  existing MCP switch/authentication/refresh behavior, disclosures, placement,
  and the Settings form's save/edit/remove/validation/sign-in contracts.
- Canonical root check: 36 tasks successful. The first lint invocation exhausted
  its allocator while another lint process was running; the subsequent complete
  root check passed. All raw logs remain available.
- Explicit lint of all five touched TypeScript files: zero warnings/errors.
- Production web and Electron builds completed successfully.
- Visual checks initially reproduced the existing fixed-height form clipping its
  footer in all three cases. The shared form now fits the viewport, scrolls its
  fields and keeps its footer visible. The owning Add keeper asserts button
  visibility before submission. Both the final 23-case run and the three-case
  dark/light desktop/mobile visual run pass after this change, including
  expanded advanced OAuth fields.

- Packaged native check: pass, no renderer errors. Added a connection from an
  empty session's MCP menu using the shared form, saved it to the real local
  service, connected it and discovered its `lookup_docs` tool. The test also
  passed the existing Settings MCP controls, compiled CLI interoperability,
  Build/Plan and all twelve Settings pages in an isolated profile.

- Installed normal-profile check: pass, frontend 2.0.0-dev.29, title SubiCode,
  no renderer errors. The session menu opens the form directly, all fields are
  editable, Automatic authentication is selected and Save and connect is in
  the viewport. Cancel/focus return, all four extension menus, twelve Settings
  pages, account navigation, MCP form/API, saved-task reopening/search and
  Commands pass. Existing theme and twelve saved tasks are preserved. The
  blank Add MCP connection form is left open for the user; no connection was
  created in the normal profile.
- Installer exit: 0. Installed executable, application archive and bundled CLI
  hashes match the package. The superseded pre-layout package job was stopped
  and its log retained; only the final rebuilt package was installed.

## Installed package identity

| File | SHA-256 |
| --- | --- |
| SubiCode.exe | D25D7E836876D7E998461FD74B15BFA59ABBEE92DB2582ABD4261792E8A71AEF |
| resources/app.asar | 292DEA052C375F20FD89E01642B4B8F576A9AC010F60B58B0627FF53F8F588B3 |
| resources/opencode-cli.exe | E2C70F99A2BDCF5D047F54415D51E3F1EF553FCF971D6BA5370D68947186EFFD |

Installed executable:
`C:\Users\Admin\AppData\Local\Programs\subicode-desktop\SubiCode.exe`.

Screenshots: [installed form](previews/subicode-session-add-mcp-installed.png),
[dark form](previews/subicode-session-add-mcp-dark.png),
[light form](previews/subicode-session-add-mcp-light.png),
[mobile form](previews/subicode-session-add-mcp-mobile.png),
[advanced mobile fields](previews/subicode-session-add-mcp-advanced.png).

## Source and scope

- `packages/ui/src/forms/remote-mcp-connection-form.tsx`: shared form and
  validation, using translated labels and callbacks.
- `packages/app/src/settings/providers/mcp-form.tsx`: Settings wrapper retains
  the existing labels, close behavior and save callback.
- `packages/gui-extensions/src/details/server-panel.tsx`: direct Add action and
  shared connection/sign-in operation, with extension-lifetime checks.
- `packages/gui-extensions/src/details/i18n/en.ts`: English source copy for the
  extension's form; other languages use the existing fallback.
- `packages/app/e2e/regression/session-summary.spec.ts`: owning keeper coverage.

Frontend target: 2.0.0-dev.29; bundled CLI remains qualified dev.25. Windows,
macOS and Linux use this shared renderer. Native macOS/Linux qualification
requires those hosts. CLI and VS Code installations are unchanged by this
in-app action. No hosted deployment, paid inference or real external account
sign-in was performed.

Artifacts: `artifacts/2026-10-19/mcp-shortcut-dev29/desktop`.
Logs, traces, helpers and original-file backups:
`C:\Users\Admin\AppData\Local\Temp\subi2-20261019\mcp-shortcut-dev29`.
