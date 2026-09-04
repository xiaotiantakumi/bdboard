export interface ParsedHeartbeatLoopCommand {
  /** コマンドラインから抽出したチケットID候補。重複除去・出現順 */
  readonly ticketIdCandidates: readonly string[];
  /** --session-pid の値。無ければ undefined */
  readonly sessionPidArg?: number;
}

const TICKET_ID_PATTERN =
  /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+(?:\.[0-9]+)*$/;

const FLAG_VALUE_FLAGS = new Set([
  '--session-pid',
  '--interval',
  '--max-hours',
  '--repo',
]);

function stripTokenDelimiters(token: string): string {
  return token.replace(/^['"`;,]+|['"`;,]+$/g, '');
}

export function parseHeartbeatLoopCommand(
  commandLine: string,
): ParsedHeartbeatLoopCommand {
  const tokens = commandLine.split(/\s+/).filter((token) => token.length > 0);
  const ticketIdCandidates: string[] = [];
  const seen = new Set<string>();
  let sessionPidArg: number | undefined;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;

    if (token === '--session-pid') {
      const value = tokens[index + 1];
      if (value !== undefined) {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed)) {
          sessionPidArg = parsed;
        }
        index += 1;
      }
      continue;
    }

    if (FLAG_VALUE_FLAGS.has(token)) {
      index += 1;
      continue;
    }

    if (token.startsWith('-')) {
      continue;
    }

    const cleaned = stripTokenDelimiters(token);
    if (TICKET_ID_PATTERN.test(cleaned) && !seen.has(cleaned)) {
      seen.add(cleaned);
      ticketIdCandidates.push(cleaned);
    }
  }

  return {
    ticketIdCandidates,
    ...(sessionPidArg !== undefined ? { sessionPidArg } : {}),
  };
}
