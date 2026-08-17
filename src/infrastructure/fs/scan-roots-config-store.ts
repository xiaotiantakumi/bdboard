import fs from 'node:fs';
import path from 'node:path';
import type {
  ScanRootsConfig,
  ScanRootsConfigPort,
} from '../../application/ports/scan-roots-config.js';

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function parseConfig(value: unknown): ScanRootsConfig | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (!isStringArray(record.scanRoots)) return undefined;
  const excludePaths = record.excludePaths === undefined ? [] : record.excludePaths;
  if (!isStringArray(excludePaths)) return undefined;
  return { scanRoots: record.scanRoots, excludePaths };
}

/** Best-effort read of the raw JSON object on disk, used by write() to preserve any unrelated
 *  keys already in the file (e.g. future settings added by another feature). A missing,
 *  unreadable, non-JSON, or non-object file is treated as "nothing to preserve" - write() is
 *  then free to overwrite it outright, per this store's contract. */
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

export function createFileScanRootsConfigStore(filePath: string): ScanRootsConfigPort {
  return {
    async read(): Promise<ScanRootsConfig | undefined> {
      let raw: string;
      try {
        raw = fs.readFileSync(filePath, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return undefined;
        }
        console.warn(`bdboard: ignoring unreadable scan-roots config at ${filePath}`);
        return undefined;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        console.warn(`bdboard: ignoring unreadable scan-roots config at ${filePath}`);
        return undefined;
      }

      const config = parseConfig(parsed);
      if (config === undefined) {
        console.warn(`bdboard: ignoring unreadable scan-roots config at ${filePath}`);
      }
      return config;
    },
    async write(config: ScanRootsConfig): Promise<void> {
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });

      // Merge onto whatever is already on disk so unrelated keys (future settings this store
      // doesn't know about) survive a scan-roots-only write. A corrupt existing file is fine to
      // fully replace (readRawObject returns undefined for it).
      const existing = readRawObject(filePath);
      const merged = { ...existing, ...config };

      // Write-then-rename so a crash or a concurrent read never observes a partially written
      // file. The tmp file lives next to the target so the rename stays on one filesystem.
      const tmpPath = path.join(
        dir,
        `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      fs.writeFileSync(tmpPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
      fs.renameSync(tmpPath, filePath);
    },
  };
}
