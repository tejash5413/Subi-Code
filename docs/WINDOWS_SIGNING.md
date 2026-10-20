# Windows publisher signing

The public SubiCode 2.0.0 Windows installers are currently unsigned. Their
SHA-256 hashes verify downloaded bytes; they do not establish publisher identity.

## Obtain a signing identity

Choose a publicly trusted Windows code-signing certificate with hardware-token
or cloud/HSM key storage. The issuer validates the publisher's legal identity;
the certificate subject determines the publisher shown by Windows. Examples:

- [DigiCert Code Signing with KeyLocker](https://docs.digicert.com/en/digicert-keylocker/overview/access.html)
- [Sectigo Code Signing](https://www.sectigo.com/signing-certificates)

Microsoft [Artifact Signing eligibility](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)
currently covers organizations in the USA, Canada, EU and UK, and individuals in
the USA and Canada. A publisher registered in India needs another eligible
provider. Confirm eligibility and the current quote before purchasing.

[SignPath Foundation](https://signpath.org/terms) provides free signing to
approved open-source projects under its policy. Approval is required and its
certificate publisher is SignPath Foundation, rather than LearnSmart.

## Connect the release build

`packages/desktop/electron-builder.config.ts` uses electron-builder 26 and calls
`script/sign-windows.ps1` on Windows GitHub Actions builds. The existing script
supports Azure Artifact Signing and skips signing when these values are absent:

- `AZURE_TRUSTED_SIGNING_ENDPOINT`
- `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`
- `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE`

Azure authentication must also be configured for the workflow; the script uses
Azure CLI credentials. No signing identity is currently configured in the native
release workflow. A certificate-authority service requires adapting this hook to
its signing client. Keep signing credentials in the provider and restricted CI
secrets or workload identity, outside source control.

Sign the app executables during packaging and the resulting NSIS installer.
Use SHA-256 file digests and an RFC 3161 timestamp. Make configured signing
fail the build if signing or verification fails. Review updater publisher
verification when enabling signed releases: it is currently disabled in the
unsigned distribution configuration.

## Verify and publish

Install [SignTool from the Windows SDK](https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool).
Verify each final installer and the installed application executables:

```powershell
signtool verify /pa /all /v /tw .\subi-desktop-win-x64.exe
Get-AuthenticodeSignature .\subi-desktop-win-x64.exe |
  Format-List Status, StatusMessage, SignerCertificate, TimeStamperCertificate
Get-FileHash .\subi-desktop-win-x64.exe -Algorithm SHA256
```

Require a valid trusted signature, the expected legal publisher, and a valid
timestamp. Run the native installation checks on the signed output. Generate
checksums after signing, since signing changes file bytes. Publish the signed
files under a new release identity and update the website and named `subi`
release metadata with their actual hashes and verified signature status.
Do not overwrite the existing immutable unsigned installers. The current
download generator deliberately records `signed: false`; connect actual
signature verification before emitting `signed: true`.

Signing does not guarantee immediate SmartScreen reputation for a new release.
[Microsoft describes how reputation builds](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options).
