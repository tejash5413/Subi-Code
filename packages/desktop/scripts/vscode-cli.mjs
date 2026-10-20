import { access, readFile } from "node:fs/promises"
import path from "node:path"

export async function windowsCliScript(launcher) {
  const source = await readFile(launcher, "utf8")
  const relative = source.match(/"%~dp0([^"\r\n]*cli\.js)"/i)?.[1]
  const script = relative
    ? path.resolve(path.dirname(launcher), relative.replaceAll("\\", path.sep))
    : path.resolve(path.dirname(launcher), "../resources/app/out/cli.js")
  await access(script)
  return script
}
