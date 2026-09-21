import { matchesAgentCommand, tokenBasename } from './agent-matching.js';

const SHELL_BASENAMES = new Set(['bash', 'sh', 'zsh']);

export function isHeartbeatLoopCommand(commandLine: string): boolean {
  const trimmed = commandLine.trim();
  if (trimmed.length === 0) {
    return false;
  }

  if (matchesAgentCommand(commandLine) !== undefined) {
    return false;
  }

  const firstBasename = tokenBasename(trimmed.split(/\s+/)[0] ?? '');
  if (!SHELL_BASENAMES.has(firstBasename)) {
    return false;
  }

  if (/bd-heartbeat(?:\.sh)?\s+(?:stop|status)\b/.test(commandLine)) {
    return false;
  }

  if (/bd-heartbeat(?:\.sh)?\s+start\b/.test(commandLine)) {
    return true;
  }

  const hasLoopKeyword = /\b(?:while|for|until)\b/.test(commandLine);
  const hasBdHeartbeat = /\bbd(?:\s+\S+)*\s+heartbeat\b/.test(commandLine);
  return hasLoopKeyword && hasBdHeartbeat;
}
