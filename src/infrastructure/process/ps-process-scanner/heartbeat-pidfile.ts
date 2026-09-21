import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HeartbeatPidfileRecord } from './types.js';

export function defaultHeartbeatStateDir(): string {
  const tmpdir = process.env.TMPDIR || '/tmp';
  const uid = process.getuid?.();
  const uidToken = uid === undefined ? 'unknown' : String(uid);
  return `${tmpdir}/bd-heartbeat.${uidToken}`;
}

export async function readHeartbeatPidfileMap(
  stateDir: string,
): Promise<Map<number, HeartbeatPidfileRecord>> {
  const map = new Map<number, HeartbeatPidfileRecord>();

  try {
    const entries = await readdir(stateDir);
    for (const entry of entries) {
      if (!entry.endsWith('.pid')) {
        continue;
      }

      const sessionPid = Number.parseInt(entry.slice(0, -'.pid'.length), 10);
      if (!Number.isFinite(sessionPid)) {
        continue;
      }

      let content: string;
      try {
        content = await readFile(join(stateDir, entry), 'utf8');
      } catch {
        continue;
      }

      const firstLine = content.split('\n')[0] ?? '';
      const tabParts = firstLine.split('\t');
      const loopPidToken = tabParts[0]?.trim() ?? '';
      const loopPid = Number.parseInt(loopPidToken, 10);
      if (!Number.isFinite(loopPid) || loopPid <= 1) {
        continue;
      }

      const lstartRaw = tabParts.slice(1).join('\t').trim();
      map.set(loopPid, {
        sessionPid,
        lstart: lstartRaw.length > 0 ? lstartRaw : undefined,
      });
    }
  } catch {
    return map;
  }

  return map;
}
