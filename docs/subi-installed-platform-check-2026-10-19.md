# Installed platform check — October 19, 2026

This is an inventory and verification review, not another installation or a
claim of complete release qualification on every platform.

| Component | Current evidence | Status |
| --- | --- | --- |
| Windows x64 CLI | Global `subi --version` prints dev.25; MCP add help exposes URL/auth/client ID/scopes/global flags | Installed and current Windows checks pass |
| Windows VS Code extension | `learnsmart.subicode` 2.0.0 installed; extension.js matches qualified dev.25 VSIX; bundled CLI prints dev.25 | Installed; same code and binary as the passing native extension-host qualification |
| Windows desktop | Installed app archive matches dev.29; installed-profile and packaged-native results pass | Updated, installed and verified |
| Linux CLI/desktop/extension | Shared source and Linux targets exist; no Linux release binary/installer found in this workspace's artifacts | Native packaging and execution qualification outstanding |
| macOS CLI/desktop/extension | Shared source and Darwin targets exist; no macOS release binary/installer found in this workspace's artifacts | Native packaging and execution qualification outstanding |
| Other architectures | Source includes ARM64 targets; current installed and qualified artifacts are Windows x64 | Not qualified by these checks |

## Windows identity checks

Global CLI, VS Code bundled CLI and desktop bundled CLI all have SHA-256:
`E2C70F99A2BDCF5D047F54415D51E3F1EF553FCF971D6BA5370D68947186EFFD`.
That is the dev.25 executable used by the passing real local MCP and compiled
CLI interoperability check in the dev.29 qualification.

Installed desktop archive SHA-256:
`292DEA052C375F20FD89E01642B4B8F576A9AC010F60B58B0627FF53F8F588B3`.
It matches the installed dev.29 report.

Installed VS Code `dist/extension.js` SHA-256:
`7EDB84AC2BF4A5C983719B3863A728B3C9D2AA47EE613F467D0765A6E328F8CB`.
It matches the entry in
`artifacts/2026-10-19/mcp-dev25/subicode-2.0.0-win32-x64-dev25.vsix`.
The retained native host result passes commands, bundled executable launch and
terminal reuse. This check verified artifact identity; it did not repeat that
native extension-host run.

The VS Code integration opens the SubiCode CLI in an editor terminal. It does
not embed the desktop renderer. The new desktop MCP modal therefore does not
replace the CLI's MCP dialog; CLI Ctrl+A/add and Ctrl+R/refresh remain its UI.

## Remaining work and findings

- Current global CLI npm package declares Windows/x64 only. The installed VSIX
  contains only `bin/win32-x64`. Platform selection/fallback code exists in the
  extension, but other native binaries must still be built and packaged.
- Desktop packaging declares macOS DMG/ZIP and Linux AppImage/DEB/RPM targets.
  Those declarations and shared UI code are not evidence of native execution.
- The local WSL check reports that Windows Subsystem for Linux is not installed.
  No Linux runtime test was possible through WSL. No macOS host was used.
- Existing CI definitions contain Windows/Linux jobs; this inspection does not
  establish that those jobs ran successfully for this local SubiCode source.
- VS Code also has `learnsmart.subi@0.1.0` and `sst-dev.opencode@1.0.0` installed
  alongside `learnsmart.subicode@2.0.0`. They are separate older integrations.
  This audit did not remove or disable them.
- Complete native builds, installation/startup and feature checks on Linux and
  macOS, plus other intended architectures, before calling all platforms ready.

Latest Windows UI verification: 23 production keeper cases pass; canonical
lint/type check passes 36 tasks; packaged native and installed-profile checks
pass with no renderer errors. These checks do not constitute exhaustive testing
of every provider, account entitlement, plugin or operating system.

See [session Add MCP report](subi-session-add-mcp-2026-10-19.md) and
[MCP qualification](subi-mcp-connections-2026-10-19.md) for the retained test scope.
