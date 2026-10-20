import { LEARNSMART_FIREBASE_CONFIG } from "../../config/learnsmartFirebase"
import type { SafeLearnSmartUser } from "../../types"

export type NativeLearnSmartSession = {
  access: string
  refresh: string
  lifetimeMs: number
  user: SafeLearnSmartUser
}

export class NativeLearnSmartAuthError extends Error {
  constructor(message = "Unable to verify your LearnSmart account. Please sign in again.") {
    super(message)
    this.name = "NativeLearnSmartAuthError"
  }
}

/** Stateless Firebase transport: native credentials own refresh tokens, never a shared SDK user. */
export class NativeLearnSmartAuth {
  constructor(private readonly fetchFn: (url: string, init: RequestInit) => Promise<Response> = fetch) {}

  async signIn(email: string, password: string, signal?: AbortSignal): Promise<NativeLearnSmartSession> {
    if (!email.trim() || !password) throw new NativeLearnSmartAuthError("Please enter both email and password.")
    const result = await this.request(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${LEARNSMART_FIREBASE_CONFIG.apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase(), password, returnSecureToken: true }),
      },
      signal,
    )
    const access = requiredString(result.idToken)
    const refresh = requiredString(result.refreshToken)
    const uid = requiredString(result.localId)
    const lifetimeMs = lifetime(result.expiresIn)
    const user = await this.profile(access, uid, signal)

    return { access, refresh, lifetimeMs, user }
  }

  async refresh(refresh: string, expectedUid: string, signal?: AbortSignal): Promise<NativeLearnSmartSession> {
    requiredString(refresh)
    requiredString(expectedUid)
    const result = await this.request(
      `https://securetoken.googleapis.com/v1/token?key=${LEARNSMART_FIREBASE_CONFIG.apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh }).toString(),
      },
      signal,
    )
    if (requiredString(result.user_id) !== expectedUid) throw new NativeLearnSmartAuthError()
    const access = requiredString(result.id_token)
    const next = requiredString(result.refresh_token)
    const lifetimeMs = lifetime(result.expires_in)
    const user = await this.profile(access, expectedUid, signal)

    return { access, refresh: next, lifetimeMs, user }
  }

  private async profile(access: string, uid: string, signal?: AbortSignal): Promise<SafeLearnSmartUser> {
    const lookup = await this.request(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${LEARNSMART_FIREBASE_CONFIG.apiKey}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: access }) },
      signal,
    )
    if (!Array.isArray(lookup.users) || lookup.users.length !== 1) throw new NativeLearnSmartAuthError()
    const user = record(lookup.users[0])
    if (user.localId !== uid || user.disabled === true) throw new NativeLearnSmartAuthError()
    if (user.emailVerified !== true)
      throw new NativeLearnSmartAuthError("Please verify your LearnSmart email before using SUBI.")
    const document = await this.request(
      `https://firestore.googleapis.com/v1/projects/${LEARNSMART_FIREBASE_CONFIG.projectId}/databases/(default)/documents/users/${encodeURIComponent(uid)}`,
      { method: "GET", headers: { Authorization: `Bearer ${access}` } },
      signal,
    )
    const fields = record(document.fields)
    if (fields.forcePasswordReset !== undefined && record(fields.forcePasswordReset).booleanValue === true)
      throw new NativeLearnSmartAuthError(
        "Please reset your temporary LearnSmart password on the LearnSmart website before using SUBI.",
      )
    const string = (key: string) => {
      if (fields[key] === undefined) return undefined
      const value = record(fields[key]).stringValue

      return typeof value === "string" ? value.trim() || undefined : undefined
    }
    const role = string("role")?.toLowerCase()
    if (role !== "student" && role !== "teacher")
      throw new NativeLearnSmartAuthError("This LearnSmart account type cannot use SUBI.")
    const accountType = string("accountType")
    const displayName = string("displayName") ?? string("name")
    const schoolId = string("schoolId")
    const studentId = role === "student" ? string("studentId") : undefined
    const teacherId = role === "teacher" ? string("teacherId") : undefined

    return {
      uid,
      email: requiredString(user.email),
      role,
      ...(accountType === "school" || accountType === "individual" ? { accountType } : {}),
      ...(displayName ? { displayName } : {}),
      ...(schoolId ? { schoolId } : {}),
      ...(studentId ? { studentId } : {}),
      ...(teacherId ? { teacherId } : {}),
    }
  }

  private async request(url: string, init: RequestInit, signal?: AbortSignal) {
    if (signal?.aborted) throw new NativeLearnSmartAuthError("LearnSmart sign-in was cancelled.")

    try {
      const response = await this.fetchFn(url, {
        ...init,
        redirect: "error",
        cache: "no-store",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000),
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new NativeLearnSmartAuthError(
          response.status === 400 || response.status === 401
            ? "Invalid or expired LearnSmart credentials. Please sign in again."
            : "Unable to access LearnSmart right now. Please try again.",
        )
      }
      const value: unknown = await response.json()

      return record(value)
    } catch (error) {
      if (error instanceof NativeLearnSmartAuthError) throw error
      throw new NativeLearnSmartAuthError(
        signal?.aborted
          ? "LearnSmart sign-in was cancelled."
          : "Unable to reach LearnSmart. Check your connection and try again.",
      )
    }
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new NativeLearnSmartAuthError()

  return value as Record<string, unknown>
}

function requiredString(value: unknown) {
  if (typeof value !== "string" || !value.trim()) throw new NativeLearnSmartAuthError()

  return value
}

function lifetime(value: unknown) {
  const seconds = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 86_400) throw new NativeLearnSmartAuthError()

  return seconds * 1000
}
