# Individual account billing integration

Implemented in `D:\LearnSmart\Subi 2.0`. LearnSmart source in
`D:\LearnSmart\learnsmart` was reviewed read-only. No payment, credit, flag,
identity, deployment or subscription write was performed.

## Behavior

- CLI and the VS Code terminal expose the account page through `/account`
  (also the command palette). Individuals see monthly grant/remaining,
  rollover, purchased, reserved and total available credits, with cycle and
  renewal dates. Unknown balances remain unknown, never zero by assumption.
- `p` / Top up credits opens the existing LearnSmart credit-pack checkout.
  `n` opens subscription purchase or renewal. Top-up requires the last server
  snapshot to report an active subscription. Expired/inactive accounts retain
  the renewal action and hide stale spendable balances.
- Browser and desktop share the account card under Settings → Providers.
  Settings search includes credits, top-up, subscription and renewal. The
  card supports school token allowances without individual purchase actions.
- Opening checkout never adds credits or enables coding locally. Returning
  to the app/terminal after opening checkout refreshes account data once when
  focus reporting is available. Manual Refresh account / `r` remains available
  for delayed payment settlement or terminals without focus reporting.
- Account refresh reuses the existing `subi.learnsmart.account/get` RPC. That
  core boundary bootstraps fresh managed access, usage and subscription data
  and refreshes native model discovery. The app then re-syncs the existing
  provider/model stores. No new RPC, schema, dependency or billing SDK was added.
- Refreshes clear previous balances while pending, reject stale account/location
  responses, abort on disposal, and have a 45-second UI deadline. Repeated
  refresh clicks do not dispatch concurrent account requests. Account changes
  and logout discard the previous snapshot.
- If saved individual login metadata conflicts with a current `school_tokens`
  quota response, both the displayed purchase actions and their handlers reject
  individual checkout. A regression reproduced the stale-metadata display gap
  before this guard was added (`commerce-school-authority-red.log`).

## Payment and credit authority

Trusted destinations are centralized in `packages/util/src/learnsmart.ts`:
`https://stlearnsmart.in/purchase?subi=topup` and
`https://stlearnsmart.in/purchase?subi=1`. Native credentials, account IDs and
payment sessions are never appended to browser links. The website can require
its own login; the UI reminds users to use the same account.

LearnSmart's existing `subiBillingApi` owns current commerce availability,
prices, GST, frozen quotes, Cashfree order creation, verified payment, receipts
and reconciliation. Its subscription and top-up services enforce individual
ownership, school exclusion and duplicate-payment protection. Credit-cycle and
wallet services own rollover, purchased credit retention and usage accounting.
The website displays the receipt on return from checkout; the native clients
do not introduce an independent receipt/history store or payment-success claim.
Renewal uses the existing manual checkout; recurring automatic debit was not added.

## Source changes

- `packages/util/src/learnsmart.ts`: fixed trusted checkout destinations.
- `packages/tui/src/feature-plugins/system/learnsmart-account.tsx`: credit detail,
  purchase shortcuts, renewal guidance, return refresh and bounded requests.
- `packages/tui/test/learnsmart-account.test.tsx`: stronger real-renderer coverage
  for individual balances, renewal recovery, fresh top-up balance and logout.
- `packages/app/src/settings/providers/learnsmart-account.tsx`: shared account card.
- `packages/app/src/settings/providers/providers.tsx`: mounts it independently of
  whether an expired account has models in the connected-provider catalog.
- `packages/app/src/settings/search-catalog.ts`, `settings/settings.css` and
  `runtime/i18n/en.ts`: search, semantic theme styling and English fallback copy.
- `packages/app/test-browser/learnsmart-account.test.ts` and its isolated fixture:
  actual production component with existing SDK/platform context ports replaced.
  Exercises checkout, focus refresh, single-flight, expired renewal, error
  redaction, school switch, logout cancellation and listener cleanup.

## Verification

External logs are in `C:\Users\Admin\AppData\Local\Temp\subi2-20261018`.
Commands use the pinned Bun 1.4.2 toolchain recorded in the resume document.

- Core: `bun run script/test.ts test/plugin/provider-learnsmart-account.test.ts`:
  four passed, 46 assertions (`commerce-core-final.log`).
- Managed package: `bun run test`: 76 passed, zero failed
  (`commerce-managed-all.log`).
- TUI regression first failed on missing rollover details, then passed both
  scenarios. `bun test --timeout 30000 test/learnsmart-account.test.tsx
  --rerun-each 10`: final source passed 20 cases, 320 assertions
  (`commerce-tui-final-repeat.log`).
- App keeper: `bun test --conditions=browser --isolate --preload ./happydom.ts
  ./test-browser/learnsmart-account.test.ts --rerun-each 10`: ten independent
  child-process checks passed. The inner case contains 35 assertions
  (`commerce-browser-final-repeat.log`, `commerce-browser-keeper.log`).
- App configured `bun run test`: 761 unit tests and 176 browser tests passed,
  zero failed on final source (`commerce-final-app-all.log`).
- TUI configured `bun run test`: 1500 passed, 12 skipped, zero failed, two
  snapshots and 108082 assertions, 1512 cases / 179 files, 193.42s
  (`commerce-final-tui-all.log`).
- Root `bun run check`: 36/36 tasks successful, zero cached, 2m30.95s
  (`commerce-root-check.log`). App and TUI focused type checks also passed.
  Final school-quota guard rerun: 36/36, 34 cached, 8.347s
  (`commerce-root-final-check.log`).
- Actual installed Chrome rendered the production card through Vite with
  fixture SDK/platform ports at desktop and mobile 360px widths. Trusted checkout
  destination, no optimistic credits, refresh on return, expired renewal and
  zero browser errors passed (`commerce-final-preview.log`). Screenshots:
  `commerce-desktop.png`, `commerce-mobile.png`, `commerce-expired.png`.
- Earlier read-only LearnSmart review: Node's test runner passed 107 tests in
  billing, top-ups, individual cycles/quota, lazy recovery and history. Cashfree
  and Firestore were fakes (`commerce-readonly-review.log`). No live payment
  processing or currently deployed sales flags were qualified by those tests.

## Built artifacts

- Windows x64 CLI `2.0.0-dev.15`:
  `packages/cli/dist/subi-billing-final-20261018/cli-windows-x64-baseline/bin/subi.exe`.
  SHA256 `2BE4404425416C1B8467708E6500135CB4721B1BADFD6DD6D3A920130510487B`.
- VS Code: `artifacts/2026-10-18/subicode-2.0.0-win32-x64-dev15.vsix`.
  SHA256 `A63934C8796F70FAA4FFA8B3856C6E136EE05E618BB43B563599A8F9184B8897`.
  Packaged executable and desktop resource hashes match the tested CLI
  (`commerce-artifacts.json`). Extension type checks and packaging passed;
  lint has zero errors and 42 pre-existing semicolon warnings. This package
  has not been installed in the user's normal VS Code profile.
- Native private Windows PTY opened the compiled CLI, navigated `/account`
  and observed the signed-out guidance and refresh controls. Zero inference
  or billing requests (`commerce-native.log`). Paid balances were qualified
  through fixture transports, not a real paid account.
- Web `bun run build` passed (`commerce-app-build.log`); desktop
  `OPENCODE_CLI_DIST=<CLI dist root> bun run build` passed main, preload and
  renderer (`commerce-desktop-build.log`). Desktop resources contain dev.15.
  These are source build outputs, not signed/published installers.
- CLI build command from `packages/cli`, with channel dev and version
  `2.0.0-dev.15`: `bun run script/build.ts
  --target=opencode-windows-x64-baseline --skip-install --skip-web-ui
  --outdir=dist/subi-billing-final-20261018` (`commerce-final-build.log`).
  As with prior qualification binaries, the CLI does not embed web assets.
  Web and desktop UI are built separately. The superseded dev.14 build was
  stopped before qualification when the additional school-quota test failed;
  do not use that partial build directory.
- Source checkpoint: 404 original-manifest paths differ, zero original OpenCode
  source paths changed and zero whitespace errors (`commerce-source-check.log`).
  All 14 feature/report files, including new files outside that manifest, also
  passed `git -c core.autocrlf=false diff --no-index --check -- NUL <file>`.

## Limits

This integrates existing hosted checkout rather than moving money handling into
native clients. A browser account may differ from the CLI's account; the website
shows the paying account and backend ownership remains authoritative. Settlement
can complete after return, so a refresh can still show the pre-payment balance
until verification/grant recovery finishes. No local balance is invented.

Source is shared with desktop and future Linux/macOS hosts, but native platform
qualification in this task is Windows x64 only. Live payments, automatic debit,
new deployment, signed installers and the wider coding/recovery release gates
are not claimed. The separate individual-model discovery latency investigation
remains open; this feature does not resolve its duplicate backend reads.
