export interface ParsedSession {
  readonly sessionId: string;
  readonly pid: number;
  readonly cwd: string;
  readonly startedAt: Date;
  readonly kind?: string;
  readonly entrypoint?: string;
  readonly name?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseStartedAt(value: unknown): Date {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value);
  }
  if (typeof value === 'string') {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return new Date(0);
    }
    return date;
  }
  return new Date(0);
}

/** Returns null for broken or incomplete files (never throws). */
export function parseSessionFile(raw: unknown): ParsedSession | null {
  if (!isRecord(raw)) {
    return null;
  }

  const pid = raw.pid;
  if (typeof pid !== 'number' || !Number.isFinite(pid) || !Number.isInteger(pid)) {
    return null;
  }

  const sessionId = raw.sessionId;
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return null;
  }

  const cwd = raw.cwd;
  if (typeof cwd !== 'string' || cwd.length === 0) {
    return null;
  }

  const startedAt = parseStartedAt(raw.startedAt);
  const kind = raw.kind;
  const entrypoint = raw.entrypoint;
  const name = raw.name;

  return {
    sessionId,
    pid,
    cwd,
    startedAt,
    ...(typeof kind === 'string' ? { kind } : {}),
    ...(typeof entrypoint === 'string' ? { entrypoint } : {}),
    ...(typeof name === 'string' ? { name } : {}),
  };
}

/** Replaces '/', '.', and '_' in cwd with '-' for transcript directory names. */
export function encodeCwdForTranscript(cwd: string): string {
  return cwd.replace(/[/._]/g, '-');
}

/** Strips a leading 'local_' prefix when present. */
export function normalizeSessionId(sessionId: string): string {
  if (sessionId.startsWith('local_')) {
    const stripped = sessionId.slice('local_'.length);
    if (stripped.length === 0) {
      return sessionId;
    }
    return stripped;
  }
  return sessionId;
}
