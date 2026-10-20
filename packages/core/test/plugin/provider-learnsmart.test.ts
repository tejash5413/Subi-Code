import { describe, expect } from "bun:test"
import { Effect, Exit, Scope } from "effect"
import { NativeLearnSmartAuth } from "@subi/managed/services/auth/native-auth"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { LearnSmartPlugin, make } from "@opencode/core/plugin/provider/learnsmart"
import { ProviderPlugins } from "@opencode/core/plugin/provider"
import { Provider } from "@opencode/core/provider"
import { learnSmartMethodID } from "@opencode/core/oauth/learnsmart"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)
const integrationID = Integration.ID.make("learnsmart")

function fixture() {
  const state = { paused: false, calls: 0 }
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      state.calls++
      const path = new URL(request.url).pathname
      if (path.endsWith("accounts:signInWithPassword")) {
        started.resolve()
        if (state.paused) await release.promise
        return Response.json({
          idToken: "id-token",
          refreshToken: "refresh-token",
          expiresIn: "3600",
          localId: "user-1",
        })
      }
      if (path.endsWith("/token"))
        return Response.json({
          id_token: "fresh-token",
          refresh_token: "rotated-refresh",
          expires_in: "3600",
          user_id: "user-1",
        })
      if (path.endsWith("accounts:lookup"))
        return Response.json({ users: [{ localId: "user-1", email: "person@example.com", emailVerified: true }] })

      return Response.json({ fields: { role: { stringValue: "student" }, accountType: { stringValue: "individual" } } })
    },
  })
  const auth = new NativeLearnSmartAuth((url, init) => fetch(new URL(new URL(url).pathname, server.url), init))

  return {
    state,
    started: started.promise,
    release: () => release.resolve(),
    auth,
    [Symbol.asyncDispose]: async () => {
      release.resolve()
      await server.stop(true)
    },
  }
}

const add = Effect.fn(function* (auth: NativeLearnSmartAuth) {
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin, LearnSmartPlugin.id)
  yield* make(auth).effect(host)
})

const connect = (integrations: Integration.Interface) =>
  integrations.oauth.connect({ integrationID, methodID: learnSmartMethodID })

function post(
  url: string,
  headers?: Record<string, string>,
  body = "email=person%40example.com&password=password-sentinel",
) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: new URL(url).origin, ...headers },
    body,
  })
}

function settled(
  integrations: Integration.Interface,
  attemptID: Integration.AttemptID,
  deadline = Date.now() + 10_000,
): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const result = yield* integrations.oauth.status({ integrationID, attemptID })
    if (result.status === "complete") return
    if (result.status !== "pending" || Date.now() > deadline)
      return yield* Effect.fail(new Error("Login did not complete"))
    yield* Effect.promise(() => Bun.sleep(1))
    yield* settled(integrations, attemptID, deadline)
  })
}

describe("LearnSmart native account integration", () => {
  it.live("admits only one submission and does not duplicate a completed connection", () =>
    Effect.gen(function* () {
      const local = fixture()
      yield* Effect.addFinalizer(() => Effect.promise(() => local[Symbol.asyncDispose]()))
      local.state.paused = true
      yield* add(local.auth)
      const integrations = yield* Integration.Service
      const credentials = yield* Credential.Service
      const attempt = yield* connect(integrations)
      const pending = post(attempt.url).then(
        (response) => response.status,
        () => 0,
      )
      yield* Effect.promise(() => local.started)
      expect((yield* Effect.promise(() => post(attempt.url))).status).toBe(409)
      expect(local.state.calls).toBe(1)
      local.release()
      expect(yield* Effect.promise(() => pending)).toBe(200)
      yield* settled(integrations, attempt.attemptID)
      yield* integrations.oauth.complete({ integrationID, attemptID: attempt.attemptID })
      expect(yield* credentials.list(integrationID)).toHaveLength(1)
      expect(local.state.calls).toBe(3)
    }),
  )

  it.live(
    "registers the shared login method, persists and refreshes the account, and logs out without removing BYOK",
    () =>
      Effect.gen(function* () {
        const local = fixture()
        yield* Effect.addFinalizer(() => Effect.promise(() => local[Symbol.asyncDispose]()))
        const integrations = yield* Integration.Service
        const credentials = yield* Credential.Service
        const providers = yield* Provider.Service
        const scope = yield* Scope.fork(yield* Scope.Scope)
        yield* add(local.auth).pipe(Scope.provide(scope))
        expect(ProviderPlugins.map((plugin) => plugin.id)).toContain(LearnSmartPlugin.id)
        expect(yield* integrations.get(integrationID)).toMatchObject({
          name: "LearnSmart",
          methods: [{ type: "oauth", id: learnSmartMethodID }],
        })
        expect(yield* providers.get(Provider.ID.make("learnsmart"))).toBeUndefined()
        const unrelated = yield* credentials.create({
          integrationID: Integration.ID.make("openai"),
          value: { type: "key", key: "byok-sentinel" },
        })
        const attempt = yield* connect(integrations)
        const response = yield* Effect.promise(() => post(attempt.url))
        const body = yield* Effect.promise(() => response.text())
        expect(response.status).toBe(200)
        expect(body).toContain("Sign-in received")
        expect(body).toContain('alt="Subi Code"')
        expect(body).not.toContain("<form")
        expect(body).not.toContain("id-token")
        expect(body).not.toContain("refresh-token")
        expect(body).not.toContain("password-sentinel")
        yield* settled(integrations, attempt.attemptID)
        const saved = (yield* credentials.list(integrationID))[0]
        expect(saved?.value).toMatchObject({
          type: "oauth",
          access: "id-token",
          refresh: "refresh-token",
          metadata: { uid: "user-1", role: "student", accountType: "individual" },
        })
        if (!saved || saved.value.type !== "oauth")
          return yield* Effect.fail(new Error("Missing saved LearnSmart account"))
        yield* credentials.update(saved.id, { value: { ...saved.value, expires: 0 } })
        yield* Scope.close(scope, Exit.void)
        yield* add(local.auth)
        const connection = yield* integrations.connection.active(integrationID)
        if (!connection) return yield* Effect.fail(new Error("Saved account was not restored"))
        expect(yield* integrations.connection.resolve(connection)).toMatchObject({
          access: "fresh-token",
          refresh: "rotated-refresh",
        })
        expect(local.state.calls).toBe(6)
        expect(JSON.stringify(yield* integrations.get(integrationID))).not.toContain("fresh-token")
        yield* integrations.connection.remove(saved.id)
        expect(yield* integrations.connection.active(integrationID)).toBeUndefined()
        expect(yield* credentials.get(unrelated.id)).toEqual(unrelated)
      }),
  )

  it.live("rejects foreign origins, hosts, oversized forms and replay before they can dispatch credentials", () =>
    Effect.gen(function* () {
      const local = fixture()
      yield* Effect.addFinalizer(() => Effect.promise(() => local[Symbol.asyncDispose]()))
      yield* add(local.auth)
      const integrations = yield* Integration.Service
      const attempt = yield* connect(integrations)
      const page = yield* Effect.promise(() => fetch(attempt.url))
      expect(page.headers.get("cache-control")).toBe("no-store")
      expect(page.headers.get("referrer-policy")).toBe("same-origin")
      expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'")
      expect(page.headers.get("content-security-policy")).toContain("img-src data:")
      const html = yield* Effect.promise(() => page.text())
      expect(html).toContain('type="password"')
      expect(html).toContain('src="data:image/png;base64,')
      expect(html).toContain('alt="Subi Code"')
      expect(html).toContain('autocomplete="current-password"')
      expect(html).toContain('<form method="post">')
      expect(html).not.toContain("<script")
      const foreign = yield* Effect.promise(() => post(attempt.url, { Origin: "https://example.invalid" }))
      expect(foreign.status).toBe(403)
      const opaque = yield* Effect.promise(() => post(attempt.url, { Origin: "null" }))
      expect(opaque.status).toBe(403)
      const host = yield* Effect.promise(() => post(attempt.url, { Host: "example.invalid" }))
      expect(host.status).toBe(403)
      const oversized = yield* Effect.promise(() => post(attempt.url, {}, "x".repeat(20_000)))
      expect(oversized.status).toBe(413)
      expect(local.state.calls).toBe(0)
      yield* integrations.oauth.cancel({ integrationID, attemptID: attempt.attemptID })
      const replay = yield* Effect.promise(() =>
        post(attempt.url).then(
          () => "accepted",
          () => "closed",
        ),
      )
      expect(replay).toBe("closed")
      expect(local.state.calls).toBe(0)
    }),
  )

  it.live("cancels an in-flight login without persisting credentials or accepting late completion", () =>
    Effect.gen(function* () {
      const local = fixture()
      yield* Effect.addFinalizer(() => Effect.promise(() => local[Symbol.asyncDispose]()))
      local.state.paused = true
      yield* add(local.auth)
      const integrations = yield* Integration.Service
      const credentials = yield* Credential.Service
      const attempt = yield* connect(integrations)
      const pending = post(attempt.url).then(
        () => "accepted",
        () => "closed",
      )
      yield* Effect.promise(() => local.started)
      yield* integrations.oauth.cancel({ integrationID, attemptID: attempt.attemptID })
      local.release()
      expect(yield* Effect.promise(() => pending)).toBe("closed")
      expect(yield* credentials.list(integrationID)).toEqual([])
      expect(local.state.calls).toBe(1)
    }),
  )
})
