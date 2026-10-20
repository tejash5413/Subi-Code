import { resolveChannel } from "./utils"

const arg = process.argv[2]

const channel = arg === "dev" || arg === "beta" || arg === "prod" ? arg : resolveChannel()

const appId = channel === "prod" ? "in.stlearnsmart.subi.desktop" : `in.stlearnsmart.subi.desktop.${channel}`

const productName = "SubiCode"

const summary = `Open source AI coding agent${channel !== "prod" ? ` (${channel})` : ""}`

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop-application">
  <id>${appId}</id>

  <metadata_license>CC0-1.0</metadata_license>
  <project_license>MIT</project_license>

  <name>${productName}</name>
  <summary>${summary}</summary>

  <developer id="in.stlearnsmart">
    <name>LearnSmart</name>
  </developer>

  <description>
    <p>
      SUBI Code is an AI coding agent with LearnSmart accounts and support for your own providers.
    </p>
  </description>

  <launchable type="desktop-id">${appId}.desktop</launchable>

  <content_rating type="oars-1.1" />

  <url type="bugtracker">https://stlearnsmart.in/contact</url>
  <url type="homepage">https://stlearnsmart.in/subi-code</url>
</component>
`

await Bun.write(`resources/${appId}.metainfo.xml`, xml)

console.log(`Generated metainfo for ${channel} at resources/${appId}.metainfo.xml`)
