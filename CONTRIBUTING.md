# Contributing to SubiCode

Start from the `dev` branch and create a focused branch. Submit pull requests to `dev`; release promotion to `main` happens after validation.

Read [AGENTS.md](AGENTS.md) and any package-specific instructions. Use conventional commit messages such as `fix(desktop): recover local server startup`. Preserve protocol compatibility, user data and license notices.

Use Bun 1.4.2 and Node.js 24. Install with `bun install --frozen-lockfile`. Run `bun run check` from the root and relevant tests from package directories. UI changes need checks in light/dark themes and narrow/wide layouts; desktop and extension changes need native qualification on affected platforms.

Never commit credentials, personal profiles, node_modules, installers or compiled executables. Release assets belong in GitHub Releases. Do not deploy LearnSmart services or change live account/billing data as part of a local test.

See [README](README.md) for development commands and [the release process](docs/RELEASING.md) for packaging gates.
