import fs from 'node:fs';
import path from 'node:path';
import type { TunnelInterruptionStore } from '../../application/ports/tunnel-interruption-store.js';

interface InterruptionFile {
  readonly interruptedAt?: unknown;
}

function parseInterruptedAt(raw: unknown): Date | null {
  if (typeof raw !== 'string') {
    return null;
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

export function createFileTunnelInterruptionStore(
  filePath: string,
): TunnelInterruptionStore {
  const read = (): Date | null => {
    try {
      if (!fs.existsSync(filePath)) {
        return null;
      }

      const content = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(content) as InterruptionFile;
      return parseInterruptedAt(parsed.interruptedAt);
    } catch {
      return null;
    }
  };

  const markInterrupted = (at: Date): void => {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(
        filePath,
        JSON.stringify({ interruptedAt: at.toISOString() }),
        'utf8',
      );
    } catch {
      // shutdown path must not fail on persistence errors
    }
  };

  const clear = (): void => {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // ignore missing file or delete failures
    }
  };

  return {
    read,
    markInterrupted,
    clear,
  };
}
