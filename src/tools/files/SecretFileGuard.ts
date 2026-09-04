/**
 * Phase 10A: secret-file name patterns blocked from read_file.
 * Substring match, case-insensitive. Conservative defaults.
 */
const SECRET_FILE_PATTERNS: ReadonlyArray<RegExp> = [
  /(^|\/)\.env(\..*)?$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.pfx$/i,
  /\.p12$/i,
  /(^|\/)\.aws\/credentials$/i,
  /(^|\/)\.ssh\//i,
  /(^|\/)credentials\.json$/i,
  /(^|\/)service[-_]?account[-_]?.*\.json$/i,
  /(^|\/)firebase[-_]?adminsdk[-_].*\.json$/i,
  /(^|\/)gha[-_]?creds\.json$/i,
  /(^|\/)id[-_]?rsa(\.pub)?$/i,
  /(^|\/)id_ed25519(\.pub)?$/i,
  /(^|\/)secrets?\.(json|ya?ml|toml|env)$/i,
];

export function isSecretFilePath(relativePath: string): boolean {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    return false;
  }
  const normalized = relativePath.replace(/\\/g, '/');
  for (const re of SECRET_FILE_PATTERNS) {
    if (re.test(normalized)) {
      return true;
    }
  }
  return false;
}
