#!/usr/bin/env bun
import { $ } from "bun"

import { copyBuiltCliToResources, resolveChannel } from "./utils"

const channel = resolveChannel()

const cli = Bun.env.OPENCODE_CLI_DIST
if (!cli) {
  throw new Error("Build the SUBI CLI and set OPENCODE_CLI_DIST for every SUBI desktop build")
}

await $`bun ./scripts/copy-icons.ts ${channel}`

await $`bun ./scripts/copy-metainfo.ts ${channel}`

await copyBuiltCliToResources(cli)
