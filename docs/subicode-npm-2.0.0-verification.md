# SubiCode npm 2.0.0 verification

Publication status: **all seven packages published and registry checksums verified**, 20 October 2026.

The requested public package is `@subicodeagent/subi-cli`, published by the authenticated `subicodeagent` npm account. It uses the matching native optional dependency for Windows, macOS, or glibc-based Linux on x64 or ARM64.

## Qualified candidate

- Binary and launcher source: `ebd13e6c55aa0f93c1809d4aeb9cd8d1021f13c0`.
- [Native build and npm installation checks](https://github.com/tejash5413/Subi-Code/actions/runs/39372919041).
- [Full source checks](https://github.com/tejash5413/Subi-Code/actions/runs/39372634259).
- All six native CLI version/MCP checks and clean npm global installations passed on their native hosts.
- Windows x64 also passed a clean install using the Unix-packed public launcher that will be published.
- The publication preflight validates each archive's SHA-512 integrity, production channel, source commit, version, native qualification and npm installation qualification. The public launcher's four file contents match across all six builds. Platform-specific tar executable permission differences are allowed; different launcher file contents are rejected.
- Publication-control changes have four passing launcher/publication tests and all 36 canonical source checks passing locally.

## Publication and installation

All six native packages and `@subicodeagent/subi-cli@2.0.0` are public with `latest` set to 2.0.0. Public registry SHA-512 integrity values match the qualified archives for every package, including the Unix-packed public launcher.

The public launcher was installed on Windows x64 after removing the older local `@learnsmart/subi-cli` launcher that occupied the same `subi` command. `subi --version` reported `subi v2.0.0`; `subi mcp add --help` passed. The installed native executable SHA-256 is `ee1b4251c49641c45d6736ee999cfc2eb4f09fc49ba1d940a35a97b4ce95fb67`, matching qualification.

```sh
npm install -g @subicodeagent/subi-cli@2.0.0
subi --version
```

The account holder completed npm 11 browser approvals. Some uploads encountered connection resets or an expired approval; resuming skipped already published identical packages. Processing finished before availability and checksum verification were recorded. No recovery code was used.

Desktop installers, the VS Code Marketplace listing, live account billing, provider access, signing/notarization, and real-device pairing have separate release gates. This npm verification does not qualify those workflows.
