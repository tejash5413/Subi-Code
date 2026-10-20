import type { SafeLearnSmartUser } from '../../types';
import type {
  ManagedErrorCode,
  ManagedFileCapability,
  ManagedModel,
  ManagedModelsResult,
  ManagedMonthlyLimit,
  ManagedSendState,
  ManagedSessionState,
  ManagedSessionUser,
  ManagedSubscriptionState,
  ManagedUsageResponse,
  ManagedWebviewState,
  SubiCodeStatus,
} from './managedTypes';
import { emptyMonthlyLimit, idleManagedSession, idleManagedUsage, resolveManagedQuotaMode } from './managedTypes';
import { summarizeSubiCredits } from './subiCreditSummary';
import type { ManagedPermissionPolicy } from '../../core/permissions/PermissionProfile';
import { ManagedError } from './learnsmartManagedService';

/**
 * LearnSmart managed session controller (Phase 6).
 *
 * Coordinates LearnSmartAuthService + LearnSmartManagedService into one
 * memory-only ManagedSessionState. Owns bootstrap ordering (access first,
 * then models + monthly-limit in parallel), a monotonic generation guard so
 * late responses never restore stale sessions, and per-bootstrap
 * AbortControllers. Performs NO provider inference and touches NO BYOK
 * secrets, NO provider registry, NO Firestore.
 *
 * vscode-free by design: persistence and notification travel through
 * injected ports so the controller is unit-testable with node:test.
 */

/** GlobalState key for the selected managed modelKey (safe identifier only). */
export const MANAGED_SELECTION_KEY = 'subi.selectedManagedModel';

/** Minimal auth surface the controller needs (implemented by LearnSmartAuthService). */
export interface ManagedAuthPort {
  getCurrentUser(): SafeLearnSmartUser | null;
  getIdToken(forceRefresh?: boolean): Promise<string>;
}

/** Minimal managed-backend surface (implemented by LearnSmartManagedService). */
export interface ManagedServicePort {
  getAccessStatus(
    idToken: string,
    signal?: AbortSignal
  ): Promise<{ allowed: boolean; permissionPolicy?: ManagedPermissionPolicy; agentAvailable?: boolean; quotaMode?: import('./managedTypes').ManagedQuotaMode; accountType?: 'school' | 'individual'; code?: string; agentFile?: ManagedFileCapability; agentTerminal?: 'none' | 'terminal'; agentImage?: 'image_v1'; agentJobs?: 'jobs_v1'; agentCoordination?: 'coordination_v1'; agentMcp?: 'mcp_v1'; agentPty?: 'pty_v1'; toolCapabilities?: Array<'agent_skills_v1'> }>;
  // Array form keeps injected pre-source service adapters compatible during
  // a rolling extension update; production returns ManagedModelsResult.
  getModels(idToken: string, signal?: AbortSignal): Promise<ManagedModelsResult | ManagedModel[]>;
  getMonthlyLimit(idToken: string, signal?: AbortSignal): Promise<ManagedMonthlyLimit>;
  getUsage(idToken: string, signal?: AbortSignal): Promise<ManagedUsageResponse>;
  /** Optional for rolling compatibility with older injected adapters. */
  getSubiCodeStatus?(idToken: string, signal?: AbortSignal): Promise<SubiCodeStatus>;
}

/** Managed selection persistence (GlobalState adapter in production). */
export interface ManagedSelectionStore {
  /** The caller captures this UID before async work; adapters never resolve a later account. */
  loadSelectedModelKey(uid?: string): string | undefined;
  saveSelectedModelKey(modelKey: string | undefined, uid?: string): void | Promise<void>;
}

function codeOf(error: unknown): ManagedErrorCode {
  if (error instanceof ManagedError) {
    return error.code;
  }
  return 'managed_network';
}

export class ManagedSessionController {
  private readonly auth: ManagedAuthPort;
  private readonly service: ManagedServicePort;
  private readonly store: ManagedSelectionStore;
  private generation = 0;
  private permissionRefreshSequence = 0;
  private readonly activeControllers = new Set<AbortController>();
  private state: ManagedSessionState = idleManagedSession();

  /** Fired after every state transition (host posts the safe projection). */
  public onStateChanged: ((state: ManagedSessionState) => void) | undefined;

  /**
   * Bootstrap step diagnostics (Output → Subi). Invoked with safe
   * step/code pairs only (never tokens/UIDs); host appends them to the
   * output channel so future bootstrap failures are immediately obvious.
   */
  public onBootstrapStep: ((step: string, code: string, status?: number) => void) | undefined;

  /** Safe step reporter: observability only, never throws. */
  private reportStep(step: string, code: string, status?: number): void {
    try {
      this.onBootstrapStep?.(step, code, status);
    } catch {
      // Diagnostics must never affect the session.
    }
  }

  constructor(auth: ManagedAuthPort, service: ManagedServicePort, store: ManagedSelectionStore) {
    this.auth = auth;
    this.service = service;
    this.store = store;
  }

  /** Defensive copy: callers and the webview must not mutate controller state. */
  getState(): ManagedSessionState {
    const usageInner = this.state.usage.usage;
    return {
      ...this.state,
      models: [...this.state.models],
      ...(this.state.agentPty ? { agentPty: this.state.agentPty } : {}),
      ...(this.state.agentMcp ? { agentMcp: this.state.agentMcp } : {}),
      ...(this.state.agentCoordination ? { agentCoordination: this.state.agentCoordination } : {}),
      ...(this.state.agentJobs ? { agentJobs: this.state.agentJobs } : {}),
      ...(this.state.toolCapabilities ? { toolCapabilities: [...this.state.toolCapabilities] } : {}),
      monthlyLimit: {
        ...this.state.monthlyLimit,
        ...(this.state.monthlyLimit.credits ? { credits: { ...this.state.monthlyLimit.credits } } : {}),
      },
      user: this.state.user ? { ...this.state.user } : undefined,
      ...(this.state.permissionPolicy ? { permissionPolicy: { ...this.state.permissionPolicy } } : {}),
      usage: {
        ...this.state.usage,
        ...(usageInner
          ? {
              usage: {
                ...usageInner,
                ...(usageInner.credits ? { credits: { ...usageInner.credits } } : {}),
              },
            }
          : {}),
      },
      ...(this.state.subscription ? { subscription: { ...this.state.subscription } } : {}),
    };
  }

  /**
   * Run the managed bootstrap: identity → token → access-status →
   * (models + monthly-limit in parallel) → allowed/blocked/unavailable.
   * Never rejects: every failure lands in state. Stale generations are
   * discarded silently.
   */
  async bootstrap(): Promise<void> {
    const generation = ++this.generation;
    this.abortActiveRequests();
    this.setState({ ...idleManagedSession(), status: 'loading' });

    const user = this.auth.getCurrentUser();
    if (!user) {
      if (this.isCurrent(generation)) {
        this.setState(idleManagedSession());
      }
      return;
    }
    const sessionUser: ManagedSessionUser = {
      uid: user.uid,
      role: user.role,
      ...(user.accountType ? { accountType: user.accountType } : {}),
      ...(user.displayName ? { displayName: user.displayName } : {}),
    };

    let idToken: string;
    try {
      // Transient: lives in this local only, used as a request header below.
      idToken = await this.auth.getIdToken(false);
    } catch {
      if (!this.isCurrent(generation)) {
        return;
      }
      this.setState({
        ...idleManagedSession(),
        status: 'unavailable',
        user: sessionUser,
        errorCode: 'managed_auth',
      });
      return;
    }
    if (!this.isCurrent(generation)) {
      return;
    }

    const accessSignal = this.track(new AbortController());
    let access: Awaited<ReturnType<ManagedServicePort['getAccessStatus']>>;
    try {
      access = await this.service.getAccessStatus(idToken, accessSignal.signal);
      this.reportStep('access-status', access.allowed ? 'OK' : access.code ?? 'SUBI_ACCESS_DISABLED', 200);
      if (access.accountType) sessionUser.accountType = access.accountType;
    } catch (error) {
      if (!this.isCurrent(generation)) {
        return;
      }
      this.reportStep('access-status', codeOf(error), error instanceof ManagedError ? error.httpStatus : undefined);
      this.setState({
        ...idleManagedSession(),
        status: 'unavailable',
        user: sessionUser,
        errorCode: codeOf(error),
      });
      return;
    } finally {
      this.untrack(accessSignal);
    }
    if (!this.isCurrent(generation)) {
      return;
    }
    if (!access.allowed) {
      // Entitlement denial must still retain the server's account display
      // context so an expired individual can renew without seeing school
      // token UI. This never grants models, quota authority, or send access.
      let subscriptionStatus: SubiCodeStatus | null = null;
      if (this.service.getSubiCodeStatus) {
        const deniedSubiSignal = this.track(new AbortController());
        try {
          subscriptionStatus = await this.service.getSubiCodeStatus(idToken, deniedSubiSignal.signal);
        } catch {
          // Best-effort display data; the access denial remains authoritative.
        } finally {
          this.untrack(deniedSubiSignal);
        }
      }
      if (!this.isCurrent(generation, user.uid)) return;
      this.setState({
        ...idleManagedSession(),
        status: 'blocked',
        user: sessionUser,
        errorCode: access.code ?? 'SUBI_ACCESS_DISABLED',
        ...(access.quotaMode ? { accessQuotaMode: access.quotaMode } : {}),
        ...(subscriptionStatus ? {
          monthlyLimit: {
            ...emptyMonthlyLimit(),
            ...(subscriptionStatus.quotaMode ? { quotaMode: subscriptionStatus.quotaMode } : {}),
          },
          subscription: {
            active: subscriptionStatus.active,
            renewalDateMs: subscriptionStatus.renewalDateMs,
            source: subscriptionStatus.source,
            ...(subscriptionStatus.quotaMode ? { quotaMode: subscriptionStatus.quotaMode } : {}),
          },
        } : {}),
      });
      return;
    }

    const modelsSignal = this.track(new AbortController());
    const limitSignal = this.track(new AbortController());
    const subiSignal = this.track(new AbortController());
    let modelResponse: ManagedModelsResult | ManagedModel[];
    let monthlyLimit: ManagedMonthlyLimit;
    // SUBI subscription snapshot is best-effort display data: it must never
    // fail an otherwise valid session (school or individual). A rejection
    // leaves `subscription` absent (unknown) rather than unavailable.
    let subscription: ManagedSubscriptionState | undefined;
    try {
      // Per-step taps report diagnostics without changing fail-fast
      // semantics: the first rejection still fails the whole bootstrap.
      const modelsTap = this.service.getModels(idToken, modelsSignal.signal).then(
        (v) => {
          this.reportStep('models', 'OK', 200);
          return v;
        },
        (e: unknown) => {
          this.reportStep('models', codeOf(e), e instanceof ManagedError ? e.httpStatus : undefined);
          throw e;
        }
      );
      const limitTap = this.service.getMonthlyLimit(idToken, limitSignal.signal).then(
        (v) => {
          this.reportStep('monthly-limit', 'OK', 200);
          return v;
        },
        (e: unknown) => {
          this.reportStep('monthly-limit', codeOf(e), e instanceof ManagedError ? e.httpStatus : undefined);
          throw e;
        }
      );
      const [modelsResult, limitResult, subiResult] = await Promise.all([
        modelsTap,
        limitTap,
        this.service.getSubiCodeStatus
          ? Promise.all([modelsTap, limitTap]).then(() => this.service
            .getSubiCodeStatus!(idToken, subiSignal.signal)
            .then(
              (v) => {
                this.reportStep('subicode-status', 'OK', 200);
                return v;
              },
              (): null => {
                this.reportStep('subicode-status', 'skipped');
                return null;
              }
            ))
          : Promise.resolve(null),
      ]);
      modelResponse = modelsResult;
      monthlyLimit = limitResult;
      if (subiResult !== null) {
        subscription = {
          active: subiResult.active,
          renewalDateMs: subiResult.renewalDateMs,
          ...(subiResult.source ? { source: subiResult.source } : {}),
          ...(subiResult.quotaMode ? { quotaMode: subiResult.quotaMode } : {}),
        };
      }
    } catch (error) {
      if (!this.isCurrent(generation)) {
        return;
      }
      this.setState({
        ...idleManagedSession(),
        status: 'unavailable',
        user: sessionUser,
        errorCode: codeOf(error),
        ...(access.quotaMode ? { accessQuotaMode: access.quotaMode } : {}),
      });
      return;
    } finally {
      this.untrack(modelsSignal);
      this.untrack(limitSignal);
      this.untrack(subiSignal);
    }
    if (!this.isCurrent(generation)) {
      return;
    }

    const modelResult: ManagedModelsResult = Array.isArray(modelResponse)
      ? { models: modelResponse }
      : modelResponse;
    const models = modelResult.models;

    // A saved model is a user choice, not a catalog preference. Preserve it
    // when assignments change; send eligibility rejects an unavailable key
    // until the user explicitly chooses an assigned model. Only a new account
    // with no selection receives the initial catalog default.
    const saved = this.store.loadSelectedModelKey(user.uid);
    let selectedModelKey: string | undefined;
    if (saved) {
      selectedModelKey = saved;
    } else {
      const first = models[0];
      if (first) {
        selectedModelKey = first.modelKey;
        await this.store.saveSelectedModelKey(selectedModelKey, user.uid);
        if (!this.isCurrent(generation, user.uid)) return;
      }
    }

    if (!this.isCurrent(generation, user.uid)) return;
    this.setState({
      status: 'allowed',
      ...(access.permissionPolicy ? { permissionPolicy: { ...access.permissionPolicy } } : {}),
      user: sessionUser,
      ...(access.quotaMode ? { accessQuotaMode: access.quotaMode } : {}),
      models,
      ...(modelResult.source ? { modelSource: modelResult.source } : {}),
      ...(selectedModelKey ? { selectedModelKey } : {}),
      monthlyLimit,
      ...(subscription ? { subscription } : {}),
      usage: idleManagedUsage(),
      // Phase 15: server-authoritative file capability (fail closed 'none').
      agentFileCapability: access.allowed === true ? (access.agentFile ?? 'none') : 'none',
      ...(typeof access.agentAvailable === 'boolean' ? { agentAvailable: access.agentAvailable } : {}),
        agentTerminalCapability: access.allowed === true ? (access.agentTerminal ?? 'none') : 'none',
      ...(access.allowed === true && access.agentPty ? { agentPty: access.agentPty } : {}),
      ...(access.allowed === true && access.agentMcp ? { agentMcp: access.agentMcp } : {}),
      ...(access.allowed === true && access.agentCoordination ? { agentCoordination: access.agentCoordination } : {}),
      ...(access.allowed === true && access.agentJobs ? { agentJobs: access.agentJobs } : {}),
      ...(access.allowed === true && access.toolCapabilities ? { toolCapabilities: [...access.toolCapabilities] } : {}),
      ...(access.allowed === true && access.agentImage === 'image_v1' ? { agentImageCapability: 'image_v1' as const } : {}),
    });

    // Phase 9C.1: usage + server capability load after the session is
    // otherwise allowed. Usage failure never fails the session: the account
    // stays allowed with a fail-closed capability and a dedicated usage
    // error state (the account itself is not signed out by a usage fault).
    await this.loadUsageInto(generation, idToken);
  }

  /**
   * Focused usage/capability refresh (Phase 9C.1): re-reads usage for the
   * current user with generation + abort guards. Safe to call after model
   * changes or (in a future phase) managed chat settlement. Never throws.
   */
  async refreshUsage(): Promise<void> {
    const user = this.auth.getCurrentUser();
    if (!user) {
      return;
    }
    await this.loadUsageInto(this.generation, undefined);
  }

  /**
   * Best-effort SUBI subscription refresh. Re-reads /managed/subicode-status
   * for the current user; failures leave existing subscription state
   * untouched (unknown stays unknown). Never throws.
   */
  async refreshSubscription(): Promise<void> {
    const generation = this.generation;
    const user = this.auth.getCurrentUser();
    if (!user || !this.service.getSubiCodeStatus) {
      return;
    }
    let idToken: string;
    try {
      idToken = await this.auth.getIdToken(false);
    } catch {
      return;
    }
    if (!this.isCurrent(generation, user.uid)) {
      return;
    }
    const subiSignal = this.track(new AbortController());
    try {
      const result = await this.service.getSubiCodeStatus(idToken, subiSignal.signal);
      if (!this.isCurrent(generation, user.uid)) {
        return;
      }
      this.setState({
        ...this.getState(),
        subscription: {
          active: result.active,
          renewalDateMs: result.renewalDateMs,
          ...(result.source ? { source: result.source } : {}),
          ...(result.quotaMode ? { quotaMode: result.quotaMode } : {}),
        },
      });
    } catch {
      // Best-effort display data: keep the previous snapshot.
    } finally {
      this.untrack(subiSignal);
    }
  }

  /**
   * Combined account refresh for manual/balance-refresh flows: usage plus
   * subscription state. Never throws.
   */
  async refreshAccount(): Promise<void> {
    // A successful renewal can change admission itself, so refresh all
    // managed gates once before restoring a previously denied session.
    if (this.state.status === 'blocked' || this.state.status === 'unavailable') {
      await this.bootstrap();
      return;
    }
    await Promise.all([this.refreshUsage(), this.refreshSubscription(), this.refreshPermissionPolicy()]);
  }

  /** Refresh the authenticated permission ceiling without resetting models or drafts. */
  async refreshPermissionPolicy(): Promise<void> {
    const sequence = ++this.permissionRefreshSequence;
    const generation = this.generation;
    const user = this.auth.getCurrentUser();
    if (!user || this.state.status !== 'allowed' || this.state.user?.uid !== user.uid) return;
    const controller = this.track(new AbortController());
    try {
      const token = await this.auth.getIdToken();
      if (!this.isCurrent(generation, user.uid) || sequence !== this.permissionRefreshSequence) return;
      const access = await this.service.getAccessStatus(token, controller.signal);
      if (!this.isCurrent(generation, user.uid) || sequence !== this.permissionRefreshSequence || this.state.status !== 'allowed') return;
      if (!access.allowed) {
        this.setState({ ...idleManagedSession(), status: 'blocked', user: { ...this.state.user! }, errorCode: access.code ?? 'SUBI_ACCESS_DISABLED' });
        return;
      }
      const next = this.getState();
      delete next.permissionPolicy;
      if (access.permissionPolicy) next.permissionPolicy = { ...access.permissionPolicy };
      if (next.user && access.accountType) next.user.accountType = access.accountType;
      next.agentFileCapability = access.agentFile ?? 'none';
      next.agentTerminalCapability = access.agentTerminal ?? 'none';
      next.agentAvailable = access.agentAvailable;
      next.agentImageCapability = access.agentImage;
      next.agentJobs = access.agentJobs;
      next.agentCoordination = access.agentCoordination;
      next.agentPty = access.agentPty;
      next.agentMcp = access.agentMcp;
      next.toolCapabilities = access.toolCapabilities ? [...access.toolCapabilities] : undefined;
      this.setState(next);
    } catch {
      if (!this.isCurrent(generation, user.uid) || sequence !== this.permissionRefreshSequence || this.state.status !== 'allowed') return;
      // Expired sentinel is host-only and cannot create broader authority.
      this.setState({ ...this.getState(), permissionPolicy: { schemaVersion: 1, profileCeiling: 'ask', source: this.state.user?.accountType === 'school' ? 'school_role' : 'individual', validUntilMs: 0 } });
    } finally { this.untrack(controller); }
  }

  /**
   * Fetch usage for `generation` and merge it into state. When `idToken` is
   * omitted a fresh token is fetched first. Stale generations are discarded
   * silently; this method never throws.
   */
  private async loadUsageInto(generation: number, idToken: string | undefined): Promise<void> {
    if (this.isCurrent(generation)) {
      this.setState({ ...this.getState(), usage: { status: 'loading', chatAvailable: false } });
    }
    let token = idToken;
    if (token === undefined) {
      try {
        token = await this.auth.getIdToken(false);
      } catch {
        if (this.isCurrent(generation)) {
          this.setState({
            ...this.getState(),
            usage: { status: 'error', chatAvailable: false, errorCode: 'managed_auth', lastUpdatedAt: Date.now() },
          });
        }
        return;
      }
    }
    if (!this.isCurrent(generation)) {
      return;
    }
    const usageSignal = this.track(new AbortController());
    try {
      const result = await this.service.getUsage(token, usageSignal.signal);
      this.reportStep('usage', result.allowed ? 'OK' : result.code, 200);
      if (!this.isCurrent(generation)) {
        return;
      }
      if (result.allowed) {
        this.setState({
          ...this.getState(),
          usage: {
            status: 'ready',
            usage: result.usage,
            chatAvailable: result.chatAvailable,
            lastUpdatedAt: Date.now(),
          },
        });
      } else {
        // Denied after an allowed bootstrap: keep session state, expose no
        // quota details, close the capability.
        this.setState({
          ...this.getState(),
          usage: { status: 'error', chatAvailable: false, errorCode: result.code, lastUpdatedAt: Date.now() },
        });
      }
    } catch (error) {
      if (!this.isCurrent(generation)) {
        return;
      }
      this.setState({
        ...this.getState(),
        usage: { status: 'error', chatAvailable: false, errorCode: codeOf(error), lastUpdatedAt: Date.now() },
      });
      this.reportStep('usage', codeOf(error), error instanceof ManagedError ? error.httpStatus : undefined);
    } finally {
      this.untrack(usageSignal);
    }
  }

  /**
   * Select a managed modelKey from the CURRENT allowed list. Returns false
   * (no state change) unless the session is allowed and the key is eligible.
   */
  async setSelectedModelKey(modelKey: string): Promise<boolean> {
    const generation = this.generation;
    const uid = this.state.user?.uid;
    if (typeof modelKey !== 'string' || modelKey.length === 0) {
      return false;
    }
    if (this.state.status !== 'allowed') {
      return false;
    }
    if (!this.state.models.some((m) => m.modelKey === modelKey)) {
      return false;
    }
    if (uid === undefined || !this.isCurrent(generation, uid)) return false;
    await this.store.saveSelectedModelKey(modelKey, uid);
    if (!this.isCurrent(generation, uid)) return false;
    this.setState({ ...this.getState(), selectedModelKey: modelKey });
    return true;
  }

  /** Abort in-flight bootstrap requests without changing state. */
  abort(): void {
    this.generation += 1;
    this.abortActiveRequests();
  }

  /** Abort + return to idle (sign-out, mode switch, reset). Notifies. */
  clear(): void {
    this.generation += 1;
    this.abortActiveRequests();
    this.setState(idleManagedSession());
  }

  dispose(): void {
    this.generation += 1;
    this.permissionRefreshSequence += 1;
    this.abortActiveRequests();
    this.onStateChanged = undefined;
  }

  private isCurrent(generation: number, uid?: string): boolean {
    return generation === this.generation && (uid === undefined || this.auth.getCurrentUser()?.uid === uid);
  }

  private track(controller: AbortController): AbortController {
    this.activeControllers.add(controller);
    return controller;
  }

  private untrack(controller: AbortController): void {
    this.activeControllers.delete(controller);
  }

  private abortActiveRequests(): void {
    for (const controller of this.activeControllers) {
      try {
        controller.abort();
      } catch {
        // Best-effort cancellation only.
      }
    }
    this.activeControllers.clear();
  }

  private setState(next: ManagedSessionState): void {
    this.state = next;
    try {
      this.onStateChanged?.(this.getState());
    } catch {
      // Notification failures must never corrupt session state.
    }
  }
}

/**
 * Phase 17: coarse model capability label for the picker. Fixed strings
 * only (never ids); a model without terminal/verify marks still works in
 * ASK/PLAN and is never hidden globally by this label.
 */
export function modelCapabilityLabel(capabilities: {
  agentTerminal?: string;
  agentVerify?: string;
}): 'Verification ✓' | 'Terminal only' | 'Verification unavailable' | 'File tools only' {
  if (capabilities.agentVerify === 'verified') return 'Verification ✓';
  if (capabilities.agentVerify === 'unsupported') return 'Verification unavailable';
  if (capabilities.agentTerminal === 'verified') return 'Terminal only';
  return 'File tools only';
}

/**
 * Explicit safe projection for webview.postMessage(). Only allowlisted
 * scalar fields cross the boundary — structurally incapable of carrying
 * tokens, keys, upstream identifiers, or admin metadata.
 *
 * `sendState` is computed by the host (SidebarProvider) from session state
 * plus build/busy inputs and passed explicitly; when omitted the projection
 * fails closed to a disabled Send.
 */
export function toManagedWebviewState(
  state: ManagedSessionState,
  sendState?: ManagedSendState
): ManagedWebviewState {
  const quotaMode = resolveManagedQuotaMode(state);
  const displaySubscription = state.subscription ??
    (state.status === 'blocked' && (state.errorCode === 'SUBI_PLAN_EXPIRED' || state.errorCode === 'SUBI_CODE_REQUIRED')
      ? { active: false, renewalDateMs: null } : undefined);
  // The credit summary rides the wire only for individual credit sessions;
  // the school wire shape stays byte-identical.
  const creditSummary = quotaMode === 'individual_credits'
    ? summarizeSubiCredits({
      quotaMode,
      usage: state.usage,
      ...(displaySubscription ? { subscription: displaySubscription } : {}),
    })
    : undefined;
  return {
    status: state.status,
    ...(typeof state.agentAvailable === 'boolean' ? { agentAvailable: state.agentAvailable } : {}),
    ...(state.accessQuotaMode ? { accessQuotaMode: state.accessQuotaMode } : {}),
    ...(creditSummary ? { creditSummary } : {}),
    ...(state.user
      ? {
          user: {
            uid: state.user.uid,
            ...(state.user.displayName ? { displayName: state.user.displayName } : {}),
            role: state.user.role,
            // Projected for the quotaMode fallback order only (never a
            // quota authority — usage/monthly-limit quotaMode win).
            ...(state.user.accountType ? { accountType: state.user.accountType } : {}),
          },
        }
      : {}),
    models: state.models.map((m) => ({
      modelKey: m.modelKey,
      displayName: m.displayName,
      capabilities: {
        inputModalities: [...m.capabilities.inputModalities],
        outputModalities: [...m.capabilities.outputModalities],
        toolCalling: m.capabilities.toolCalling,
        ...(m.capabilities.agentTerminal !== undefined ? { agentTerminal: m.capabilities.agentTerminal } : {}),
        ...(m.capabilities.agentVerify !== undefined ? { agentVerify: m.capabilities.agentVerify } : {}),
      },
      capabilityLabel: modelCapabilityLabel(m.capabilities),
      ...(m.contextLength === undefined || m.contextLength === null
        ? {}
        : { contextLength: m.contextLength }),
    })),
    ...(state.modelSource ? { modelSource: state.modelSource } : {}),
    ...(state.selectedModelKey ? { selectedModelKey: state.selectedModelKey } : {}),
    monthlyLimit: {
      configured: state.monthlyLimit.configured,
      monthlyTokenLimit: state.monthlyLimit.monthlyTokenLimit,
      period: state.monthlyLimit.period,
      ...(state.monthlyLimit.source ? { source: state.monthlyLimit.source } : {}),
      ...(state.monthlyLimit.quotaMode ? { quotaMode: state.monthlyLimit.quotaMode } : {}),
      ...(state.monthlyLimit.credits ? { credits: { ...state.monthlyLimit.credits } } : {}),
    },
    ...(state.subscription ? { subscription: { ...state.subscription } } : {}),
    ...(state.errorCode ? { errorCode: state.errorCode } : {}),
    usage: {
      status: state.usage.status,
      ...(state.usage.usage
        ? {
            usage: {
              ...state.usage.usage,
              ...(state.usage.usage.credits ? { credits: { ...state.usage.usage.credits } } : {}),
            },
          }
        : {}),
      chatAvailable: state.usage.chatAvailable,
      ...(state.usage.errorCode ? { errorCode: state.usage.errorCode } : {}),
    },
    sendState: sendState ?? { canSend: false, reason: 'build_disabled' },
  };
}
