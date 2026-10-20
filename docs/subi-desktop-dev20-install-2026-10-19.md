# Windows desktop dev.20 installation — October 19, 2026

Installed the locally built per-user Windows x64 desktop update. NSIS exited 0.
The application remains at
`C:\Users\Admin\AppData\Local\Programs\subicode-desktop\Subi Code Dev.exe`.
Normal account/session/preferences storage was preserved. The global CLI and
VS Code extension were not upgraded as part of this desktop-only request.

The bundled server is now 2.0.0-dev.20 with the separated default service port,
so the fix no longer depends on the user's saved port override. Native default
startup passed with no configured port while original OpenCode remained on
45278. Subi chose 46513. The normal profile's existing explicit 46513 remains.
The desktop successfully replaced the registered dev.19 service with dev.20;
normal main logs report the new background service ready on 127.0.0.1:46513.

Installed server SHA256:
`4257B4543A917364F17EEE25E8C862F61AA1A82E59979C6C12900EBF607AC85E`.
The installed native server and app.asar match the qualified package files.
Desktop and Start menu shortcuts retain an explicit fresh white-logo icon.

## Verification and limits

- CLI build, desktop prebuild/build and NSIS packaging passed.
- Root check: 36/36 successful tasks (35 cached); lint had warnings, zero errors.
- Service regression suite previously passed 25/25 with the source port fix.
- Packaged and installed desktop passed actual fresh-profile startup, title,
  new logo and Build→Plan→Build keyboard switching, with no renderer errors.
- An initial packaged mouse-menu automation attempt timed out. Keyboard-driven
  qualification passed; this does not claim a fresh successful mouse-menu run.
- Normal-profile composer automation encountered persisted settings and session
  navigation; waiting specifically for a fresh composer was not a valid generic
  startup check for that profile. Those failed attempts and test-cleanup issues
  are retained. The normal renderer displayed settings, and its new server was
  healthy. No account/session reset was used to force that test to pass.
- Linux/macOS native installation and release signing remain unqualified.
  No hosted deployment, purchase or model inference was performed.

Installer:
`artifacts/2026-10-19/desktop-dev20-port-fix/subi-desktop-win-x64.exe`.
Previous dev.19/dev.16 installers remain available for rollback.

Logs, hashes, configuration backups and default-port result:
`C:\Users\Admin\AppData\Local\Temp\subi2-20261019\port-fix`.
Actual packaged/installed desktop keyboard smoke profiles:
`C:\Users\Admin\AppData\Local\Temp\subi2-20261019\platform-audit\desktop-unpacked-dev20-keyboard`
and `desktop-installed-dev20` under the same audit directory.
