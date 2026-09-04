import { ParsedSlashCommand } from './SlashCommandTypes';

/**
 * Phase 10A: slash command parser (vscode-free, unit-testable).
 *
 * A slash is treated as a command only when it is at the very start of
 * the input AND followed by a name character. Multi-line input (with
 * newlines) is treated as plain chat.
 *
 * This intentionally does NOT match embedded slashes like "What does /
 * mean in JavaScript?" — only leading-slash input is a command.
 */

const COMMAND_NAME_RE = /^\/([A-Za-z][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/;

export function parseSlashInput(raw: string): ParsedSlashCommand {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { name: '', argument: '', isCommand: false };
  }
  // Must start with a single slash. A second slash at the start means
  // "escaped slash" (not a command).
  if (raw.startsWith('//')) {
    return { name: '', argument: '', isCommand: false };
  }
  if (!raw.startsWith('/')) {
    return { name: '', argument: '', isCommand: false };
  }
  // No newlines allowed in the command line; multi-line input is chat.
  if (/[\r\n]/.test(raw)) {
    return { name: '', argument: '', isCommand: false };
  }
  const match = COMMAND_NAME_RE.exec(raw);
  if (!match) {
    // "/ " alone, "/" with no name, or "/1..." (must start with a letter).
    return { name: '', argument: '', isCommand: false };
  }
  return {
    name: `/${match[1]}`,
    argument: (match[2] ?? '').trim(),
    isCommand: true,
  };
}

export function splitSlashPrefix(raw: string): { prefix: string; rest: string } | null {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')) {
    return null;
  }
  if (/[\r\n]/.test(raw)) {
    return null;
  }
  const spaceIdx = raw.indexOf(' ');
  if (spaceIdx === -1) {
    return { prefix: raw, rest: '' };
  }
  return { prefix: raw.slice(0, spaceIdx), rest: raw.slice(spaceIdx + 1) };
}
