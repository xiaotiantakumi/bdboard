import fs from 'node:fs';
import path from 'node:path';
import { compareStrings } from '../../domain/compare.js';
import {
  DEFAULT_PACK_HOOK_TIMEOUT_SECONDS,
  PACK_HOOKS_DIR,
  type PackHookDeclaration,
} from '../../domain/harness-hooks.js';
import type { PackDefinition, PackFileEntry, PackSummary } from '../../domain/harness-pack.js';
import type { PackRegistryPort } from '../../application/ports/pack-registry.js';

const PACK_MANIFEST_FILE = 'pack.json';

interface PackJson {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly description?: unknown;
  readonly hooks?: unknown;
}

/**
 * pack.json の `hooks` を読む。壊れた宣言はパックごと弾く (undefined) — この
 * ファイルは bdboard 自身が配布する原本で、typo で機械ガードが黙って無効になる
 * ほうが「パックが見えない」より悪い。`timeout` は省略可 (既定 10 秒)。
 *
 * `script` は `hooks/` 配下に限る。settings.json 側で「我々の entry」を識別する
 * マーカーが `/.claude/skills/<pack>/hooks/` なので、その外を指す宣言は登録して
 * も再注入で消せなくなる。
 */
function parsePackHooks(value: unknown): readonly PackHookDeclaration[] | undefined {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return undefined;
  }

  const hooks: PackHookDeclaration[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return undefined;
    }

    const entry = raw as {
      readonly event?: unknown;
      readonly matcher?: unknown;
      readonly script?: unknown;
      readonly timeout?: unknown;
    };

    if (typeof entry.event !== 'string' || entry.event.length === 0) {
      return undefined;
    }
    if (entry.matcher !== undefined && typeof entry.matcher !== 'string') {
      return undefined;
    }
    if (
      typeof entry.script !== 'string' ||
      !entry.script.startsWith(`${PACK_HOOKS_DIR}/`) ||
      entry.script.includes('..')
    ) {
      return undefined;
    }

    let timeout = DEFAULT_PACK_HOOK_TIMEOUT_SECONDS;
    if (entry.timeout !== undefined) {
      if (
        typeof entry.timeout !== 'number' ||
        !Number.isInteger(entry.timeout) ||
        entry.timeout <= 0
      ) {
        return undefined;
      }
      timeout = entry.timeout;
    }

    hooks.push({
      event: entry.event,
      matcher: entry.matcher ?? '',
      script: entry.script,
      timeout,
    });
  }

  return hooks;
}

function parsePackJson(content: string): PackSummary | undefined {
  let parsed: PackJson;
  try {
    parsed = JSON.parse(content) as PackJson;
  } catch {
    return undefined;
  }

  if (
    typeof parsed.name !== 'string' ||
    parsed.name.length === 0 ||
    typeof parsed.version !== 'string' ||
    parsed.version.length === 0 ||
    typeof parsed.description !== 'string'
  ) {
    return undefined;
  }

  const hooks = parsePackHooks(parsed.hooks);
  if (hooks === undefined) {
    return undefined;
  }

  return {
    name: parsed.name,
    version: parsed.version,
    description: parsed.description,
    hooks,
  };
}

async function collectPackFiles(
  packDir: string,
  currentRelative = '',
): Promise<readonly PackFileEntry[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(packDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: PackFileEntry[] = [];

  for (const entry of entries) {
    if (entry.name === PACK_MANIFEST_FILE) {
      continue;
    }

    const relativePath =
      currentRelative.length === 0 ? entry.name : path.posix.join(currentRelative, entry.name);
    const absolutePath = path.join(packDir, entry.name);

    if (entry.isDirectory()) {
      const nested = await collectPackFiles(absolutePath, relativePath);
      files.push(...nested);
      continue;
    }

    if (entry.isFile()) {
      files.push({ relativePath: relativePath.replace(/\\/g, '/') });
    }
  }

  files.sort((a, b) => compareStrings(a.relativePath, b.relativePath));
  return files;
}

export function createFsPackRegistry(packsRoot: string): PackRegistryPort {
  const listPackDirectories = async (): Promise<readonly string[]> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(packsRoot, { withFileTypes: true });
    } catch {
      return [];
    }

    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort(compareStrings);
  };

  const readPackSummary = async (dirName: string): Promise<PackSummary | undefined> => {
    const packDir = path.join(packsRoot, dirName);
    const manifestPath = path.join(packDir, PACK_MANIFEST_FILE);

    let content: string;
    try {
      content = await fs.promises.readFile(manifestPath, 'utf8');
    } catch {
      return undefined;
    }

    const summary = parsePackJson(content);
    if (summary === undefined) {
      return undefined;
    }

    if (summary.name !== dirName) {
      return undefined;
    }

    return summary;
  };

  return {
    async listPacks(): Promise<readonly PackSummary[]> {
      const dirNames = await listPackDirectories();
      const packs: PackSummary[] = [];

      for (const dirName of dirNames) {
        const summary = await readPackSummary(dirName);
        if (summary !== undefined) {
          packs.push(summary);
        }
      }

      return packs;
    },

    async getPack(name: string): Promise<PackDefinition | undefined> {
      const summary = await readPackSummary(name);
      if (summary === undefined) {
        return undefined;
      }

      const packDir = path.join(packsRoot, name);
      const files = await collectPackFiles(packDir);
      return { ...summary, files };
    },
  };
}
