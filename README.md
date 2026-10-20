<p align="center"><img src="assets/brand/subi-code-mark-transparent.png" width="100" alt="SubiCode logo"></p>

# SubiCode 2.0

**One coding agent for your terminal, editor and desktop.** Plan changes, edit project files, run checks and review the result with SubiCode.

[Website](https://stlearnsmart.in/subi-code) · [Documentation](https://stlearnsmart.in/subi-code/docs) · [Downloads](https://github.com/tejash5413/Subi-Code/releases) · [Support](https://stlearnsmart.in/contact)

## Release status

The product version is **2.0.0**. This repository contains the complete SubiCode 2.0 source, replacing the earlier extension-only project. `main` contains the integrated source; ongoing development happens on `dev` and focused feature branches.

**A source commit is not a published stable release.** Download only assets attached to a tagged release. If no matching asset is listed, that platform is not yet available. Development and unsigned CI packages are intended for qualification.

| Interface | Targets | Qualification status |
| --- | --- | --- |
| CLI | Windows, macOS, Linux; x64 and ARM64 | All six native npm installation checks passed; public registry publication and availability verification in progress |
| VS Code extension | Platform-specific VSIX for the same six targets | Windows x64 2.0.0 installed; native host and terminal reuse passed; other targets pending CI |
| Desktop | Windows installer, macOS DMG/ZIP, Linux AppImage/DEB/RPM | Windows x64 2.0.0 installed and startup verified; unsigned; other native targets pending CI |
| Mobile browser | Connect to a running computer through device pairing | Real-device verification pending; no standalone mobile installer |

See the [Windows 2.0.0 verification](docs/subicode-windows-2.0.0-verification.md) for current evidence and the [release readiness audit](docs/subicode-release-readiness-2026-10-20.md) for remaining release gates. Live account billing, provider permissions, signing and native platform checks are separate from source type checks.

## What is included

- **Plan and Build:** inspect a task before making changes, then edit files and run tools with permission controls.
- **Project context:** reference files, inspect changes, use terminal commands and return to saved sessions.
- **Providers and models:** connect your own supported provider or use models assigned to your LearnSmart account. Availability depends on provider access, account permissions, limits and credits.
- **MCP connections:** add an app name and server URL, connect local servers, and sign in through a browser when supported by the server.
- **Plugins and skills:** manage extensions and reusable instructions through the app or CLI. Install only packages and servers you trust.
- **Personal settings:** themes, appearance, shortcuts, notifications, projects, worktrees and server preferences.
- **Device pairing:** connect another device to your computer's running SubiCode server. The host must remain available.

Provider-hosted free models may be restricted to that provider's own client. Inclusion in a model list does not grant access; SubiCode does not bypass those restrictions.

## Install a published package

1. Open [GitHub Releases](https://github.com/tejash5413/Subi-Code/releases) and read the release notes.
2. Select your operating system and CPU architecture. Verify the supplied SHA-256 checksum when available.
3. **Desktop:** run the matching Windows installer, open the macOS package, or install the Linux package.
4. **VS Code:** use **Extensions → … → Install from VSIX**, then choose the matching VSIX. Open the Command Palette and run **Open Subi Code**.
5. **CLI:** install the matching packaged npm tarball with Node.js available:

```sh
npm install -g /path/to/downloaded-subicode-cli-package.tgz
subi --version
cd /path/to/your/project
subi
```

The CLI tarball contains a native executable; use the package for your OS and CPU. These instructions do not imply an npm registry or Marketplace publication. Those links will be added when publication is verified.

The public `npm install -g @subicodeagent/subi-cli` launcher and six native packages are prepared under [sdks/npm](sdks/npm). All six native installation checks passed. Registry publication and availability verification are in progress; see the [npm verification record](docs/subicode-npm-2.0.0-verification.md). Maintainers should follow the [npm publishing guide](docs/npm-publishing.md).

## First session

Open a project folder, start SubiCode, connect a provider or your LearnSmart account, and choose an available model. Use **Plan** to inspect the work, then **Build** to make changes. Review tool permission requests and the final diff before accepting work.

The VS Code extension can open the CLI in an editor terminal and insert a file reference from the active editor. Its Command Palette actions remain available if your OS reserves a shortcut. See the [extension guide](sdks/vscode/README.md).

For MCP, plugins and skills, open **Settings → Extensions** in the app or inspect the CLI commands:

```sh
subi --help
subi mcp --help
subi mcp add --help
```

Full user guides: [installation](https://stlearnsmart.in/subi-code/docs#installation), [models](https://stlearnsmart.in/subi-code/docs#models), [MCP](https://stlearnsmart.in/subi-code/docs#mcp), [plugins](https://stlearnsmart.in/subi-code/docs#plugins), [skills](https://stlearnsmart.in/subi-code/docs#skills), [settings](https://stlearnsmart.in/subi-code/docs#settings).

## Develop from source

Requirements: Git, **Bun 1.4.2** (as pinned in `package.json`), Node.js 24 and the native build tools required by your OS.

```sh
git clone --branch dev https://github.com/tejash5413/Subi-Code.git
cd Subi-Code
bun install --frozen-lockfile
bun run dev
```

To run the desktop development app:

```sh
bun run dev:desktop
```

Build native CLI, VSIX and desktop packages **on the target OS and CPU**:

```sh
# macOS / Linux qualification build
OPENCODE_VERSION=2.0.0 OPENCODE_CHANNEL=prod bun run packages/desktop/scripts/distribute.ts
```

```powershell
# Windows PowerShell qualification build
$env:OPENCODE_VERSION = "2.0.0"
$env:OPENCODE_CHANNEL = "prod"
bun run packages/desktop/scripts/distribute.ts
```

Output: `artifacts/platforms/2.0.0/<platform>/`. Qualification builds are unsigned. Production signing and publication require a separate approved release process. Internal package names and environment variables retained for backend compatibility are not product display names.

## Verify changes

```sh
bun run check
cd packages/app
bun run typecheck:e2e
bun run test:unit
```

Run other tests from the affected package; the root test command intentionally rejects running all tests there. Native packaging and extension/desktop qualification run in the [SubiCode workflows](https://github.com/tejash5413/Subi-Code/actions). A successful type check alone does not qualify a platform.

## Repository map

| Path | Purpose |
| --- | --- |
| `packages/cli`, `packages/tui` | CLI entrypoint, local service and terminal UI |
| `packages/app`, `packages/desktop` | Shared app UI and Electron desktop shell |
| `sdks/vscode` | VS Code extension |
| `packages/core`, `packages/server` | Agent behavior, persistence and server |
| `packages/client`, `packages/protocol`, `packages/schema` | Client and shared API contracts |
| `integrations/learnsmart` | LearnSmart backend integration source |
| `assets/brand` | SubiCode logo and icon assets |
| `docs` | Development, migration and verification records |

The LearnSmart public website is maintained in a separate project and is not deployed by these workflows.

## Branches and releases

Create a focused branch from `dev`, open a PR back to `dev`, run checks and review. Promote a tested candidate from `dev` to `main`, then tag and publish the verified packages with checksums and release notes. Do not force-push shared branches or publish unqualified platform assets.

[Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) · [Release process](docs/RELEASING.md) · [Security](SECURITY.md)

## License and acknowledgements

SubiCode is developed by LearnSmart and includes software derived from OpenCode and other open source projects. The [MIT license](LICENSE), upstream copyright and third-party notices are retained. Historical upstream documents are under [docs/upstream](docs/upstream); they are reference material, not SubiCode installation instructions.
