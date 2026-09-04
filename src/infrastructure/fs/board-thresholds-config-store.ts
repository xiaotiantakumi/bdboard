import fs from 'node:fs';
import path from 'node:path';
import type {
  BoardThresholdsConfig,
  BoardThresholdsConfigPort,
} from '../../application/ports/board-thresholds-config.js';
import { withConfigFileLock } from './config-file-write-lock.js';

type MutableBoardThresholdsConfig = {
  -readonly [K in keyof BoardThresholdsConfig]?: BoardThresholdsConfig[K];
};

const THRESHOLD_KEYS = [
  'stalledAfterMs',
  'livenessActiveMs',
  'livenessIdleMs',
  'livenessStaleMs',
  'inProgressWipLimit',
] as const satisfies readonly (keyof BoardThresholdsConfig)[];

const RECORD_KEYS = ['inProgressWipLimitByProject'] as const satisfies readonly (keyof BoardThresholdsConfig)[];

function isValidThresholdValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isValidProjectWipLimitMap(value: unknown): value is Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  for (const [key, limit] of Object.entries(value)) {
    if (typeof key !== 'string' || key.trim() === '') {
      return false;
    }
    if (!isValidThresholdValue(limit)) {
      return false;
    }
  }
  return true;
}

function parseConfig(value: unknown): BoardThresholdsConfig | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const config: MutableBoardThresholdsConfig = {};
  let hasAny = false;

  for (const key of THRESHOLD_KEYS) {
    const raw = record[key];
    if (raw === undefined) {
      continue;
    }
    if (!isValidThresholdValue(raw)) {
      console.warn(`bdboard: ignoring invalid board-thresholds key ${key} in config`);
      continue;
    }
    config[key] = raw;
    hasAny = true;
  }

  for (const key of RECORD_KEYS) {
    const raw = record[key];
    if (raw === undefined) {
      continue;
    }
    if (!isValidProjectWipLimitMap(raw)) {
      console.warn(`bdboard: ignoring invalid board-thresholds key ${key} in config`);
      continue;
    }
    config[key] = raw;
    hasAny = true;
  }

  return hasAny ? (config as BoardThresholdsConfig) : undefined;
}

function readRawObject(filePath: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function createFileBoardThresholdsConfigStore(
  filePath: string,
): BoardThresholdsConfigPort {
  return {
    async read(): Promise<BoardThresholdsConfig | undefined> {
      let raw: string;
      try {
        raw = fs.readFileSync(filePath, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return undefined;
        }
        console.warn(`bdboard: ignoring unreadable board-thresholds config at ${filePath}`);
        return undefined;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        console.warn(`bdboard: ignoring unreadable board-thresholds config at ${filePath}`);
        return undefined;
      }

      return parseConfig(parsed);
    },
    async write(config: BoardThresholdsConfig): Promise<void> {
      await withConfigFileLock(filePath, async () => {
        const dir = path.dirname(filePath);
        fs.mkdirSync(dir, { recursive: true });

        const existing = readRawObject(filePath);
        const merged = { ...existing, ...config };

        const tmpPath = path.join(
          dir,
          `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        );
        fs.writeFileSync(tmpPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
        fs.renameSync(tmpPath, filePath);
      });
    },
  };
}
