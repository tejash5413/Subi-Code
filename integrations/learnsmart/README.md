# LearnSmart native coding gateway

This directory stages the existing `functions-subi` backend plus the native
Subi Code request adapter. The original LearnSmart checkout remains read-only.
The adapter retains the existing account, subscription, model assignment,
school quota, individual credit, reservation and settlement authorities.
Tools execute through the client's existing tool and permission services.

## Deployment

Target only `subiManagedAgentApi`, codebase `subi`, project
`learnsmart-c2a7e`, region `asia-south1`, Node.js 22. Other function exports
remain present for discovery; the explicit filter excludes them from deployment.

From `functions-subi`, install the locked dependencies and qualify the source:

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run scan
```

The ignored `functions-subi/.env.learnsmart-c2a7e` supplies
`SUBI_NATIVE_AGENT_ENABLED=1` and preserves the deployed user environment
settings. Do not replace existing user environment variables with only this
flag: Firebase treats dotenv as the complete user environment. Firebase supplies
its reserved runtime environment variables separately. Never commit credentials
or dotenv contents.

From this directory:

```powershell
firebase deploy --only functions:subi:subiManagedAgentApi --project learnsmart-c2a7e --config firebase.json --non-interactive
```

The predeploy hook runs both existing static gates. Deployment does not change
Firestore account permissions, quotas, subscriptions, credit balances, IAM,
hosting, rules, billing functions or managed model assignments. Existing
operational and entitlement gates still apply to every coding request.

## Verification and rollback

Authenticated `GET /agent/native/status` returns protocol version 1 and
`textOnly: true` when enabled. Missing credentials must still be rejected.
Use the dev.7 or newer CLI: earlier account-only builds cannot populate the
LearnSmart picker even after the backend is enabled. `/account` refreshes the
account and native provider catalog. This discovery performs no inference.

To disable the native adapter, set the deployment environment flag to `0` and
redeploy the same single function. This preserves legacy agent requests and the
existing server operational gate. Reverting source requires the saved deployed
source archive and its configuration; do not redeploy an unrelated working tree.

The October 17 deployment qualification stores bulky logs, the previous cloud
configuration and a source archive outside the repository under
`C:\Users\Admin\AppData\Local\Temp\subi2-20261017`. The prior revision was
`subimanagedagentapi-00047-gis`; its source archive SHA-256 was
`94502482A464FC9ABED7F01AB6E3FFB7A9F2B922357BD8D7B75B9A0C124C332B`.
Its 103 source/package files matched the read-only backend base before deployment.

## Qualification boundaries

The native adapter is text-only. The candidate's full backend suite passed
974 tests with zero failures using its own freshly installed dependencies;
both static boundary/leak gates passed. Shared client regressions passed
1,240 executions, including permission revocation while approval is pending.
The Windows dev.7 executable passed isolated sign-in, RPC and catalog smokes.
These checks do not establish live model generation, full coding/restart/worker
recovery, GUI feature parity or Linux/macOS execution. See
`docs/subi-migration.md` at the repository root for the broader release gaps.
