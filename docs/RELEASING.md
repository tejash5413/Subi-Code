# Releasing SubiCode 2.0

## Agreed sequence

1. Import the complete source into a separate checkout on dev; preserve the old checkout and remote history.
2. Replace release-facing documentation and quarantine upstream automation.
3. Run source checks; build and qualify the current Windows CLI, VSIX and desktop installer.
4. Commit and push dev. Run native platform CI and resolve actual failures.
5. Review dev → main after qualification. Publish a tagged release with verified assets and SHA-256 checksums; only then enable matching website download links.

## Gates

- Canonical check, E2E TypeScript and relevant package tests pass for the candidate commit.
- Every claimed platform has a matching native CLI, VSIX, desktop package and successful qualification record.
- CLI starts, extension launches/reuses its terminal, desktop starts its server, and Plan/Build plus settings/extension forms work.
- Real account/provider, billing permissions and mobile pairing are verified separately before claiming those workflows are production-qualified.
- Signing/notarization and installation experience are checked; unsigned artifacts are identified explicitly.
- No secrets, personal profiles, logs, build trees or node_modules in Git. Preserve licenses and notices.
- Release notes name limitations and provide matching assets/checksums. Never substitute upstream OpenCode installers.

## Native candidate builds

Set OPENCODE_VERSION=2.0.0 and OPENCODE_CHANNEL=prod, then run `bun run packages/desktop/scripts/distribute.ts`. This builds for the current host architecture. Run `node packages/desktop/scripts/qualify-distribution.mjs artifacts/platforms/2.0.0/<platform>` (use xvfb-run on Linux).

The native workflow creates unsigned qualification artifacts and does not itself publish a release. It runs on push to dev and can be dispatched when present on the default branch. All six targets must be checked before claiming all-platform support. npm CLI publication is a separate manual workflow with native installation and checksum gates; see [npm publishing](npm-publishing.md).

The VS Code extension uses product version 2.0.0 for this requested local release installation. An existing installation with a higher development extension version requires an explicit forced VSIX install. Marketplace publication must follow that marketplace's monotonic version rules rather than silently downgrading a published listing.

## Automation boundaries

Active workflows under .github/workflows belong to SubiCode. Imported upstream deployment/publishing workflows are retained as inert reference files under .github/upstream-workflows. They must not be reactivated without review. No workflow deploys the separate LearnSmart website.

The latest audit is [release readiness](subicode-release-readiness-2026-10-20.md). A product version label is not evidence of release qualification.
