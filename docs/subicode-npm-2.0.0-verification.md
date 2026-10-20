# SubiCode npm 2.0.0 verification

Publication status: **pending registry verification**.

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

The six native packages must be published before the public launcher. A successful registry lookup and a clean public-registry global installation are still required before announcing the install command as available.

The initial publish attempt with npm 10 was rejected because publishing required 2FA. npm 11.21.1 provides the interactive browser approval flow. After the account holder approved that flow, npm accepted `@subicodeagent/subi-cli-win32-x64@2.0.0` for processing. The remaining native packages and public launcher are still pending. No recovery code is required by this workflow.

Desktop installers, the VS Code Marketplace listing, live account billing, provider access, signing/notarization, and real-device pairing have separate release gates. This npm verification does not qualify those workflows.
