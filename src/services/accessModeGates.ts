import type { SubiAccessMode, SubiIdentity } from '../types';

/**
 * Access-mode gates (Phase 7 Change 1).
 *
 * TWO concepts:
 * - LearnSmart MODE (accessMode === 'learnsmart') is the PRIMARY gate for
 *   hiding/blocking BYOK provider functionality. It must NOT wait for
 *   identity restore: during startup accessMode can already be 'learnsmart'
 *   while identity is briefly guest/loading.
 * - Authenticated LearnSmart (mode + identity.type === 'learnsmart') gates
 *   identity-dependent managed features (profile, sign-out, managed model
 *   selection, retry/refresh).
 *
 * Pure helpers, vscode-free so they are unit-testable with node:test. The
 * webview mirrors this same logic (media/sidebar.js) for presentation;
 * the host gate remains the authorization boundary.
 */

/** Primary BYOK/UI isolation gate. */
export function isLearnSmartMode(accessMode: SubiAccessMode | null | undefined): boolean {
  return accessMode === 'learnsmart';
}

/** Authenticated LearnSmart: mode plus a valid LearnSmart identity. */
export function isAuthenticatedLearnSmart(
  accessMode: SubiAccessMode | null | undefined,
  identity: SubiIdentity | null | undefined
): boolean {
  return accessMode === 'learnsmart' && !!identity && identity.type === 'learnsmart';
}

/**
 * BYOK-only actions (configure/remove provider key, provider/model
 * selection, catalogue fetch/refresh, cost consent, BYOK send) may run
 * only when NOT in LearnSmart mode. Identity is irrelevant here.
 */
export function canUseByokActions(accessMode: SubiAccessMode | null | undefined): boolean {
  return !isLearnSmartMode(accessMode);
}

/**
 * Managed actions additionally require an authenticated LearnSmart
 * identity. Managed-session state (allowed/blocked/unavailable) is still
 * enforced separately by ManagedSessionController.
 */
export function canUseManagedActions(
  accessMode: SubiAccessMode | null | undefined,
  identity: SubiIdentity | null | undefined
): boolean {
  return isAuthenticatedLearnSmart(accessMode, identity);
}
