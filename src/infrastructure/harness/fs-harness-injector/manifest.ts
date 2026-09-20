import fs from 'node:fs';
import path from 'node:path';
import {
  EMPTY_HARNESS_MANIFEST,
  type HarnessManifest,
  type InstalledPackRecord,
} from '../../../domain/harness-pack.js';
import { MANIFEST_RELATIVE_PATH, resolveUnderClaudeDir } from '../../../domain/harness-path.js';
import { compareStrings } from '../../../domain/compare.js';
import { HarnessPathTraversalError } from '../../../application/ports/harness-injector.js';

interface ManifestFile {
  readonly packs?: unknown;
}

interface ManifestPackEntry {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly injectedAt?: unknown;
  readonly files?: unknown;
  readonly hooks?: unknown;
}

export function parseManifest(content: string): HarnessManifest {
  let parsed: ManifestFile;
  try {
    parsed = JSON.parse(content) as ManifestFile;
  } catch {
    return EMPTY_HARNESS_MANIFEST;
  }

  if (!Array.isArray(parsed.packs)) {
    return EMPTY_HARNESS_MANIFEST;
  }

  const packs: InstalledPackRecord[] = [];

  for (const rawEntry of parsed.packs) {
    if (typeof rawEntry !== 'object' || rawEntry === null) {
      continue;
    }

    const entry = rawEntry as ManifestPackEntry;
    if (
      typeof entry.name !== 'string' ||
      entry.name.length === 0 ||
      typeof entry.version !== 'string' ||
      entry.version.length === 0 ||
      typeof entry.injectedAt !== 'string' ||
      entry.injectedAt.length === 0 ||
      !Array.isArray(entry.files)
    ) {
      continue;
    }

    const files = entry.files.filter((file): file is string => typeof file === 'string');
    const hooks = Array.isArray(entry.hooks)
      ? entry.hooks.filter((hook): hook is string => typeof hook === 'string')
      : undefined;
    packs.push({
      name: entry.name,
      version: entry.version,
      injectedAt: entry.injectedAt,
      files,
      ...(hooks === undefined ? {} : { hooks }),
    });
  }

  packs.sort((a, b) => compareStrings(a.name, b.name));
  return { packs };
}

export function serializeManifest(manifest: HarnessManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export async function readManifestFromDisk(projectRootPath: string): Promise<HarnessManifest> {
  const manifestAbsolute = resolveUnderClaudeDir(projectRootPath, MANIFEST_RELATIVE_PATH);
  if (manifestAbsolute === null) {
    return EMPTY_HARNESS_MANIFEST;
  }

  try {
    const content = await fs.promises.readFile(manifestAbsolute, 'utf8');
    return parseManifest(content);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return EMPTY_HARNESS_MANIFEST;
    }
    return EMPTY_HARNESS_MANIFEST;
  }
}

export async function writeManifestToDisk(
  projectRootPath: string,
  manifest: HarnessManifest,
): Promise<void> {
  const manifestAbsolute = resolveUnderClaudeDir(projectRootPath, MANIFEST_RELATIVE_PATH);
  if (manifestAbsolute === null) {
    throw new HarnessPathTraversalError('manifest path escapes .claude/');
  }

  await fs.promises.mkdir(path.dirname(manifestAbsolute), { recursive: true });
  await fs.promises.writeFile(manifestAbsolute, serializeManifest(manifest), 'utf8');
}
