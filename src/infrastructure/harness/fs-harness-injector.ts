import fs from 'node:fs';
import path from 'node:path';
import {
  mergeHarnessHooks,
  PACK_HOOKS_DIR,
  SETTINGS_RELATIVE_PATH,
} from '../../domain/harness-hooks.js';
import {
  EMPTY_HARNESS_MANIFEST,
  type HarnessManifest,
  type InstalledPackRecord,
  type PackDefinition,
} from '../../domain/harness-pack.js';
import {
  appendGitignoreEntries,
  GITIGNORE_FILENAME,
  isPathInside,
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
  readonly hooks?: unknown;
}

/** hook スクリプトとして実行ビットを立てる対象か (pack 根からの相対パス)。 */
export function isHookScript(packFileRelative: string): boolean {
  return (
    packFileRelative.startsWith(`${PACK_HOOKS_DIR}/`) && packFileRelative.endsWith('.sh')
  );
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

  // hook は Claude Code が `bash <script>` ではなく登録したコマンド経由で叩く。
  // ここでは `bash "..."` を書き込むので実行ビットが無くても動くが、人が直接
  // 叩けないと調査時に詰まるので立てておく。copyFile は既存ファイルの mode を
  // 引き継ぐため、上書き再注入でも毎回やる必要がある。win32 では意味が無い。
  if (process.platform !== 'win32' && isHookScript(packFileRelative)) {
    await fs.promises.chmod(destinationAbsolute, 0o755);
  }

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

/** 実体パスに解決する。解決できない (未作成など) ときは正規化した元のパスを返す。 */
async function resolveRealPath(target: string): Promise<string> {
  try {
    return await fs.promises.realpath(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * 注入先がパック原本 (`packsRoot`) を抱えている repo 自身か。
 *
 * bdboard 自身は `.claude/bdboard-packs.json` と `.claude/skills/<pack>/` を git
 * 追跡しているため (p5l.7 の裁定)、Hygiene パネルから自己再注入したときに
 * `.gitignore` へ管理行が入ると、以後パックにファイルを足しても git add から
 * 静かに漏れる。自己注入と判定できたときは .gitignore を触らない (bdboard-x32)。
 *
 * realpath まで見るのは macOS の `/var` -> `/private/var` のように、同じ場所を
 * 指す別表記でプロジェクトが登録されていても取りこぼさないため。解決に失敗した
 * 場合は正規化した元のパスで比べる — その場合の最悪は「自己注入を見逃して
 * 従来どおり追記する」で、現状より悪くはならない。
 *
 * 判定は「packsRoot が注入先の内側か」なので、bdboard を内包する**祖先**
 * ディレクトリへ注入した場合も self 側へ倒れる (PR#138 レビュー minor-1)。
 * これは意図的: 誤って倒れたときの実害は「ignore 行が付かず注入物が untracked
 * のまま残る」で、逆方向の「git add から静かに漏れる」より軽い。なお
 * プロジェクト探索は `.beads` を見つけた時点で降下を止めるので、祖先と bdboard
 * が同時に一覧へ並ぶ構成自体が例外的である。
 */
async function isSelfInjection(projectRootPath: string, packsRoot: string): Promise<boolean> {
  const [projectReal, packsReal] = await Promise.all([
    resolveRealPath(projectRootPath),
    resolveRealPath(packsRoot),
  ]);
  return isPathInside(projectReal, packsReal);
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

  /**
   * 表示 (hooksState) 用の寛容な読み取り。読めない理由を問わず null にする —
   * ここでの失敗はハーネス状態の表示を諦める理由にはなるが、ボード全体を落とす
   * 理由ではない。**書き込み経路ではこれを使わない** (下の readSettingsForWrite)。
   */
  const readSettingsFromDisk = async (projectRootPath: string): Promise<string | null> => {
    const settingsAbsolute = resolveUnderClaudeDir(projectRootPath, SETTINGS_RELATIVE_PATH);
    if (settingsAbsolute === null) {
      return null;
    }

    try {
      return await fs.promises.readFile(settingsAbsolute, 'utf8');
    } catch {
      return null;
    }
  };

  /**
   * 書き込み経路用の厳格な読み取り。**「無い」と「読めない」を混同しない**。
   *
   * 寛容な読み取りをそのまま使うと、EACCES / EISDIR / EMFILE で null が返り、
   * マージが「settings.json が存在しない」と解釈して `{}` から組み立てた JSON で
   * 既存ファイルを丸ごと潰す。ENOENT だけを「無い」とみなし、それ以外は注入ごと
   * 失敗させる (PR#290 レビュー major-1)。
   */
  const readSettingsForWrite = async (settingsAbsolute: string): Promise<string | null> => {
    try {
      return await fs.promises.readFile(settingsAbsolute, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return null;
      }
      throw new HarnessInjectionError('failed to read .claude/settings.json', error);
    }
  };

  /**
   * `.claude/settings.json` に hook を登録する。壊れた JSON は上書きせず注入ごと
   * 失敗させる — 人が書いた設定を我々の生成物で潰すほうが、注入が失敗するより
   * 悪い (bdboard-pkr6.2)。
   */
  const registerHooks = async (
    projectRootPath: string,
    pack: PackDefinition,
  ): Promise<readonly string[]> => {
    const settingsAbsolute = resolveUnderClaudeDir(projectRootPath, SETTINGS_RELATIVE_PATH);
    if (settingsAbsolute === null) {
      throw new HarnessPathTraversalError('settings path escapes .claude/');
    }

    const existing = await readSettingsForWrite(settingsAbsolute);
    const merged = mergeHarnessHooks(existing, pack);
    if (!merged.ok) {
      throw new HarnessInjectionError(
        `failed to register harness hooks: ${merged.error}`,
      );
    }

    // 宣言も既存内容も無いなら書かない。hook を持たないパックの注入で、空の
    // settings.json を新規作成しないため。
    if (merged.registered.length === 0 && existing === null) {
      return [];
    }

    // 内容が1バイトも変わらないなら書かない。再注入のたびに mtime だけ動くと、
    // ファイル監視や git の作業ツリー差分に無意味なノイズが出る (レビュー minor-1)。
    if (merged.settingsJson === existing) {
      return merged.registered;
    }

    try {
      await fs.promises.mkdir(path.dirname(settingsAbsolute), { recursive: true });
      await fs.promises.writeFile(settingsAbsolute, merged.settingsJson, 'utf8');
    } catch (error) {
      throw new HarnessInjectionError('failed to write .claude/settings.json', error);
    }

    return merged.registered;
  };

  const updateGitignoreForPack = async (
    projectRootPath: string,
    packName: string,
  ): Promise<void> => {
    const gitignorePath = path.join(projectRootPath, GITIGNORE_FILENAME);
    let existingContent = '';

    try {
      existingContent = await fs.promises.readFile(gitignorePath, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        throw error;
      }
    }

    const updatedContent = appendGitignoreEntries(existingContent, packName);
    if (updatedContent === existingContent) {
      return;
    }

    await fs.promises.writeFile(gitignorePath, updatedContent, 'utf8');
  };

  return {
    readManifest: readManifestFromDisk,

    readSettings: readSettingsFromDisk,

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
    },
  };
}
