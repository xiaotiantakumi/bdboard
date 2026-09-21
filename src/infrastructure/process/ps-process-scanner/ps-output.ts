import { matchesAgentCommand } from './agent-matching.js';
import type { PsRawRow, PsRow } from './types.js';

export function parseLstart(value: string): Date | undefined {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  return parsed;
}

export function parsePsRawLines(stdout: string): PsRawRow[] {
  const rows: PsRawRow[] = [];

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const match = trimmed.match(
      /^(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\d{4})\s+(.*)$/,
    );
    if (match === null) {
      continue;
    }

    const pid = Number.parseInt(match[1], 10);
    if (!Number.isFinite(pid)) {
      continue;
    }

    rows.push({
      pid,
      lstart: match[2],
      commandLine: match[3],
    });
  }

  return rows;
}

export function parsePsOutput(stdout: string): PsRow[] {
  const rows: PsRow[] = [];

  for (const raw of parsePsRawLines(stdout)) {
    const command = matchesAgentCommand(raw.commandLine);
    if (command === undefined) {
      continue;
    }

    rows.push({
      pid: raw.pid,
      lstart: raw.lstart,
      command,
    });
  }

  return rows;
}
