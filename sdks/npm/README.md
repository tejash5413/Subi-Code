# SubiCode CLI

SubiCode helps you plan changes, edit files, run checks and review work from your terminal.

Requires Node.js 22 or newer. Published packages support Windows, macOS and glibc-based Linux on x64 and ARM64. Each platform is published only after its native package checks pass.

```sh
npm install -g @subicodeagent/subi-cli
subi --version
cd your-project
subi
```

The package selects a matching native optional dependency. Keep npm optional dependencies enabled. If one was omitted, reinstall with `npm install -g @subicodeagent/subi-cli --include=optional`.

To update: `npm install -g @subicodeagent/subi-cli@latest`.

[Documentation](https://stlearnsmart.in/subi-code/docs) · [Website](https://stlearnsmart.in/subi-code) · [Support](https://stlearnsmart.in/contact)

Connect your own supported provider or your LearnSmart account after installation. Model access depends on your provider/account permissions and limits.

SubiCode includes software derived from OpenCode and other open source projects. License and attribution notices are retained.
