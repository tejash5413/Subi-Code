// The part of the SSH extension's remote CLI scripts that WSL uses. Extensions share only contracts, so
// keep the two copies in step.

export function quote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function requireVersion(version: string) {
  if (version !== "local" && !/^[0-9][a-zA-Z0-9.+-]*$/.test(version)) throw new Error(version)

  return version
}

export function discoverScript() {
  return `cli=""
if [ -z "$cli" ] && [ -x "$HOME/.subi-code/bin/subi" ]; then cli="$HOME/.subi-code/bin/subi"; fi
if [ -n "$cli" ]; then printf '%s\\n' "$cli"; fi
`
}

// Adapters supply a quoted shell expression, including remote HOME or wslpath expansion.
export function versionScript(command: string) {
  return `if [ -x ${command} ]; then ${command} --version 2>/dev/null || true; fi\n`
}

export function parseVersion(output: string) {
  const line = output
    .split(/\r?\n/)
    .find((line) => line.trim())
    ?.trim()

  if (!line) return null
  const marker = line.lastIndexOf(" v")
  const version = marker === -1 ? line : line.slice(marker + 2)

  if (!version) throw new Error("V2 CLI did not provide a version")

  return version
}

/** Stage the bundled Subi build, checking its version before replacing the discovered executable. */
export function installScript(input: { version: string; binary?: string }) {
  const version = requireVersion(input.version)

  if (!input.binary)
    return `printf '%s\\n' 'Subi Code download feed is not configured. Supply a verified local build.' >&2\nexit 1\n`

  return `set -eu
destination="$HOME/.subi-code/bin/subi"
mkdir -p "$(dirname "$destination")"
stage=$(mktemp "$destination.XXXXXX")
trap 'rm -f "$stage"' EXIT
cp ${input.binary} "$stage"
chmod 755 "$stage"
test "$("$stage" --version | awk '{print $NF}' | sed 's/^v//')" = ${quote(version)}
mv "$stage" "$destination"
`
}
