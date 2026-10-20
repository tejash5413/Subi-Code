# LearnSmart managed accounts

This package contains the existing SUBI account service closure. It includes
Firebase login/logout and profile validation, access-first bootstrap, assigned
model metadata, school token limits, individual milliCredit balances,
purchase/renewal URLs and the short-lived account permission ceiling.

It does not implement BYOK, inference, tool execution, sessions, workers or
completion. Those remain owned by the copied OpenCode runtime. Porting these
services is not evidence that the host login UI or managed inference is wired.

`NativeLearnSmartAuth` now supplies stateless Firebase sign-in/profile checks
and refresh-token rotation to the core's native LearnSmart OAuth method.
The native credential store owns persistence; the account transport does not
retain a global SDK user. Local fixtures cover identity and native connection
lifecycle; live login, full process restart, account-state presentation and
managed inference still require qualification.

`migration-source.json` records hashes of the original files before adaptation.
Firebase client configuration contains public website identifiers; passwords
and tokens must never be persisted in UI state or logged. Backend access and
quota responses remain authoritative after authentication.
