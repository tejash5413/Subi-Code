# SubiCode MCP connections — 19 October 2026

The MCP connection feature lives in the shared backend and clients. Windows qualification uses `2.0.0-dev.25`. The subsequent Settings redesign is a preview awaiting the user's approval; it has not been applied to production Settings.

## Behavior

- Settings → Extensions → MCPs: Add MCP connection, App name, HTTP/HTTPS URL, save, connect, optional browser sign-in, status, available tools, refresh, edit, reconnect, disconnect and remove.
- New remote connections use automatic OAuth discovery/registration where supported. Advanced settings accept a provider-approved SubiCode Client ID and scopes. Editing can retain existing authentication.
- Global configuration updates retain unrelated settings, JSONC comments, hidden headers and OAuth credentials. Edits target the owning global document; removal deletes every global definition of the name. Connections survive a server restart.
- MCP protocol initialization and new OAuth dynamic registrations identify SubiCode. No upstream OpenCode client metadata identity is used for new dynamic registrations. Services that require preapproved registrations still need their own SubiCode Client ID.
- Read-only tool discovery has a shared `/api/mcp/tool` endpoint and a regenerated client SDK. It lists tool metadata without executing a tool.
- Terminal MCP dialog: Ctrl+A adds an app name and URL, Ctrl+R refreshes. Existing authentication and connection-error investigation remain available.
- CLI: `subi mcp add <name> --url <url> --global --auth`, with optional `--client-id` and `--scope`. Open servers connect without unnecessary OAuth; protected servers enter the existing browser authorization flow.
- Global CLI additions use durable config rather than a runtime override, so the same connection can subsequently be edited or removed from Settings. Project additions retain existing project configuration semantics.
- Existing plugins and skills remain integrated. Their backend lifecycle tests and Settings tabs were checked. This feature does not introduce a plugin marketplace or a new plugin installation UI.

## Verification

- Final canonical root check passed, 36 tasks. The corrected CLI also passed its package type check and four CLI keeper cases, including a real open MCP endpoint with `--auth`.
- Core MCP/plugin/failure suite: 94 passed, one existing skip, zero failures.
- Core OAuth: 21 passed, including SubiCode DCR metadata, callback exchange and registration reuse.
- HTTP configuration keeper: three passed, including durable restart, preservation of secrets/comments/shell and removal; tool metadata endpoint checked.
- Terminal MCP keeper: 40 passed across ten repetitions, including keyboard add/save, existing sign-in and connection-error investigation.
- Browser: eight existing MCP routing/auth/list cases passed; the new connection CRUD and OAuth/status/tool refresh cases plus slow-loading Extensions keeper passed in the focused final run (three cases).
- Packaged desktop with a real local MCP endpoint: add, tool discovery, disconnect, reconnect, refresh and remove passed, with no renderer errors. A compiled CLI then added another global connection to the same private service, and desktop successfully discovered and removed it. Build/Plan switching and SubiCode title also passed.
- Native VS Code host qualified the packaged extension, bundled CLI launch and terminal reuse. Installed binary hashes are recorded separately.
- Settings preview: all twelve navigation pages and extension subtabs checked at desktop and narrow widths, no page errors. Preview contains sample presentation data and does not change the user's settings, accounts or credits.

The first native test exposed a CLI race: an initial asynchronous MCP handshake was interpreted as requiring OAuth. The correction waits for durable discovery and the explicit connection boundary before deciding whether sign-in is needed. The failed dev.24 native log is retained; the corrected compiled flow passed.

## Cross-platform scope

The app frontend is shared by desktop and web clients; terminal and backend changes are shared by Windows, Linux and macOS CLI builds. The VS Code integration launches the same CLI. Native macOS/Linux installers and execution require those hosts and are not qualified by Windows checks. No hosted deployment, credit purchase or paid inference was performed.

## Qualification evidence

Logs and private fixtures: `C:/Users/Admin/AppData/Local/Temp/subi2-20261019/mcp-connections/`.

Release artifacts: `artifacts/2026-10-19/mcp-dev25/`.

CLI SHA256: `E2C70F99A2BDCF5D047F54415D51E3F1EF553FCF971D6BA5370D68947186EFFD`.

The app keeps its existing application ID and storage locations, preserving account/model/credit state.

## Installed Windows copies

- Desktop installer completed with exit code 0. Installed EXE, app.asar and bundled CLI hashes match the qualified dev.25 package.
- Desktop: `C:/Users/Admin/AppData/Local/Programs/subicode-desktop/SubiCode.exe`.
- Desktop and Start menu shortcuts both use `SubiCode`, point to that executable, and launch a normal window.
- Global CLI prints `subi v2.0.0-dev.25`.
- VS Code installed the dev.25 VSIX successfully. Its bundled CLI hash matches both the native build and global CLI. The packaged dev.25 extension passed the native host tests.
- The final packaged dev.25 desktop passed the real local MCP/compiled CLI flow with no renderer errors. The installed normal-profile app then passed its tools API and add-form checks and was left open on Extensions → MCPs. No connection was added to the normal profile by the check.
- The running local service's authenticated `/api/info` confirms `2.0.0-dev.25`.
- Installed EXE SHA256: `7A60CF937E0827393E2FE2F2F274C2FAB0EADF7E129F4BD87400FB035B29EEF2`.
- Installed app.asar SHA256: `3178DCAE830299666CEC5237118A0F9FEA61BDBF007D45FFCF1F3CE3E0143A2B`.

Reopen existing CLI terminals/extension terminals to run the new executable. The desktop update is already open. Linux/macOS source is updated; native installers remain untested on those platforms.
