import type {
  HarnessManifest,
  InstalledPackRecord,
  PackDefinition,
} from '../../../domain/harness-pack.js';
import { HarnessInjectionError } from '../../../application/ports/harness-injector.js';
import { compareStrings } from '../../../domain/compare.js';
import { readManifestFromDisk, writeManifestToDisk } from './manifest.js';
import { copyPackFile, removeStaleFile } from './pack-files.js';
import { registerHooks } from './settings-hooks.js';
import { isSelfInjection } from './self-injection.js';
import { updateGitignoreForPack } from './gitignore.js';

export async function injectPack(
  packsRoot: string,
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

  // hook 登録はマニフェスト書き込みより前。壊れた settings.json で失敗した
  // ときに「注入済み」と記録しないため (ファイルのコピーは残ってよい)。
  const registeredHooks = await registerHooks(projectRootPath, pack);

  const updatedEntry: InstalledPackRecord = {
    name: pack.name,
    version: pack.version,
    injectedAt: injectedAt.toISOString(),
    files: installedFiles,
    hooks: registeredHooks,
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

  if (!(await isSelfInjection(projectRootPath, packsRoot))) {
    try {
      await updateGitignoreForPack(projectRootPath, pack.name);
    } catch (error) {
      throw new HarnessInjectionError('failed to update .gitignore for harness pack', error);
    }
  }

  return manifest;
}
