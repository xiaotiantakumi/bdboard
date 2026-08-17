import fs from 'node:fs';
import path from 'node:path';
import type {
  AiQuotaAlertConfig,
  AiQuotaAlertConfigPort,
} from '../../application/ports/ai-quota-alert-config.js';

const THRESHOLD_KEYS = ['thresholdPercent'] as const satisfies readonly (keyof AiQuotaAlertConfig)[];

function isValidThresholdValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 99;
}

function parseConfig(value: unknown): AiQuotaAlertConfig | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const config: Partial<Record<keyof AiQuotaAlertConfig, number>> = {};
  let hasAny = false;

  for (const key of THRESHOLD_KEYS) {
    const raw = record[key];
    if (raw === undefined) {
      continue;
    }
    if (!isValidThresholdValue(raw)) {
      console.warn(`bdboard: ignoring invalid ai-quota-alert key ${key} in config`);
      continue;
    }
    config[key] = raw;
    hasAny = true;
  }

  return hasAny ? (config as AiQuotaAlertConfig) : undefined;
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

export function createFileAiQuotaAlertConfigStore(
  filePath: string,
): AiQuotaAlertConfigPort {
  return {
    async read(): Promise<AiQuotaAlertConfig | undefined> {
      let raw: string;
      try {
        raw = fs.readFileSync(filePath, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return undefined;
        }
        console.warn(`bdboard: ignoring unreadable ai-quota-alert config at ${filePath}`);
        return undefined;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        console.warn(`bdboard: ignoring unreadable ai-quota-alert config at ${filePath}`);
        return undefined;
      }

      return parseConfig(parsed);
    },
    async write(config: AiQuotaAlertConfig): Promise<void> {
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
