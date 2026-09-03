import fs from 'node:fs';
import path from 'node:path';
import type {
  AgentRunConfig,
  AgentRunConfigPort,
} from '../../application/ports/agent-run-config.js';
import { withConfigFileLock } from './config-file-write-lock.js';

const CONFIG_KEYS = ['allowRemoteAgentRuns'] as const satisfies readonly (keyof AgentRunConfig)[];

function isValidBooleanValue(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function parseConfig(value: unknown): AgentRunConfig | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const config: Partial<Record<keyof AgentRunConfig, boolean>> = {};
  let hasAny = false;

  for (const key of CONFIG_KEYS) {
    const raw = record[key];
    if (raw === undefined) {
      continue;
    }
    if (!isValidBooleanValue(raw)) {
      console.warn(`bdboard: ignoring invalid agent-run key ${key} in config`);
      continue;
    }
    config[key] = raw;
    hasAny = true;
  }

  return hasAny ? (config as AgentRunConfig) : undefined;
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

export function createFileAgentRunConfigStore(filePath: string): AgentRunConfigPort {
  return {
    async read(): Promise<AgentRunConfig | undefined> {
      let raw: string;
      try {
        raw = fs.readFileSync(filePath, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return undefined;
        }
        console.warn(`bdboard: ignoring unreadable agent-run config at ${filePath}`);
        return undefined;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        console.warn(`bdboard: ignoring unreadable agent-run config at ${filePath}`);
        return undefined;
      }

      return parseConfig(parsed);
    },
    async write(config: AgentRunConfig): Promise<void> {
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
