import { describe, expect, test } from "bun:test"
import { OauthCallbackPage } from "../src/oauth/page"
import { createContext, runInContext } from "node:vm"

describe("OauthCallbackPage", () => {
  test.each([undefined, "ChatGPT", "MCP", "xAI"])("identifies Subi Code on every callback state for %s", (provider) => {
    const pages = [
      OauthCallbackPage.success({ provider }),
      OauthCallbackPage.error("Please retry.", { provider }),
      OauthCallbackPage.bootstrap({ provider, tokenPath: "/token" }),
    ]

    for (const html of pages) {
      expect(html).toContain(" · Subi Code</title>")
      expect(html).toContain('aria-label="Subi Code"')
      expect(html).toContain('href="data:image/png;base64,')
      expect(html).not.toContain("OpenCode")
    }
    expect(pages[0]).toContain(provider ? `Subi Code is now connected to ${provider}.` : "Subi Code is now authorized.")
    expect(pages[1]).toContain("try again from Subi Code")
  })

  test.each([true, false])("fragment callback updates Subi Code branding after token submission: %s", async (ok) => {
    const html = OauthCallbackPage.bootstrap({ provider: "ChatGPT", tokenPath: "/token" })
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
    if (!script) throw new Error("Missing callback bootstrap script")
    const nodes = Object.fromEntries(
      ["oc-card", "oc-headline", "oc-message", "oc-detail", "oc-footnote"].map((id) => [
        id,
        { dataset: { status: "pending" }, textContent: "", hidden: false },
      ]),
    )
    const finished = Promise.withResolvers<void>()
    let footnote = ""
    Object.defineProperty(nodes["oc-footnote"], "textContent", {
      set(value: string) {
        footnote = value
        finished.resolve()
      },
    })
    const submissions: string[] = []
    const context = createContext({
      URL,
      URLSearchParams,
      window: {
        location: {
          origin: "http://127.0.0.1:1234",
          hash: "#access_token=fixture-token&state=fixture-state",
          search: "",
        },
      },
      document: { getElementById: (id: string) => nodes[id] },
      fetch: async (url: string, init: RequestInit) => {
        submissions.push(url)
        expect(JSON.parse(String(init.body))).toMatchObject({ access_token: "fixture-token", state: "fixture-state" })
        return new Response(ok ? "" : "Fixture denied", { status: ok ? 200 : 400 })
      },
      setTimeout: () => 0,
    })
    runInContext(script, context)
    await finished.promise
    expect(footnote).toBe(ok ? "You can close this window." : "Close this window and try again from Subi Code.")
    expect(submissions).toEqual(["http://127.0.0.1:1234/token"])
    expect(nodes["oc-card"].dataset.status).toBe(ok ? "success" : "error")
    expect(nodes["oc-message"].textContent).toBe(
      ok ? "Subi Code is now connected to ChatGPT." : "Subi Code couldn't finish connecting to ChatGPT.",
    )
  })

  test("escapes bootstrap options embedded in the inline script", () => {
    const html = OauthCallbackPage.bootstrap({
      provider: `xAI</script><script>alert("provider")</script>`,
      tokenPath: `/token</script><script>alert("path")</script>`,
    })

    expect(html.match(/<\/script>/g)).toHaveLength(1)
    expect(html).toContain(`xAI\\u003c/script>\\u003cscript>alert(\\\"provider\\\")\\u003c/script>`)
    expect(html).toContain(`/token\\u003c/script>\\u003cscript>alert(\\\"path\\\")\\u003c/script>`)
  })
})
