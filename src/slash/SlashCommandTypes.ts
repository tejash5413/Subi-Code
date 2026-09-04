import type { AgentMode } from '../agent/AgentMode';

/**
 * Phase 10A: slash command types.
 *
 * Slash commands are USER-INITIATED host actions. They never trigger
 * model inference (no AI request) and never call tools directly without
 * going through the ToolExecutor.
 */

export type SlashCommandCategory =
  | 'mode'
  | 'project'
  | 'tools'
  | 'context'
  | 'session'
  | 'coming soon';

export interface SlashCommandDefinition {
  /** Primary name, including the leading slash (e.g. "/search"). */
  name: string;
  /** Optional aliases (e.g. "/s" for "/search"). Must also start with "/". */
  aliases?: string[];
  /** Short description for the popup. */
  description: string;
  /** Category label for grouping in the popup. */
  category: SlashCommandCategory;
  /** Hint shown in the popup (e.g. "/search <query>"). */
  argumentHint?: string;
  /** When true, the command can be invoked today. */
  available: boolean;
  /** Optional: restrict to specific agent modes. */
  agentModes?: AgentMode[];
  /** Human-readable note when the command is not yet available. */
  unavailableReason?: string;
}

/** Parsed slash command input. */
export interface ParsedSlashCommand {
  /** The command name as the user typed it (with leading slash). */
  name: string;
  /** The argument string after the command (may be empty). */
  argument: string;
  /** Whether the input starts with a slash. */
  isCommand: boolean;
}
