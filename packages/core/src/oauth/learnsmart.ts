import { Clock, Deferred, Effect } from "effect"
import type { Server } from "node:http"
import {
  NativeLearnSmartAuth,
  NativeLearnSmartAuthError,
  type NativeLearnSmartSession,
} from "@subi/managed/services/auth/native-auth"
import type { IntegrationOAuthAuthorization } from "@opencode/plugin/effect/integration"
import { Credential } from "../credential.js"
import { Integration } from "../integration.js"
import { brandMark } from "./brand-mark.js"

export const learnSmartMethodID = Integration.MethodID.make("learnsmart-browser")

/** Passwords travel only from the private loopback form to Firebase, outside the shared Form protocol. */
export function authorizeLearnSmart(auth: NativeLearnSmartAuth) {
  return Effect.gen(function* () {
    const received = yield* Deferred.make<NativeLearnSmartSession>()
    const runtime = yield* Effect.context<never>()
    const controller = new AbortController()
    const path = `/auth/learnsmart/${crypto.randomUUID()}`
    const state = { origin: "", busy: false, finished: false }
    const { createServer } = yield* Effect.promise(() => import("node:http"))
    const server = createServer(
      { maxHeaderSize: 8192, headersTimeout: 10_000, requestTimeout: 60_000 },
      async (request, response) => {
        const reply = (status: number, message?: string) => {
          response
            .writeHead(status, {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-store",
              Pragma: "no-cache",
              // Form navigation needs its same-origin Origin for the strict POST check below.
              "Referrer-Policy": "same-origin",
              "X-Content-Type-Options": "nosniff",
              "Content-Security-Policy":
                "default-src 'none'; img-src data:; form-action 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
            })
            .end(page(message, status === 200 && state.finished))
        }

        if (request.headers.host !== state.origin.slice("http://".length) || request.url !== path)
          return reply(403, "Invalid sign-in request.")
        if (state.finished || controller.signal.aborted)
          return reply(409, "This sign-in request has ended. Return to SUBI.")
        if (request.method === "GET") return reply(200)
        if (request.method !== "POST") return reply(405, "Unsupported sign-in request.")
        if (request.headers.origin !== state.origin) return reply(403, "Invalid sign-in origin.")
        if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/x-www-form-urlencoded")
          return reply(415, "Unsupported sign-in request.")
        if (Number(request.headers["content-length"]) > 16_384) return reply(413, "Sign-in request is too large.")
        if (state.busy) return reply(409, "Sign-in is already in progress.")
        state.busy = true

        try {
          const chunks: Buffer[] = []
          let size = 0

          for await (const chunk of request) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            size += bytes.length

            if (size > 16_384) return reply(413, "Sign-in request is too large.")
            chunks.push(bytes)
          }

          const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"))
          const session = await auth.signIn(body.get("email") ?? "", body.get("password") ?? "", controller.signal)
          if (controller.signal.aborted || response.destroyed) return
          state.finished = true
          // Settling the native attempt closes its scope and loopback sockets. Flush the page first.
          await new Promise<void>((resolve) => {
            response.once("finish", resolve)
            response.once("close", resolve)
            reply(200)
          })
          if (controller.signal.aborted) return
          await Effect.runPromiseWith(runtime)(Deferred.succeed(received, session))
        } catch (error) {
          if (!controller.signal.aborted)
            reply(
              400,
              error instanceof NativeLearnSmartAuthError ? error.message : "Unable to sign in. Please try again.",
            )
        } finally {
          state.busy = false
        }
      },
    )
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        controller.abort()
        server.closeAllConnections()
        server.close()
      }),
    )
    const port = yield* listen(server)
    state.origin = `http://127.0.0.1:${port}`

    return {
      mode: "auto",
      url: state.origin + path,
      instructions: "Sign in to LearnSmart in your browser, then return to SUBI. Your password is not saved.",
      callback: Effect.gen(function* () {
        const session = yield* Deferred.await(received)
        const now = yield* Clock.currentTimeMillis

        return credential(session, now)
      }),
    } satisfies IntegrationOAuthAuthorization
  })
}

export function refreshLearnSmart(auth: NativeLearnSmartAuth, value: Credential.OAuth) {
  return Effect.gen(function* () {
    const uid = value.metadata?.uid
    if (typeof uid !== "string") return yield* Effect.fail(new NativeLearnSmartAuthError())
    const session = yield* Effect.tryPromise({
      try: (signal) => auth.refresh(value.refresh, uid, signal),
      catch: (error) => (error instanceof NativeLearnSmartAuthError ? error : new NativeLearnSmartAuthError()),
    })
    const now = yield* Clock.currentTimeMillis

    return credential(session, now)
  })
}

function credential(session: NativeLearnSmartSession, now: number) {
  return Credential.OAuth.make({
    type: "oauth",
    methodID: learnSmartMethodID,
    access: session.access,
    refresh: session.refresh,
    expires: now + session.lifetimeMs,
    metadata: { ...session.user },
  })
}

function listen(server: Server) {
  return Effect.callback<number, Error>((resume) => {
    const onError = () => resume(Effect.fail(new Error("Unable to open LearnSmart sign-in.")))
    server.once("error", onError)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError)
      const address = server.address()
      if (!address || typeof address === "string") return onError()
      resume(Effect.succeed(address.port))
    })
  })
}

function page(message?: string, complete = false) {
  const escaped = message?.replace(/[&<>"']/g, (value) => `&#${value.charCodeAt(0)};`)

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>Subi Code · LearnSmart</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;min-height:100svh;display:grid;place-items:center;padding:40px 20px;background:radial-gradient(ellipse at 12% 0%,#087dfd18,transparent 55%),radial-gradient(ellipse at 95% 95%,#7038ff1c,transparent 55%),#090d16;color:#f4f6ff;font:15px/1.6 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{width:min(100%,448px)}
.brand{display:flex;align-items:center;justify-content:center;gap:12px;margin-bottom:28px;font-size:20px;font-weight:700;letter-spacing:-.5px}
.brand img{width:48px;height:48px;object-fit:contain}
.card{padding:32px;border:1px solid #ffffff16;border-radius:24px;background:linear-gradient(145deg,#161d2ce6,#101522f5);box-shadow:0 24px 80px #00000040}
.eyebrow{margin:0 0 8px;color:#a7b8ff;font-size:12px;font-weight:600;letter-spacing:1.4px;text-transform:uppercase}
h1{margin:0;font-size:28px;line-height:1.25;letter-spacing:-.8px;font-weight:650}
p{margin:12px 0 0;color:#b0b9cf}
.intro{margin-bottom:26px}
label{display:block;margin:18px 0 8px;font-size:14px;font-weight:550;color:#e1e6f4}
input,button{width:100%;border-radius:11px;font:inherit}
input{min-height:48px;padding:11px 14px;border:1px solid #64718d80;background:#0c1220;color:#f4f6ff;caret-color:#9bbdff;transition:border-color .15s}
input::placeholder{color:#8190ad}
input:hover{border-color:#8292b5}
button{margin-top:26px;min-height:48px;padding:11px 18px;border:1px solid #ffffff20;background:linear-gradient(110deg,#087dfd,#7038ff);color:white;font-weight:650;cursor:pointer;box-shadow:0 6px 24px #087dfd18}
button:hover{filter:brightness(1.12)}
input:focus-visible,button:focus-visible,a:focus-visible{outline:3px solid #9bbdff;outline-offset:4px}
.privacy{margin-top:22px;padding-top:20px;border-top:1px solid #ffffff12;font-size:12px;line-height:1.7;color:#97a5c0}
footer{text-align:center;margin-top:22px;font-size:13px;color:#97a5c0}
a{color:#b6bcff;text-underline-offset:4px;text-decoration-thickness:1px}
a:hover{color:#d5d9ff}
[role=alert]{margin:0 0 22px;padding:12px 14px;border:1px solid #f59e9e50;border-radius:11px;background:#f8717110;color:#ffc4c4;font-size:14px;overflow-wrap:anywhere}
.success{display:grid;place-items:center;width:48px;height:48px;margin-bottom:20px;border:1px solid #9bbdff50;border-radius:50%;background:#087dfd18;color:#b6bcff;font-size:26px}
@media(max-width:480px){body{padding:28px 16px}.card{padding:26px 22px;border-radius:20px}h1{font-size:26px}.brand{margin-bottom:24px}}
@media(prefers-reduced-motion:reduce){input{transition:none}}
</style></head><body><main>
<div class="brand"><img src="${brandMark}" alt="Subi Code" width="48" height="48"><span>Subi Code</span></div>
<section class="card" aria-labelledby="heading"><p class="eyebrow">LearnSmart account</p>${
    complete
      ? '<div class="success" aria-hidden="true">✓</div><h1 id="heading">Sign-in received</h1><p>Return to Subi Code to confirm your connection.</p><p>You can close this tab.</p>'
      : `<h1 id="heading">Welcome to Subi Code</h1><p class="intro">Sign in with your school or individual LearnSmart account.</p>${escaped ? `<p role="alert">${escaped}</p>` : ""}<form method="post"><label for="email">Email address</label><input id="email" name="email" type="email" autocomplete="username" placeholder="you@example.com" required autofocus maxlength="320"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" placeholder="Enter your password" required maxlength="4096"><button type="submit">Sign in to LearnSmart</button></form><p class="privacy">Your password is sent to Firebase Authentication and is never saved by Subi Code.</p>`
  }</section><footer><a href="https://stlearnsmart.in" rel="noreferrer">LearnSmart website</a></footer></main></body></html>`
}
