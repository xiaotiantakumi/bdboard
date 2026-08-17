import fs from 'node:fs';
import path from 'node:path';
import { compareStrings } from '../../domain/compare.js';
import type { PackDefinition, PackFileEntry, PackSummary } from '../../domain/harness-pack.js';
import type { PackRegistryPort } from '../../application/ports/pack-registry.js';

const PACK_MANIFEST_FILE = 'pack.json';

interface PackJson {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly description?: unknown;
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

  return {
    name: parsed.name,
    version: parsed.version,
    description: parsed.description,
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
