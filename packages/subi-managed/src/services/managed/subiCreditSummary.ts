import type {
  ManagedSubscriptionState,
  ManagedUsageState,
  SubiCreditHealth,
  SubiCreditSummary,
} from './managedTypes';

export type { SubiCreditHealth, SubiCreditSummary };

/**
 * Individual SUBI credit presentation helpers (pure; no vscode, no network).
 *
 * The backend is authoritative in milliCredits (1000 milli = 1 displayed
 * credit). This module only formats backend balances and derives display
 * states — it never prices models, estimates burn, or invents balances.
 */

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Formats backend milliCredits for display: whole credits when exact,
 * otherwise up to 1 decimal, with thousands separators.
 * 4200000 -> "4,200"; 1450000 -> "1,450"; 1450500 -> "1,450.5".
 */
export function formatSubiCredits(milliCredits: number | null | undefined): string {
  if (milliCredits === null || milliCredits === undefined || !Number.isSafeInteger(milliCredits) || milliCredits < 0) {
    return '–';
  }
  const whole = Math.floor(milliCredits / 1000);
  const remainder = milliCredits % 1000;
  if (remainder === 0) {
    return whole.toLocaleString('en-US');
  }
  const decimal = Math.floor(remainder / 100);
  if (decimal === 0) {
    return whole.toLocaleString('en-US');
  }
  return `${whole.toLocaleString('en-US')}.${decimal}`;
}

/** Local display date only (backend epoch stays authoritative; no logic use). */
export function formatSubiDate(epochMs: number | null | undefined, withYear = false): string {
  if (epochMs === null || epochMs === undefined || !Number.isSafeInteger(epochMs) || epochMs <= 0) {
    return '–';
  }
  try {
    const date = new Date(epochMs);
    if (Number.isNaN(date.getTime())) {
      return '–';
    }
    return date.toLocaleDateString(undefined, withYear
      ? { day: 'numeric', month: 'short', year: 'numeric' }
      : { day: 'numeric', month: 'short' });
  } catch {
    return '–';
  }
}

function ratioOf(total: number | null, grant: number | null): number | null {
  if (total === null || grant === null || grant <= 0) {
    return null;
  }
  return total / grant;
}

/**
 * Derives the display state for the individual credit card.
 *
 * Precedence: not-applicable (school/unknown mode) → expired (inactive
 * subscription beats unavailable usage and every balance) → unavailable →
 * uninitialized (active but no credit account yet) → exhausted/low bands.
 * A large purchased balance suppresses low warnings because the ratio uses
 * total available over the monthly grant.
 */
export function summarizeSubiCredits(args: {
  quotaMode: string | undefined;
  usage: ManagedUsageState;
  subscription?: ManagedSubscriptionState;
}): SubiCreditSummary {
  const empty: SubiCreditSummary = {
    health: 'not-applicable',
    totalAvailableMilli: null,
    monthlyGrantMilli: null,
    monthlyRemainingMilli: null,
    rolloverRemainingMilli: null,
    purchasedRemainingMilli: null,
    reservedMilli: null,
    cycleEndsAtMs: null,
    subscriptionActive: null,
    renewalDateMs: null,
  };
  if (args.quotaMode !== 'individual_credits') {
    return empty;
  }
  const subscriptionActive = args.subscription ? args.subscription.active : null;
  const renewalDateMs = args.subscription ? args.subscription.renewalDateMs : null;
  if (subscriptionActive === false) {
    return { ...empty, health: 'expired', subscriptionActive: false, renewalDateMs };
  }
  if (args.usage.status !== 'ready' || !args.usage.usage) {
    return { ...empty, health: 'unavailable' };
  }
  const credits = args.usage.usage.credits ?? null;
  if (credits === null) {
    return { ...empty, health: 'uninitialized', subscriptionActive, renewalDateMs };
  }
  const totalAvailableMilli = numOrNull(credits.totalAvailableMilli);
  const monthlyGrantMilli = numOrNull(credits.monthlyGrantMilli);
  const summary: SubiCreditSummary = {
    health: 'healthy',
    totalAvailableMilli,
    monthlyGrantMilli,
    monthlyRemainingMilli: numOrNull(credits.monthlyRemainingMilli),
    rolloverRemainingMilli: numOrNull(credits.rolloverRemainingMilli),
    purchasedRemainingMilli: numOrNull(credits.topupRemainingMilli),
    reservedMilli: numOrNull(credits.reservedMilli),
    cycleEndsAtMs: typeof credits.cycleEndsAtMs === 'number' ? credits.cycleEndsAtMs : null,
    subscriptionActive,
    renewalDateMs,
  };
  if (totalAvailableMilli === null) {
    return { ...summary, health: 'unavailable' };
  }
  if (totalAvailableMilli <= 0) {
    return { ...summary, health: 'exhausted' };
  }
  const ratio = ratioOf(totalAvailableMilli, monthlyGrantMilli);
  if (ratio === null) {
    return summary;
  }
  if (ratio <= 0.1) {
    return { ...summary, health: 'very-low' };
  }
  if (ratio <= 0.25) {
    return { ...summary, health: 'low' };
  }
  return summary;
}
