# Desktop service port conflict — October 19, 2026

The desktop startup failure was caused by the original OpenCode 2.0.32 service
already listening on 127.0.0.1:45278 (PID 1752). Subi retained OpenCode's default
port despite using separate service registration/configuration directories.
The server correctly refused the conflicting bind and surfaced the IPC error.

## Repair applied to installed setup

Backed up `C:\Users\Admin\.config\subi-code\service.json`, checked port 46513
was free, then used the installed CLI's supported `service set port 46513` and
`service start` commands. All preexisting configuration fields, including the
credential and remote settings, were preserved. OpenCode's process was untouched.

Closed Subi's error window normally and tested the installed desktop against the
normal user profile. Composer and agent selector became visible, the title was
SUBI Code, and no renderer page errors occurred. Relaunched Subi normally after
the test; its main log reports the background service ready on port 46513.
Both OpenCode on 45278 and Subi on 46513 were listening simultaneously.

Three leftover services from our earlier isolated desktop audit profiles were
stopped after verifying their executable paths belonged to those profiles.
The user's standalone CLI was left untouched.

## Source fix and checks

`packages/cli/src/services/service-config.ts` now gives release/dev/beta/next
channels a distinct Subi default: 46513 on Windows and 50609 on Linux/macOS;
local uses the adjacent port. Explicitly configured ports retain precedence.
Existing service tests cover stable channels, Windows reserved ranges and
configured overrides; the channel cases now also reject OpenCode's default ports.

- CLI typecheck passed.
- Isolated configured-runner service suite: 25 passed, 0 failed, 150 assertions.
- An earlier unisolated invocation had 24 passes and one registration timeout.
  It was not used as a passing result; the isolated runner uses the established
  CLI fixture, disables model fetching and preserves the original test timeouts.
- Installed normal-profile desktop startup passed with both products running.

Installed binaries remain dev.19; their repair is the persisted service port
configuration, so no reinstall was necessary. The new default in source will
be included in the next build; existing dev.19 artifacts still contain the old
default. Linux/macOS source defaults were tested in-process, not on native hosts.

Evidence, screenshot, source/config backups and logs:
`C:\Users\Admin\AppData\Local\Temp\subi2-20261019\port-fix`.
No account data reset or provider credential change was performed.
