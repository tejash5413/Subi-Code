import { SlashCommandDefinition } from './SlashCommandTypes';

/**
 * Phase 10A: slash command registry.
 *
 * Source of truth for available slash commands. The webview asks the host
 * for the list; the host never parses hardcoded command names in
 * SidebarProvider or sidebar.js.
 */
export class SlashCommandRegistry {
  private readonly commands = new Map<string, SlashCommandDefinition>();

  public register(command: SlashCommandDefinition): void {
    if (!command || typeof command !== 'object') {
      throw new Error('Slash command must be an object.');
    }
    if (typeof command.name !== 'string' || !command.name.startsWith('/') || command.name.length < 2) {
      throw new Error(`Invalid slash command name: ${String(command.name)}`);
    }
    const key = command.name.toLowerCase();
    if (this.commands.has(key)) {
      throw new Error(`Slash command already registered: ${command.name}`);
    }
    for (const alias of command.aliases ?? []) {
      if (typeof alias !== 'string' || !alias.startsWith('/')) {
        throw new Error(`Invalid alias for ${command.name}: ${String(alias)}`);
      }
      const akey = alias.toLowerCase();
      if (this.commands.has(akey)) {
        throw new Error(`Alias collision in slash registry: ${alias}`);
      }
    }
    this.commands.set(key, command);
    for (const alias of command.aliases ?? []) {
      this.commands.set(alias.toLowerCase(), command);
    }
  }

  public has(name: string): boolean {
    return this.commands.has(this.normalize(name));
  }

  public get(name: string): SlashCommandDefinition | undefined {
    return this.commands.get(this.normalize(name));
  }

  /** Distinct commands (not counting aliases). */
  public list(): SlashCommandDefinition[] {
    const seen = new Set<string>();
    const out: SlashCommandDefinition[] = [];
    for (const cmd of this.commands.values()) {
      const key = cmd.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(cmd);
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  /** Filter candidates by query (case-insensitive substring on name/aliases/description). */
  public filter(query: string): SlashCommandDefinition[] {
    const q = query.trim().toLowerCase().replace(/^\/+/, '');
    const all = this.list();
    if (!q) {
      return all;
    }
    return all.filter((cmd) => {
      if (cmd.name.toLowerCase().slice(1).includes(q)) {
        return true;
      }
      for (const alias of cmd.aliases ?? []) {
        if (alias.toLowerCase().slice(1).includes(q)) {
          return true;
        }
      }
      if (cmd.description.toLowerCase().includes(q)) {
        return true;
      }
      return false;
    });
  }

  public size(): number {
    let count = 0;
    const seen = new Set<string>();
    for (const cmd of this.commands.values()) {
      if (seen.has(cmd.name.toLowerCase())) continue;
      seen.add(cmd.name.toLowerCase());
      count++;
    }
    return count;
  }

  private normalize(name: string): string {
    return (typeof name === 'string' ? name : '').toLowerCase();
  }
}
