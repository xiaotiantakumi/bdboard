import os from 'node:os';
import path from 'node:path';
import { compareStrings } from '../../domain/compare.js';
import type { AgentSession } from '../../domain/session.js';
import type { DirEntry, FileSystemPort } from '../../application/ports/file-system.js';
import type { ProcessProbe } from '../../application/ports/process-probe.js';
import type { SessionRegistry } from '../../application/ports/session-registry.js';
import {
  encodeCwdForTranscript,
  normalizeSessionId,
  parseSessionFile,
} from '../../application/session/parse-session-file.js';

export interface ClaudeSessionRegistryOptions {
  readonly sessionsDir?: string;
  readonly projectsDir?: string;
}

export function createClaudeSessionRegistry(
  fs: FileSystemPort,
  probe: ProcessProbe,
  options?: ClaudeSessionRegistryOptions,
): SessionRegistry {
  const sessionsDir =
    options?.sessionsDir ?? path.join(os.homedir(), '.claude', 'sessions');
  const projectsDir =
    options?.projectsDir ?? path.join(os.homedir(), '.claude', 'projects');
  const realPathMemo = new Map<string, string>();

  async function resolveCwd(rawCwd: string): Promise<string> {
    const cached = realPathMemo.get(rawCwd);
    if (cached !== undefined) {
      return cached;
    }

    let resolved = rawCwd;
    try {
      const real = await fs.realPath(rawCwd);
      if (real !== undefined && real !== '') {
        resolved = real;
      }
    } catch {
      // fall back to raw cwd
    }

    realPathMemo.set(rawCwd, resolved);
    return resolved;
  }

  return {
    async listSessions(): Promise<readonly AgentSession[]> {
      let entries: readonly DirEntry[];
      try {
        entries = await fs.readDir(sessionsDir);
      } catch {
        return [];
      }

      const jsonFiles = entries.filter(
        (entry) => !entry.isDirectory && entry.name.endsWith('.json'),
      );

      const sessions: AgentSession[] = [];
      const seenSessionIds = new Set<string>();

      for (const entry of jsonFiles) {
        const filePath = path.join(sessionsDir, entry.name);
        const raw = await fs.readFile(filePath);
        if (raw === undefined) {
          continue;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          continue;
        }

        const sessionParsed = parseSessionFile(parsed);
        if (sessionParsed === null) {
          continue;
        }

        const normalizedId = normalizeSessionId(sessionParsed.sessionId);
        if (seenSessionIds.has(normalizedId)) {
          continue;
        }
        seenSessionIds.add(normalizedId);

        let alive = false;
        try {
          alive = probe.isAlive(sessionParsed.pid);
        } catch {
          alive = false;
        }

        const rawCwd = sessionParsed.cwd;
        const resolvedCwd = await resolveCwd(rawCwd);

        let transcriptPath = path.join(
          projectsDir,
          encodeCwdForTranscript(rawCwd),
          `${normalizedId}.jsonl`,
        );
        let transcriptStat = await fs.stat(transcriptPath);
        if (transcriptStat === undefined && resolvedCwd !== rawCwd) {
          transcriptPath = path.join(
            projectsDir,
            encodeCwdForTranscript(resolvedCwd),
            `${normalizedId}.jsonl`,
          );
          transcriptStat = await fs.stat(transcriptPath);
        }
        const lastActivityAt =
          transcriptStat !== undefined
            ? new Date(transcriptStat.mtimeMs)
            : sessionParsed.startedAt;

        sessions.push({
          sessionId: normalizedId,
          pid: sessionParsed.pid,
          cwd: resolvedCwd,
          startedAt: sessionParsed.startedAt,
          lastActivityAt,
          alive,
          ...(sessionParsed.kind !== undefined ? { kind: sessionParsed.kind } : {}),
          ...(sessionParsed.entrypoint !== undefined
            ? { entrypoint: sessionParsed.entrypoint }
            : {}),
          ...(sessionParsed.name !== undefined ? { name: sessionParsed.name } : {}),
        });
      }

      sessions.sort((a, b) => compareStrings(a.sessionId, b.sessionId));
      return sessions;
    },
  };
}
