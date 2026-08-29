import fs from 'node:fs';
import path from 'node:path';
import type {
  HygieneThresholdsConfig,
  HygieneThresholdsConfigPort,
} from '../../application/ports/hygiene-thresholds-config.js';
import {
  HYGIENE_HIGH_PRIORITY_MAX,
  HYGIENE_HIGH_PRIORITY_MIN,
  HYGIENE_THRESHOLDS_MAX_MS,
  HYGIENE_THRESHOLDS_MIN_MS,
} from '../../domain/hygiene-thresholds.js';

const MS_KEYS = [
  'staleInProgressAfterMs',
  'stalePendingDecisionAfterMs',
] as const satisfies readonly (keyof HygieneThresholdsConfig)[];

const PRIORITY_KEYS = ['highPriorityMax'] as const satisfies readonly (keyof HygieneThresholdsConfig)[];

function isValidMsValue(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= HYGIENE_THRESHOLDS_MIN_MS &&
    value <= HYGIENE_THRESHOLDS_MAX_MS
  );
}

function isValidPriorityValue(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= HYGIENE_HIGH_PRIORITY_MIN &&
    value <= HYGIENE_HIGH_PRIORITY_MAX
  );
}

function parseConfig(value: unknown): HygieneThresholdsConfig | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const config: Partial<Record<keyof HygieneThresholdsConfig, number>> = {};
  let hasAny = false;

  for (const key of MS_KEYS) {
    const raw = record[key];
    if (raw === undefined) {
      continue;
    }
    if (!isValidMsValue(raw)) {
      console.warn(`bdboard: ignoring invalid hygiene-thresholds key ${key} in config`);
      continue;
    }
    config[key] = raw;
    hasAny = true;
  }

  for (const key of PRIORITY_KEYS) {
    const raw = record[key];
    if (raw === undefined) {
      continue;
    }
    if (!isValidPriorityValue(raw)) {
      console.warn(`bdboard: ignoring invalid hygiene-thresholds key ${key} in config`);
      continue;
    }
    config[key] = raw;
    hasAny = true;
  }

  return hasAny ? (config as HygieneThresholdsConfig) : undefined;
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

export function createFileHygieneThresholdsConfigStore(
  filePath: string,
): HygieneThresholdsConfigPort {
  return {
    async read(): Promise<HygieneThresholdsConfig | undefined> {
      let raw: string;
      try {
        raw = fs.readFileSync(filePath, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return undefined;
        }
        console.warn(`bdboard: ignoring unreadable hygiene-thresholds config at ${filePath}`);
        return undefined;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        console.warn(`bdboard: ignoring unreadable hygiene-thresholds config at ${filePath}`);
        return undefined;
      }

      return parseConfig(parsed);
    },
    async write(config: HygieneThresholdsConfig): Promise<void> {
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
    },
  };
}
