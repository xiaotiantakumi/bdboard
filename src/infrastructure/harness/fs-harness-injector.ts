import fs from 'node:fs';
import path from 'node:path';
import {
  EMPTY_HARNESS_MANIFEST,
  type HarnessManifest,
  type InstalledPackRecord,
  type PackDefinition,
} from '../../domain/harness-pack.js';
import {
  MANIFEST_RELATIVE_PATH,
  resolveUnderClaudeDir,
  skillInstallRelativePath,
} from '../../domain/harness-path.js';
import {
  HarnessInjectionError,
  HarnessPathTraversalError,
  type HarnessInjectorPort,
} from '../../application/ports/harness-injector.js';
import { compareStrings } from '../../domain/compare.js';

interface ManifestFile {
  readonly packs?: unknown;
}

interface ManifestPackEntry {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly injectedAt?: unknown;
  readonly files?: unknown;
}

function parseManifest(content: string): HarnessManifest {
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
    packs.push({
      name: entry.name,
      version: entry.version,
      injectedAt: entry.injectedAt,
      files,
    });
  }

  packs.sort((a, b) => compareStrings(a.name, b.name));
  return { packs };
}

function serializeManifest(manifest: HarnessManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function copyPackFile(
  projectRootPath: string,
  packsRoot: string,
  packName: string,
  packFileRelative: string,
): Promise<string> {
  const destinationRelative = skillInstallRelativePath(packName, packFileRelative);
  if (destinationRelative === null) {
    throw new HarnessPathTraversalError(
      `unsafe pack file path: ${packName}/${packFileRelative}`,
    );
  }

  const destinationAbsolute = resolveUnderClaudeDir(projectRootPath, destinationRelative);
  if (destinationAbsolute === null) {
    throw new HarnessPathTraversalError(
      `destination escapes .claude/: ${destinationRelative}`,
    );
  }

  const sourceAbsolute = path.join(packsRoot, packName, packFileRelative);
  const sourceResolved = path.resolve(sourceAbsolute);
  const packRootResolved = path.resolve(packsRoot, packName);
  const relativeToPack = path.relative(packRootResolved, sourceResolved);
  if (relativeToPack.startsWith('..') || path.isAbsolute(relativeToPack)) {
    throw new HarnessPathTraversalError(`unsafe pack source path: ${packFileRelative}`);
  }

  await fs.promises.mkdir(path.dirname(destinationAbsolute), { recursive: true });
  await fs.promises.copyFile(sourceResolved, destinationAbsolute);
  return destinationRelative;
}

async function removeStaleFile(
  projectRootPath: string,
  projectRelativePath: string,
): Promise<void> {
  const absolute = resolveUnderClaudeDir(projectRootPath, projectRelativePath);
  if (absolute === null) {
    throw new HarnessPathTraversalError(
      `stale removal blocked outside .claude/: ${projectRelativePath}`,
    );
  }

  try {
    await fs.promises.unlink(absolute);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw error;
    }
  }
}

export function createFsHarnessInjector(options: {
  readonly packsRoot: string;
}): HarnessInjectorPort {
  const { packsRoot } = options;

  const readManifestFromDisk = async (projectRootPath: string): Promise<HarnessManifest> => {
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
  };

  const writeManifestToDisk = async (
    projectRootPath: string,
    manifest: HarnessManifest,
  ): Promise<void> => {
    const manifestAbsolute = resolveUnderClaudeDir(projectRootPath, MANIFEST_RELATIVE_PATH);
    if (manifestAbsolute === null) {
      throw new HarnessPathTraversalError('manifest path escapes .claude/');
    }

    await fs.promises.mkdir(path.dirname(manifestAbsolute), { recursive: true });
    await fs.promises.writeFile(manifestAbsolute, serializeManifest(manifest), 'utf8');
  };

  return {
    readManifest: readManifestFromDisk,

    async injectPack(
      projectRootPath: string,
      pack: PackDefinition,
      injectedAt: Date,
    ): Promise<HarnessManifest> {
      const existing = await readManifestFromDisk(projectRootPath);
      const previousEntry = existing.packs.find((entry) => entry.name === pack.name);

      const installedFiles: string[] = [];
      for (const file of pack.files) {
        const destinationRelative = await copyPackFile(
          projectRootPath,
          packsRoot,
          pack.name,
          file.relativePath,
        );
        installedFiles.push(destinationRelative);
      }
      installedFiles.sort(compareStrings);

      if (previousEntry !== undefined) {
        const installedSet = new Set(installedFiles);
        for (const stalePath of previousEntry.files) {
          if (installedSet.has(stalePath)) {
            continue;
          }
          await removeStaleFile(projectRootPath, stalePath);
        }
      }

      const updatedEntry: InstalledPackRecord = {
        name: pack.name,
        version: pack.version,
        injectedAt: injectedAt.toISOString(),
        files: installedFiles,
      };

      const otherPacks = existing.packs.filter((entry) => entry.name !== pack.name);
      const manifest: HarnessManifest = {
        packs: [...otherPacks, updatedEntry].sort((a, b) => compareStrings(a.name, b.name)),
      };

      try {
        await writeManifestToDisk(projectRootPath, manifest);
      } catch (error) {
        throw new HarnessInjectionError('failed to write harness manifest', error);
      }

      return manifest;
    },
  };
}
