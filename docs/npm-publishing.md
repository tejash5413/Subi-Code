# Publishing the SubiCode CLI to npm

The public command is `npm install -g @subicodeagent/subi-cli`. It becomes available only after the packages below have actually been published. Browser sign-in, a GitHub commit, and a locally installed tarball do not publish a package.

## Packages

`sdks/npm` contains the public Node.js launcher. Its six optional dependencies contain the real SubiCode executable for Windows, macOS and glibc-based Linux, each on x64 and ARM64:

```
@subicodeagent/subi-cli-win32-x64
@subicodeagent/subi-cli-win32-arm64
@subicodeagent/subi-cli-darwin-x64
@subicodeagent/subi-cli-darwin-arm64
@subicodeagent/subi-cli-linux-x64
@subicodeagent/subi-cli-linux-arm64
```

All seven packages use the same exact version. npm chooses the compatible native package using its OS and CPU metadata; the launcher forwards arguments and exit codes. No postinstall script downloads an executable. Optional dependencies must remain enabled. Node.js 22 or newer is required.

## Build and qualify

1. Run the source checks and npm launcher tests (`npm test` from `sdks/npm`).
2. Push the candidate to `dev` to run **SubiCode native packages**. The workflow builds production-channel binaries on all six native hosts and tests a clean global npm installation through a disposable loopback registry. It also runs the desktop and extension checks separately.
3. Inspect all six `subicode-npm-<platform>` artifacts. Each contains a native tarball, the public launcher tarball, and `packages/qualification.json`. A successful npm qualification is required for every target, even if later desktop tests fail.
4. Keep the candidate source commit unchanged for publication. Qualifications record that commit and the tarballs' SHA-512 integrity. Launcher text is normalized to LF. Windows and Unix archive permissions differ, so preflight also compares the exact contents of all four launcher files across hosts.

Local preflight, with the six artifact folders arranged under `artifacts/npm`, is read-only:

```sh
node script/publish-subicode-npm.mjs artifacts/npm
```

Preflight rejects missing or failed qualification, a development channel, wrong versions, changed tarballs, and inconsistent launchers. In GitHub Actions it also requires the qualification's source commit to match the publishing commit.

## Authenticate and publish

The publishing account is **subicodeagent**, which owns the `@subicodeagent` user scope. Use that account, or a maintainer with publishing permission for all seven packages. No npm organization is required.

Use a current npm 11 client for interactive publishing with browser-based security-key approval. Installation of SubiCode itself still supports Node.js 22 or newer. If the current npm executable is installed separately from Node's bundled npm, set `SUBICODE_NPM_CLI` to its `npm-cli.js` path before running the publisher.

```sh
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
```

For CI, configure npm trusted publishing for this repository and `.github/workflows/subicode-npm-publish.yml`, or provide an appropriately scoped npm publishing credential as the repository's `NPM_TOKEN` Actions secret. Never commit a token or paste it into an issue, log, or chat. First-time package creation may need an authenticated maintainer before trusted publishing can be configured.

Dispatch **Publish verified SubiCode npm CLI** at the same commit used by the native workflow, supplying that native workflow's run ID. The manual publishing workflow downloads the six npm artifacts and runs preflight before publishing. It publishes native packages first and the public launcher last. An existing identical version is skipped; an existing version with different contents stops publication. Published package versions cannot be overwritten.

An authenticated local maintainer can run the same ordered publisher against downloaded, verified artifacts:

```sh
node script/publish-subicode-npm.mjs artifacts/npm --publish
```

## Verify the public result

```sh
npm view @subicodeagent/subi-cli@2.0.0 version --registry=https://registry.npmjs.org/
npm install -g @subicodeagent/subi-cli@2.0.0
subi --version
subi mcp add --help
```

Repeat installation on each supported native platform before announcing that platform as available. Update the website's install link only after the registry result is verified. npm CLI publication does not publish desktop installers or the VS Code extension, and it does not qualify paid-provider, billing, or device-pairing workflows.
