import { EventEmitter, type Disposable, type Event } from '../../platform/EventEmitter';
import { type Auth, signInWithEmailAndPassword, signOut as firebaseSignOut } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import type { LearnSmartRole, SafeLearnSmartUser, SubiIdentity } from '../../types';
import { LearnSmartFirebase } from './LearnSmartFirebase';

/**
 * LearnSmart student/teacher authentication (Stage 4A.3).
 *
 * Firebase Authentication is the ONLY password authority; the Firestore
 * users/{uid} profile supplies role gating only. Session-scoped: Firebase
 * Auth persists in extension-host memory for the VS Code window lifetime,
 * nothing is persisted to globalState/SecretStorage by this service.
 *
 * Knows NOTHING about AI providers. Never writes users/{uid} (no
 * activeSession/deviceId/session logic — the website session is independent).
 */
export class LearnSmartAuthService implements Disposable {
  private readonly firebase: LearnSmartFirebase;
  private readonly emitter = new EventEmitter<SubiIdentity>();
  private currentUser: SafeLearnSmartUser | null = null;
  /**
   * Optional sanitized diagnostic hook (stage + error code only — never
   * credentials, tokens, UIDs, or profile data). Set by the host owner
   * (SidebarProvider) to route into the Subi OutputChannel.
   */
  public onDiagnostic: ((diagnostic: { stage: string; code: string }) => void) | undefined;

  /** Broadcast whenever SUBI identity changes (sign-in, sign-out, restore). */
  public readonly onDidChangeIdentity: Event<SubiIdentity> = this.emitter.event;

  constructor(firebase: LearnSmartFirebase) {
    this.firebase = firebase;
  }

  dispose(): void {
    this.emitter.dispose();
    this.currentUser = null;
  }

  getCurrentUser(): SafeLearnSmartUser | null {
    return this.currentUser;
  }

  getIdentity(): SubiIdentity {
    return this.currentUser ? { type: 'learnsmart', user: this.currentUser } : { type: 'guest' };
  }

  /**
   * Extension-side fresh Firebase ID token for managed backend requests
   * (Phase 6). The token is returned to the in-memory caller only: never
   * persisted, never logged, never sent to the webview. Callers must place
   * it solely in the Authorization request header and drop the reference.
   */
  async getIdToken(forceRefresh = false): Promise<string> {
    let auth: Auth;
    try {
      auth = this.firebase.getAuthInstance();
    } catch {
      throw new Error('LearnSmart sign-in is not configured.');
    }
    const sessionUser = auth.currentUser;
    if (!sessionUser) {
      throw new Error('LearnSmart session has expired. Please sign in again.');
    }
    try {
      return await sessionUser.getIdToken(forceRefresh);
    } catch (error) {
      this.diagnose('id-token', error);
      throw new Error('Unable to refresh LearnSmart session. Please sign in again.');
    }
  }

  async signIn(email: string, password: string): Promise<SafeLearnSmartUser> {
    const emailNorm = email.trim().toLowerCase();
    if (emailNorm.length === 0 || password.length === 0) {
      throw new Error('Please enter both email and password.');
    }
    let auth: Auth;
    try {
      auth = this.firebase.getAuthInstance();
    } catch {
      this.diagnose('firebase-init');
      throw new Error('LearnSmart sign-in is not configured.');
    }
    this.diagnose('firebase-sign-in');
    try {
      await signInWithEmailAndPassword(auth, emailNorm, password);
    } catch (error) {
      this.diagnose('firebase-sign-in', error);
      await this.signOutFirebase(auth);
      throw new Error(this.mapAuthError(error));
    }
    // Auth-only milestone: reached before any Firestore/profile work.
    this.diagnose('firebase-auth-success');
    try {
      const user = await this.buildSafeUser(auth);
      this.currentUser = user;
      this.emitter.fire({ type: 'learnsmart', user });
      this.diagnose('identity-commit');
      return user;
    } catch (error) {
      // buildSafeUser already diagnosed its failing stage.
      await this.signOutFirebase(auth);
      this.currentUser = null;
      throw error instanceof Error ? error : new Error('Unable to sign in to LearnSmart.');
    }
  }

  async signOut(): Promise<void> {
    try {
      await firebaseSignOut(this.firebase.getAuthInstance());
    } catch {
      // Already signed out or Firebase unavailable; identity still clears.
    }
    this.currentUser = null;
    this.emitter.fire({ type: 'guest' });
  }

  /**
   * Session-scoped restoration: only succeeds when Firebase still holds an
   * authenticated user in this extension-host lifecycle, and always
   * revalidates verification, profile, and role. Never trusts a cached
   * SafeLearnSmartUser alone.
   */
  async restoreSession(options: { preserveSessionOnTransientFailure?: boolean } = {}): Promise<SafeLearnSmartUser | null> {
    let auth: Auth;
    try {
      auth = this.firebase.getAuthInstance();
      // LOCAL persistence initializes asynchronously in the CLI. An initial null
      // currentUser is not evidence that the persisted account was signed out.
      if (typeof auth.authStateReady === 'function') await auth.authStateReady();
    } catch {
      if(options.preserveSessionOnTransientFailure)throw Object.assign(new Error('Your saved LearnSmart session is preserved. Check your connection and reopen SUBI.'),{code:'SESSION_RESTORE_UNAVAILABLE'});
      return null;
    }
    if (!auth.currentUser) {
      return null;
    }
    try {
      const user = await this.buildSafeUser(auth);
      this.currentUser = user;
      this.emitter.fire({ type: 'learnsmart', user });
      return user;
    } catch (error) {
      if (options.preserveSessionOnTransientFailure && (errorCodeOf(error) === 'AUTH_PROFILE_UNAVAILABLE' || this.isNetworkError(error))) {
        this.currentUser = null;
        throw Object.assign(new Error('Your saved LearnSmart session is preserved. Check your connection and reopen SUBI.'), { code: 'SESSION_RESTORE_UNAVAILABLE' });
      }
      await this.signOutFirebase(auth);
      this.currentUser = null;
      return null;
    }
  }

  private async signOutFirebase(auth: Auth): Promise<void> {
    try {
      await firebaseSignOut(auth);
    } catch {
      // Best-effort cleanup; the caller still clears local identity.
    }
  }

  private async buildSafeUser(auth: Auth): Promise<SafeLearnSmartUser> {
    const sessionUser = auth.currentUser;
    if (!sessionUser) {
      this.diagnose('firebase-reload');
      throw new Error('Unable to sign in to LearnSmart.');
    }
    const uid = sessionUser.uid;
    this.diagnose('firebase-reload');
    try {
      // Correct modular API: reload() is an instance method on the User
      // object (refreshes emailVerified/claims). Kept: signIn responses can
      // carry stale verification state.
      await sessionUser.reload();
    } catch (error) {
      this.diagnose('firebase-reload', error);
      // Reload is best-effort; stale flags below still fail closed if false.
    }
    const fresh = auth.currentUser;
    if (!fresh || fresh.uid !== uid) {
      throw new Error('Unable to sign in to LearnSmart.');
    }
    this.diagnose('email-verification');
    if (fresh.emailVerified !== true) {
      throw new Error('Please verify your LearnSmart email before using Subi.');
    }
    let profile: Record<string, unknown>;
    this.diagnose('firestore-profile-read');
    try {
      const snap = await getDoc(doc(this.firebase.getDb(), 'users', uid));
      if (!snap.exists()) {
        throw new Error('LearnSmart user profile not found.');
      }
      profile = snap.data() as Record<string, unknown>;
    } catch (error) {
      this.diagnose('firestore-profile-read', error);
      if (error instanceof Error && error.message.length > 0 && !this.isNetworkError(error)) {
        // Preserve our own friendly validation errors; fall through otherwise.
        if (isFriendlyAuthError(error.message)) {
          throw error;
        }
      }
      throw Object.assign(new Error(this.mapReadError(error)), this.isNetworkError(error) ? { code: 'AUTH_PROFILE_UNAVAILABLE' } : {});
    }

    this.diagnose('force-password-reset');
    if (profile['forcePasswordReset'] === true) {
      throw new Error(
        'Please reset your temporary LearnSmart password on the LearnSmart website before using Subi.'
      );
    }

    this.diagnose('role-validation');
    const role = normalizeRole(profile['role']);
    if (role !== 'student' && role !== 'teacher') {
      throw new Error('This LearnSmart account type cannot use Subi.');
    }

    // Subscription/access/quota decisions belong to managed HTTP bootstrap.
    // Login only supplies a safe authenticated identity for that request.

    this.diagnose('safe-user-mapping');

    const email = typeof fresh.email === 'string' && fresh.email.length > 0 ? fresh.email : '';
    const displayName = firstNonEmptyString(profile['displayName'], profile['name']);
    const schoolId = firstNonEmptyString(profile['schoolId']);
    const accountType = profile['accountType'] === 'individual' || profile['accountType'] === 'school' ? profile['accountType'] : undefined;
    const user: SafeLearnSmartUser = { uid, email, role, ...(accountType ? { accountType } : {}) };
    if (displayName) {
      user.displayName = displayName;
    }
    if (schoolId) {
      user.schoolId = schoolId;
    }
    // XOR discipline: only the matching role's id field may be populated.
    if (role === 'student') {
      const studentId = asNonEmptyString(profile['studentId']);
      if (studentId) {
        user.studentId = studentId;
      }
    } else {
      const teacherId = asNonEmptyString(profile['teacherId']);
      if (teacherId) {
        user.teacherId = teacherId;
      }
    }
    return user;
  }

  /** Stage + safe error code only. Never email, password, tokens, UIDs, or profiles. */
  private diagnose(stage: string, error?: unknown): void {
    try {
      const code = error === undefined ? 'ok' : errorCodeOf(error) || 'unknown';
      this.onDiagnostic?.({ stage, code });
    } catch {
      // Diagnostics must never break authentication.
    }
  }

  private mapAuthError(error: unknown): string {
    const code = errorCodeOf(error);
    if (
      code === 'auth/invalid-credential' ||
      code === 'auth/user-not-found' ||
      code === 'auth/wrong-password' ||
      code === 'auth/invalid-email'
    ) {
      return 'Invalid LearnSmart email or password.';
    }
    if (code === 'auth/user-disabled') {
      return 'This LearnSmart account is disabled.';
    }
    if (code === 'auth/too-many-requests') {
      return 'Too many sign-in attempts. Please try again later.';
    }
    if (
      code === 'auth/api-key-not-valid' ||
      code === 'auth/invalid-api-key' ||
      code === 'auth/project-not-found' ||
      code === 'auth/app-not-authorized' ||
      code === 'auth/unauthorized-domain' ||
      code === 'auth/operation-not-allowed'
    ) {
      return 'LearnSmart sign-in is currently unavailable. Please try again later.';
    }
    if (code === 'auth/network-request-failed' || code === 'auth/timeout') {
      return 'Unable to reach LearnSmart. Check your connection and try again.';
    }
    return 'Unable to sign in to LearnSmart.';
  }

  private mapReadError(error: unknown): string {
    const code = errorCodeOf(error);
    if (code === 'permission-denied') {
      return 'Unable to access the LearnSmart profile.';
    }
    if (this.isNetworkError(error)) {
      return 'Unable to reach LearnSmart. Check your connection and try again.';
    }
    return 'Unable to sign in to LearnSmart.';
  }

  private isNetworkError(error: unknown): boolean {
    const code = errorCodeOf(error);
    if (code === 'auth/network-request-failed' || code === 'unavailable' || code === 'deadline-exceeded') {
      return true;
    }
    const message = error instanceof Error ? error.message.toLowerCase() : '';
    return (
      message.includes('network') ||
      message.includes('fetch failed') ||
      message.includes('failed to fetch') ||
      message.includes('timeout')
    );
  }
}

function errorCodeOf(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') {
      return code;
    }
  }
  return '';
}

function normalizeRole(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const v of values) {
    const s = asNonEmptyString(v);
    if (s) {
      return s;
    }
  }
  return undefined;
}

/** Firestore Timestamp | Date | millis | ISO string -> epoch millis, or 0. */
function toMillis(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : 0;
  }
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : 0;
  }
  if (typeof value === 'object') {
    const v = value as { toDate?: unknown; seconds?: unknown };
    if (typeof v.toDate === 'function') {
      try {
        const d = (v.toDate as () => unknown)();
        if (d instanceof Date) {
          const t = d.getTime();
          return Number.isFinite(t) ? t : 0;
        }
      } catch {
        return 0;
      }
    }
    if (typeof v.seconds === 'number') return v.seconds * 1000;
  }
  return 0;
}

const FRIENDLY_AUTH_MESSAGES: ReadonlySet<string> = new Set([
  'LearnSmart user profile not found.',
  'Subi Code is not activated on your individual plan. Add it from LearnSmart pricing to use Subi in VS Code.',
  'Your LearnSmart plan has expired. Renew your plan to continue using Subi.',
  "Your school's LearnSmart plan has expired. Please contact your school admin.",
]);

function isFriendlyAuthError(message: string): boolean {
  return FRIENDLY_AUTH_MESSAGES.has(message);
}

export type { LearnSmartRole };
