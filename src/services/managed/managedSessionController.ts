import type { SafeLearnSmartUser } from '../../types';
import type {
  ManagedErrorCode,
  ManagedModel,
  ManagedMonthlyLimit,
  ManagedSessionState,
  ManagedSessionUser,
  ManagedWebviewState,
} from './managedTypes';
import { emptyMonthlyLimit, idleManagedSession } from './managedTypes';
import { ManagedError } from './learnsmartManagedService';
import type { LearnSmartManagedService } from './learnsmartManagedService';

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
  ): Promise<{ allowed: boolean; code?: string }>;
  getModels(idToken: string, signal?: AbortSignal): Promise<ManagedModel[]>;
  getMonthlyLimit(idToken: string, signal?: AbortSignal): Promise<ManagedMonthlyLimit>;
}

/** Managed selection persistence (GlobalState adapter in production). */
export interface ManagedSelectionStore {
  loadSelectedModelKey(): string | undefined;
  saveSelectedModelKey(modelKey: string | undefined): void | Promise<void>;
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
  private readonly activeControllers = new Set<AbortController>();
  private state: ManagedSessionState = idleManagedSession();

  /** Fired after every state transition (host posts the safe projection). */
  public onStateChanged: ((state: ManagedSessionState) => void) | undefined;

  constructor(auth: ManagedAuthPort, service: ManagedServicePort, store: ManagedSelectionStore) {
    this.auth = auth;
    this.service = service;
    this.store = store;
  }

  /** Defensive copy: callers and the webview must not mutate controller state. */
  getState(): ManagedSessionState {
    return {
      ...this.state,
      models: [...this.state.models],
      monthlyLimit: { ...this.state.monthlyLimit },
      user: this.state.user ? { ...this.state.user } : undefined,
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
    let access: { allowed: boolean; code?: string };
    try {
      access = await this.service.getAccessStatus(idToken, accessSignal.signal);
    } catch (error) {
      if (!this.isCurrent(generation)) {
        return;
      }
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
      this.setState({
        ...idleManagedSession(),
        status: 'blocked',
        user: sessionUser,
        errorCode: access.code ?? 'SUBI_ACCESS_DISABLED',
      });
      return;
    }

    const modelsSignal = this.track(new AbortController());
    const limitSignal = this.track(new AbortController());
    let models: ManagedModel[];
    let monthlyLimit: ManagedMonthlyLimit;
    try {
      [models, monthlyLimit] = await Promise.all([
        this.service.getModels(idToken, modelsSignal.signal),
        this.service.getMonthlyLimit(idToken, limitSignal.signal),
      ]);
    } catch (error) {
      if (!this.isCurrent(generation)) {
        return;
      }
      this.setState({
        ...idleManagedSession(),
        status: 'unavailable',
        user: sessionUser,
        errorCode: codeOf(error),
      });
      return;
    } finally {
      this.untrack(modelsSignal);
      this.untrack(limitSignal);
    }
    if (!this.isCurrent(generation)) {
      return;
    }

    // Restore the persisted managed modelKey only if still eligible.
    // Otherwise fall back to the first safe model (matches BYOK picker
    // behavior of selecting the first catalog model); empty list stays
    // allowed with no selection.
    const saved = this.store.loadSelectedModelKey();
    let selectedModelKey: string | undefined;
    if (saved && models.some((m) => m.modelKey === saved)) {
      selectedModelKey = saved;
    } else {
      if (saved !== undefined) {
        await this.store.saveSelectedModelKey(undefined);
      }
      if (models.length > 0) {
        selectedModelKey = models[0].modelKey;
        await this.store.saveSelectedModelKey(selectedModelKey);
      }
    }

    this.setState({
      status: 'allowed',
      user: sessionUser,
      models,
      ...(selectedModelKey ? { selectedModelKey } : {}),
      monthlyLimit,
    });
  }

  /**
   * Select a managed modelKey from the CURRENT allowed list. Returns false
   * (no state change) unless the session is allowed and the key is eligible.
   */
  async setSelectedModelKey(modelKey: string): Promise<boolean> {
    if (typeof modelKey !== 'string' || modelKey.length === 0) {
      return false;
    }
    if (this.state.status !== 'allowed') {
      return false;
    }
    if (!this.state.models.some((m) => m.modelKey === modelKey)) {
      return false;
    }
    await this.store.saveSelectedModelKey(modelKey);
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
    this.abortActiveRequests();
    this.onStateChanged = undefined;
  }

  private isCurrent(generation: number): boolean {
    return generation === this.generation;
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
 * Explicit safe projection for webview.postMessage(). Only allowlisted
 * scalar fields cross the boundary — structurally incapable of carrying
 * tokens, keys, upstream identifiers, or admin metadata.
 */
export function toManagedWebviewState(state: ManagedSessionState): ManagedWebviewState {
  return {
    status: state.status,
    ...(state.user
      ? {
          user: {
            uid: state.user.uid,
            ...(state.user.displayName ? { displayName: state.user.displayName } : {}),
            role: state.user.role,
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
      },
      ...(m.contextLength === undefined || m.contextLength === null
        ? {}
        : { contextLength: m.contextLength }),
    })),
    ...(state.selectedModelKey ? { selectedModelKey: state.selectedModelKey } : {}),
    monthlyLimit: {
      configured: state.monthlyLimit.configured,
      monthlyTokenLimit: state.monthlyLimit.monthlyTokenLimit,
      period: state.monthlyLimit.period,
    },
    ...(state.errorCode ? { errorCode: state.errorCode } : {}),
  };
}
