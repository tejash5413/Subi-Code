import { app } from "electron"

type Channel = "local" | "dev" | "beta" | "prod"

const raw = import.meta.env.OPENCODE_CHANNEL

export const CHANNEL: Channel = raw === "local" || raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

export const VERSION = app.isPackaged ? app.getVersion() : (process.env.OPENCODE_VERSION ?? app.getVersion())

const appIDs: Record<string, string> = {
  dev: "in.stlearnsmart.subi.desktop.dev",
  beta: "in.stlearnsmart.subi.desktop.beta",
  prod: "in.stlearnsmart.subi.desktop",
}

// Local renderer/server mode keeps the dev application identity.
export const APP_NAME = "SubiCode"

export const APP_ID = app.isPackaged ? appIDs[CHANNEL] : "in.stlearnsmart.subi.desktop.dev"
