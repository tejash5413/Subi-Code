# macOS desktop download recovery

The public 2.0.0 release had no macOS installer entries. Both desktop targets
passed packaged startup, Plan/Build, Settings, MCP, plugin and skill checks in
[native qualification run 39411779478](https://github.com/tejash5413/Subi-Code/actions/runs/39411779478).
The separate installed VS Code extension checks did not finish. The combined
publication gate withheld the desktop files as well.

Recovered the unchanged Intel and Apple silicon DMG/ZIP files from native build
run 39377134486. The source revision is
`17f3da86693c82e57fe8a6dc0fe0dcec0ecb2b76`, matching the existing public desktop
release. Artifact ZIP CRCs, source revision, CLI checksums and completed desktop
qualification records matched before staging the files.

An explicit `--desktop-only` prepare/publish mode now checks native CLI and
desktop qualification without claiming extension qualification. It only permits
the recorded incomplete extension stage, excludes VSIX files, and preserves all
default combined-product gates. Sizes, SHA-256 hashes and source revision remain
required. Existing installer bytes cannot be replaced. Release notes list the
desktop and extension target sets separately.

Published four macOS files to the existing v2.0.0 release. The combined public
manifest and checksums preserve the ten previously available files. Verified
each new public URL returns HTTP 200 with its expected size and that GitHub's
uploaded asset digest matches its SHA-256. Updated only the named `subi`
database's `subicodeReleases/stable` download fields, preserving existing CLI
policy and per-file flags. The public release endpoint now returns fourteen
downloads, including the four macOS desktop files. The website fallback manifest
was updated to match.

The website selector also chooses an available package for a platform/processor
when its default format is missing. Unavailable formats are disabled. Missing
products show an explicit status and a working CLI alternative when available.

Validation: release-script contract tests passed, including incomplete extension,
failed desktop, unrelated failure, attempted VSIX publication and changed-file
rejection. The two focused website suites passed all nine tests. Node syntax
checks and Git whitespace checks passed. Bun was not available in this shell,
so the repository-wide Bun check was not run. No production website build ran.

The macOS VSIX remains unpublished. The Mac desktop files remain unsigned and
not notarized; the website and release notes disclose that status. CLI 2.0.1
publication was not resumed by this recovery.
