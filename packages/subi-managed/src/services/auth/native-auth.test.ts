import { describe, expect, test } from "bun:test"
import { NativeLearnSmartAuth } from "./native-auth"

function fixture(
  input: {
    role?: string
    accountType?: string
    verified?: boolean
    reset?: boolean
    lookupUid?: string
    refreshUid?: string
    error?: number
    redirect?: boolean
  } = {},
) {
  const requests: { path: string; body: string; authorization: string | null }[] = []
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname
      requests.push({ path, body: await request.text(), authorization: request.headers.get("authorization") })

      if (input.redirect) return Response.redirect("https://example.invalid/leak", 302)
      if (input.error)
        return Response.json({ error: { message: "unsafe-id-token unsafe-password" } }, { status: input.error })
      if (path.endsWith("accounts:signInWithPassword"))
        return Response.json({
          idToken: "id-token",
          refreshToken: "refresh-token",
          expiresIn: "3600",
          localId: "user-1",
        })
      if (path.endsWith("/token"))
        return Response.json({
          id_token: "fresh-id-token",
          refresh_token: "rotated-refresh",
          expires_in: "3600",
          user_id: input.refreshUid ?? "user-1",
        })
      if (path.endsWith("accounts:lookup"))
        return Response.json({
          users: [
            {
              localId: input.lookupUid ?? "user-1",
              email: "person@example.com",
              emailVerified: input.verified ?? true,
            },
          ],
        })
      if (path.endsWith("/users/user-1"))
        return Response.json({
          fields: {
            role: { stringValue: input.role ?? "student" },
            accountType: { stringValue: input.accountType ?? "individual" },
            displayName: { stringValue: "SUBI User" },
            schoolId: { stringValue: "school-1" },
            studentId: { stringValue: "student-1" },
            teacherId: { stringValue: "teacher-1" },
            forcePasswordReset: { booleanValue: input.reset ?? false },
          },
        })

      return new Response("Unexpected request", { status: 404 })
    },
  })
  const auth = new NativeLearnSmartAuth((url, init) => {
    const source = new URL(url)
    const local = new URL(source.pathname + source.search, server.url)

    return fetch(local, init)
  })

  return { auth, requests, [Symbol.asyncDispose]: () => server.stop(true) }
}

describe("native LearnSmart credentials", () => {
  test.each([
    { role: "student", accountType: "individual", id: { studentId: "student-1" } },
    { role: "teacher", accountType: "school", id: { teacherId: "teacher-1" } },
  ])("signs in and validates the $accountType $role profile", async (row) => {
    await using local = fixture(row)
    const result = await local.auth.signIn(" Person@Example.com ", "password-sentinel")
    expect(result).toEqual({
      access: "id-token",
      refresh: "refresh-token",
      lifetimeMs: 3_600_000,
      user: {
        uid: "user-1",
        email: "person@example.com",
        displayName: "SUBI User",
        role: row.role,
        accountType: row.accountType,
        schoolId: "school-1",
        ...row.id,
      },
    })
    expect(local.requests.map((request) => request.path)).toEqual([
      "/v1/accounts:signInWithPassword",
      "/v1/accounts:lookup",
      "/v1/projects/learnsmart-c2a7e/databases/(default)/documents/users/user-1",
    ])
    expect(JSON.parse(local.requests[0]!.body)).toEqual({
      email: "person@example.com",
      password: "password-sentinel",
      returnSecureToken: true,
    })
    expect(local.requests[2]!.authorization).toBe("Bearer id-token")
    expect(JSON.stringify(result.user)).not.toContain("token")
  })

  test.each([
    { input: { verified: false }, message: "verify your LearnSmart email", count: 2 },
    { input: { reset: true }, message: "reset your temporary LearnSmart password", count: 3 },
    { input: { role: "admin" }, message: "account type cannot use SUBI", count: 3 },
    { input: { lookupUid: "other-user" }, message: "Unable to verify", count: 2 },
  ])("rejects an ineligible or mismatched profile: $input", async (row) => {
    await using local = fixture(row.input)
    await expect(local.auth.signIn("person@example.com", "password")).rejects.toThrow(row.message)
    expect(local.requests).toHaveLength(row.count)
  })

  test("refresh rotates credentials and revalidates identity and role", async () => {
    await using local = fixture()
    const result = await local.auth.refresh("old-refresh", "user-1")
    expect(result).toMatchObject({
      access: "fresh-id-token",
      refresh: "rotated-refresh",
      lifetimeMs: 3_600_000,
      user: { uid: "user-1" },
    })
    expect(new URLSearchParams(local.requests[0]!.body).get("refresh_token")).toBe("old-refresh")
    expect(local.requests[2]!.authorization).toBe("Bearer fresh-id-token")
  })

  test("refresh cannot silently switch the saved account", async () => {
    await using local = fixture({ refreshUid: "other-user" })
    await expect(local.auth.refresh("old-refresh", "user-1")).rejects.toThrow("Unable to verify")
    expect(local.requests).toHaveLength(1)
  })

  test.each([400, 401, 403, 500])("sanitizes upstream failures: %i", async (status) => {
    await using local = fixture({ error: status })
    const error = await local.auth.signIn("person@example.com", "password").catch((error: Error) => error)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).not.toContain("unsafe")
    expect(local.requests).toHaveLength(1)
  })

  test("does not forward credentials through redirects", async () => {
    await using local = fixture({ redirect: true })
    await expect(local.auth.signIn("person@example.com", "password")).rejects.toThrow()
    expect(local.requests).toHaveLength(1)
  })

  test("rejects missing input and cancellation before dispatch", async () => {
    await using local = fixture()
    await expect(local.auth.signIn("", "password")).rejects.toThrow("email and password")
    await expect(local.auth.signIn("person@example.com", "password", AbortSignal.abort())).rejects.toThrow()
    expect(local.requests).toHaveLength(0)
  })
})
