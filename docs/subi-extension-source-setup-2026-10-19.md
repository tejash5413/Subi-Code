# Plugin and skill setup execution record

Plan: docs/superpowers/plans/2026-10-19-plugin-skill-setup.md

Tasks 1–4 implemented inline in the existing checkout; no Git metadata is present.

The approved in-chat design is the specification. Global source patches share the existing config update lock and JSONC editor. GUI Settings and session details share one form. CLI uses the same typed patch endpoint. Generation ran after the public schema change.

Ruling: local plugins use package names or plugin folders, matching the existing loader; arbitrary individual plugin files are not supported. Cost if wrong: the source remains configured but cannot load; the form explicitly requests a folder.

Ruling: Add plugin uses Ctrl+O because Ctrl+N is reserved for list navigation. Cost: the shortcut differs from the initial draft; existing internal plugin and update shortcuts stay usable.

Initial verification: server config keeper 5/5 (including real local plugin/skill activation and removal without restarting), plugin CLI keeper 5/5, skill CLI keeper 1/1, MCP CLI keeper 4/4. Final check and packaging results are recorded below.

Windows development environment only. Shared implementation covers macOS/Linux; native qualification there requires those hosts.

Verification update: client editable-source boundary/import checks 2/2; final CLI keepers 10/10; Settings keepers 3/3 (plugin dark, skill narrow/light, existing MCP); session setup keepers 2/2 (desktop local and mobile remote). The browser used installed Chrome with video off because the pinned Playwright browser/ffmpeg are unavailable locally. A disposable server was recreated after a build invalidated its startup-cached index; no user app or managed service was restarted for debugging.

The old configure-file action is retained for LSP only. Plugin/skill additions in project Settings explicitly save global sources on that selected server. Existing per-project and automatically discovered sources remain visible and are not removed by these global controls.

Final source checks: canonical root check passed all 36 tasks, with existing lint warnings and no errors. Final server keeper passed 5/5, 47 assertions, including a fresh server opening the persisted plugin and skill sources. Final server typecheck passed. Extension test host compiled successfully. The native package workflow default is updated to dev.35 for all six host/architecture jobs.

Usage: Settings → Extensions → Plugins or Skills → Add plugin/Add skill. Both tabs offer configured-source edit/remove/refresh and show available inventory separately. Session details offers the same Add actions. CLI: `/plugins`, then Ctrl+O; `/skills`, then Ctrl+A. Plugin JSON settings must be an object. Use a plugin package name or folder with a supported server/index entrypoint, and a skill folder or collection URL providing index.json. Saves are global on the selected server.

## Installed Windows qualification

Built and installed CLI/desktop **2.0.0-dev.35** and VS Code extension **2.0.5**. CLI global install, forced VSIX install and silent desktop installer all exited successfully. `subi --version` reports dev.35 and VS Code lists `learnsmart.subicode@2.0.5`.

Artifacts: `artifacts/platforms/2.0.0-dev.35/win32-x64/`. The package qualification record is `packages/qualification.json` beneath that directory. Native disposable-profile qualification passed startup, Build/Plan, all twelve Settings pages, MCP setup, real local plugin and skill activation/removal, and extension startup with terminal reuse.

Installed CLI, extension bundled CLI and desktop sidecar SHA256 all match the tested executable: `565835603AD0244AB20E95B0590D8C8505F287E100F2CF6D06639EB69DFB8FE7`. Installed desktop `resources/app.asar` matches the packaged file: `8D3BAEACD7022DC9F5B5A7CD13DB3FEE72EC8A5BC76D642721CC59D2A4C1C21E`.

Normal installed profile checks passed with no page errors: both forms open from Settings and session details, fields are editable, save buttons are visible, all twelve Settings sections are accessible, and the checked Settings/forms contain no OpenCode branding. All 15 recent tasks remained visible and the `nightowl` / `dark` theme was preserved. Account and credits remained accessible. Forms were cancelled without adding sources to the user's profile. Both installed form screenshots were visually inspected.

Detailed logs, installed screenshots and `installed-result.json`: `C:/Users/Admin/AppData/Local/Temp/subi2-20261019/platform-dev35/`. Root check log: `C:/Users/Admin/AppData/Local/Temp/subi2-20261019/extension-setup-final-check2.log` (36 successful tasks).

macOS/Linux share these source changes and the extension bundles the same CLI implementation, but native non-Windows packaging, installation and execution remain unverified on this Windows host. This feature qualification does not establish full release readiness or compatibility with every third-party plugin.
