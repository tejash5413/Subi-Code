#!/usr/bin/env node
const { spawn } = require("node:child_process")
const path = require("node:path")
const manifest = require("../package.json")

function fail(message) {
  console.error(`SubiCode: ${message}`)
  process.exit(1)
}

function executable() {
  if (process.env.SUBI_BIN_PATH) return process.env.SUBI_BIN_PATH
  const name = `@subicodeagent/subi-cli-${process.platform}-${process.arch}`
  if (!manifest.optionalDependencies[name]) fail(`unsupported platform ${process.platform}/${process.arch}.`)
  let file
  try {
    file = require.resolve(`${name}/package.json`)
  } catch {
    fail(`the native package is missing. Reinstall with: npm install -g @subicodeagent/subi-cli --include=optional`)
  }
  if (require(file).version !== manifest.version)
    fail(`native package version mismatch. Reinstall @subicodeagent/subi-cli@${manifest.version}.`)
  return path.join(path.dirname(file), "bin", process.platform === "win32" ? "subi.exe" : "subi")
}

const child = spawn(executable(), process.argv.slice(2), { stdio: "inherit" })
const signals =
  process.platform === "win32" ? ["SIGINT", "SIGTERM", "SIGHUP"] : ["SIGINT", "SIGTERM", "SIGHUP", "SIGUSR1"]
const listeners = new Map()
for (const signal of signals) {
  const forward = () => child.kill(signal)
  listeners.set(signal, forward)
  process.on(signal, forward)
}
child.once("error", (error) => fail(`could not start the native CLI: ${error.message}`))
child.once("exit", (code, signal) => {
  for (const [name, listener] of listeners) process.removeListener(name, listener)
  if (signal) return process.kill(process.pid, signal)
  process.exit(code ?? 1)
})
