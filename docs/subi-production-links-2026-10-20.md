# SubiCode production website and documentation links

Production domain confirmed by the user: `stlearnsmart.in`.

- Product website: https://stlearnsmart.in/subi-code
- Documentation: https://stlearnsmart.in/subi-code/docs
- Support: https://stlearnsmart.in/contact

## Changes

- Centralized product, documentation and contextual guide URLs in `packages/util/src/product.ts`.
- Settings > About now includes a documentation link and opens the SubiCode product page rather than the LearnSmart root page.
- Settings > Extensions links to the currently selected MCP, Plugins or Skills guide. Appearance and provider setup link to the settings and models guides.
- Home Help and desktop Documentation menu actions open the documentation. Support and feedback actions continue to open Contact LearnSmart.
- CLI Help includes website and documentation links; `/docs` opens the guide.
- The VS Code extension contributes `SubiCode: Open Documentation`.
- Existing Settings regression keepers verify the About destinations and changing guide destinations between extension tabs.

## Validation

- E2E TypeScript check: passed.
- VS Code extension type check, lint, bundle and test compilation: passed. Lint reported warnings, no errors.
- Chrome Settings regression keepers: 2 passed, covering About, bundled notices, and MCP/Plugins/Skills guide URLs.
- Repository `bun run check`: passed; 36/36 type-check tasks successful, lint reported warnings and no errors.
- Both public routes returned HTTP 200 during URL verification. These SPA responses do not establish that the latest local docs content has been deployed.

## Delivery boundary

These are source changes. Installed desktop/CLI binaries and the installed VS Code extension have not been replaced in this change. The shared app and CLI code carries the same production destinations across platform builds; native macOS/Linux execution was not tested here. The LearnSmart website production build remains stopped, as requested earlier.
