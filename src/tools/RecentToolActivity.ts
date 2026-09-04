/**
 * Phase 10A: memory-only recent tool activity.
 *
 * Bounded ring of the last 20 tool invocations for /context display.
 * NEVER persisted to globalState (file content must not survive reload).
 */
export interface RecentToolActivityEntry {
  callId: string;
  toolName: string;
  label: string;
  category: string;
  summary: string;
  ok: boolean;
  code?: string;
  message?: string;
  durationMs: number;
  timestamp: number;
}

const MAX_RECENT = 20;

export class RecentToolActivity {
  private readonly entries: RecentToolActivityEntry[] = [];

  public add(entry: RecentToolActivityEntry): void {
    this.entries.push(entry);
    while (this.entries.length > MAX_RECENT) {
      this.entries.shift();
    }
  }

  public list(): RecentToolActivityEntry[] {
    return this.entries.slice();
  }

  public size(): number {
    return this.entries.length;
  }

  public clear(): void {
    this.entries.length = 0;
  }
}
