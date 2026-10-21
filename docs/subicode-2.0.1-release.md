# SubiCode 2.0.1 release candidate

All public CLI native packages, the npm launcher, the extension package, desktop installer metadata and the displayed product version use 2.0.1. Internal workspace package versions are separate implementation identifiers.

Changes include the Silver CLI layout, durable local Todos, created/edited/deleted file tracking, total addition/deletion counts, bounded expandable code previews, parallel-agent sidebar inspection, and current LearnSmart model/account projections. The individual provider-rejection accounting fix is deployed separately in the LearnSmart gateway.

The release must be built from one committed source revision and qualified on Windows, macOS and glibc Linux, each on x64 and ARM64. Only new artifacts from that revision may be published. Native packages publish before the shared launcher. Existing 2.0.0 packages remain intact.

Qualification and publication evidence will be added after the native workflow and registry checks complete. Desktop/VSIX distribution is separate from npm publication; no marketplace availability or signing claim is implied.
