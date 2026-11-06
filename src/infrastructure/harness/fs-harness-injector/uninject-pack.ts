import fs from 'node:fs';
import path from 'node:path';
import { removeGitignoreEntries } from '../../../domain/harness-gitignore-removal.js';
import { LOCAL_SETTINGS_RELATIVE_PATH, SETTINGS_RELATIVE_PATH } from '../../../domain/harness-hooks.js';
import type { PackSummary } from '../../../domain/harness-pack.js';
import {
  evaluatePackRemovability,
  unresolvedInstalledPacks,
  type PackRemovabilityCode,
} from '../../../domain/harness-pack-removability.js';
import {
  GITIGNORE_FILENAME,
  isSafePackName,
  MANIFEST_RELATIVE_PATH,
  resolveUnderClaudeDir,
} from '../../../domain/harness-path.js';
import {
  HarnessInjectionError,
  HarnessPathTraversalError,
} from '../../../application/ports/harness-injector.js';
import { serializeManifest } from './manifest.js';
import { isSelfInjection } from './self-injection.js';
import { planHookRemoval, type PlannedWrite } from './settings-hooks.js';
import { checkRecordedFiles, findSymlinkOnPath, readManifestStrict, type CheckedFile } from './uninject-safety.js';

/**
 * パックを外す (uninject。bdboard-l1m1.7)。注入 (`injectPack`) が作ったものを、注入記録
 * (`.claude/bdboard-packs.json`) に基づいて元に戻す。実行は常に 2 段: `planUninject` が
 * 何を消すかを決める (ディスクは読むだけ。dry-run はここまで) → `applyUninject` が書く。
 *
 * 戻すもの: ①記録された skill ファイル ②settings.json と settings.local.json の**両方**の
 * マーカー付き hook entry (記録は登録先のファイルを持たないため) ③`.gitignore` の自分の管理行
 * ④注入記録の自分の entry。`.gitignore` の settings.local.json の行は戻さない (全パック共有で、
 * ユーザー自身の個人設定でもあるため)。コミットはしない。
 */

export type UninjectRefusalCode =
  | PackRemovabilityCode
  | 'self-injection'
  | 'unsafe-path'
  | 'invalid-pack-name'
  | 'manifest-unreadable'
  | 'unresolved-installed-pack'
  | 'settings-unreadable';

export interface UninjectRefusal {
  readonly ok: false;
  readonly code: UninjectRefusalCode;
  readonly reason: string;
}

export interface UninjectPlan {
  readonly ok: true;
  readonly projectRootPath: string;
  readonly packName: string;
  /** 記録された skill ファイル (プロジェクトルートからの相対)。`exists` は計画時点。 */
  readonly files: readonly CheckedFile[];
  readonly settings: readonly { readonly relativePath: string; readonly write: PlannedWrite }[];
  readonly gitignore: { readonly absolute: string; readonly content: string } | null;
  /** 最後のパックなら注入記録ファイルごと消す。 */
  readonly manifest: {
    readonly absolute: string;
    readonly content: string | null;
    readonly remainingPacks: readonly string[];
  };
  /** 注入記録にあるがレジストリに無く、依存の判定に入れられなかったパック (`allowUnresolved` で通したときのみ非空)。 */
  readonly unresolvedPacks: readonly string[];
}

export interface PlanUninjectInput {
  readonly projectRootPath: string;
  readonly packName: string;
  /** パック原本の置き場 (自己注入の判定に使う)。 */
  readonly packsRoot: string;
  /** レジストリが知っているパック一覧 (`requires` の出どころ)。 */
  readonly available: readonly PackSummary[];
  /** レジストリに無い注入済みパックがあっても、依存を確かめられないまま進める (既定は拒否)。 */
  readonly allowUnresolved?: boolean;
}

function refuse(code: UninjectRefusalCode, reason: string): UninjectRefusal {
  return { ok: false, code, reason };
}

async function readTextOrNull(absolute: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(absolute, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/**
 * 注入先がパック原本を抱える repo (自己注入先) か。`packsRoot` の内側にあるか (isSelfInjection) に加え、
 * `<project>/harness/packs/<pack>/pack.json` がある repo も自己注入とみなす — bdboard の別 clone や
 * worktree は、実行中の bdboard とは別の packsRoot を持つため前者だけでは拾えない。
 */
async function holdsPackOriginals(
  projectRootPath: string,
  packsRoot: string,
  packName: string,
): Promise<boolean> {
  if (await isSelfInjection(projectRootPath, packsRoot)) {
    return true;
  }
  try {
    await fs.promises.access(path.join(projectRootPath, 'harness', 'packs', packName, 'pack.json'));
    return true;
  } catch {
    return false;
  }
}

async function planSettings(
  projectRootPath: string,
  packName: string,
): Promise<PlannedWrite[] | UninjectRefusal> {
  const settings: PlannedWrite[] = [];
  try {
    for (const relativePath of [SETTINGS_RELATIVE_PATH, LOCAL_SETTINGS_RELATIVE_PATH]) {
      // 設定ファイルを消してよいのは settings.local.json (注入が作る個人設定) だけ。
      // settings.json は空になっても `{}` で残す (追跡される人のファイル)。
      const write = await planHookRemoval(projectRootPath, packName, relativePath, {
        pruneEmpty: true,
        deleteIfEmpty: relativePath === LOCAL_SETTINGS_RELATIVE_PATH,
      });
      if (write !== null) {
        settings.push(write);
      }
    }
  } catch (error) {
    if (error instanceof HarnessPathTraversalError || error instanceof HarnessInjectionError) {
      return refuse('settings-unreadable', error.message);
    }
    throw error;
  }
  return settings;
}

export async function planUninject(
  input: PlanUninjectInput,
): Promise<UninjectPlan | UninjectRefusal> {
  const { projectRootPath, packName, packsRoot, available } = input;

  if (!isSafePackName(packName)) {
    return refuse('invalid-pack-name', `パック名が安全ではありません: ${packName}`);
  }

  // 自己注入先 (パック原本を抱える repo。bdboard 自身) は、パックと設定を git で追跡する設計。
  // ここから外すと原本と注入コピーが食い違うので、スクリプトでは外さない。
  if (await holdsPackOriginals(projectRootPath, packsRoot, packName)) {
    return refuse(
      'self-injection',
      `${projectRootPath} はパック原本を抱える repo (自己注入先) です。ここのパックはスクリプトでは外しません`,
    );
  }

  const read = await readManifestStrict(projectRootPath);
  if (read.kind === 'unreadable') {
    return refuse('manifest-unreadable', read.reason);
  }
  const manifest = read.manifest;
  const removability = evaluatePackRemovability(packName, available, manifest);
  if (!removability.ok) {
    return refuse(removability.code, removability.reason);
  }

  // レジストリに無い注入済みパックは requires を辿れず、外す対象を前提にしていても気づけない。
  // 既定は拒否し、確かめたうえで --allow-unresolved で通させる。
  const unresolved = unresolvedInstalledPacks(available, manifest).filter((name) => name !== packName);
  if (unresolved.length > 0 && input.allowUnresolved !== true) {
    return refuse(
      'unresolved-installed-pack',
      `${unresolved.join(', ')} はパック一覧に無く、${packName} を前提にしていないか確かめられません。確かめたうえで進めるなら --allow-unresolved を付けてください`,
    );
  }

  const record = manifest.packs.find((entry) => entry.name === packName);
  if (record === undefined) {
    return refuse('not-injected', `${packName} は注入記録にありません`);
  }

  const packDirLink = await findSymlinkOnPath(projectRootPath, `.claude/skills/${packName}`);
  if (packDirLink !== null) {
    return refuse('unsafe-path', `${packDirLink} がシンボリックリンクです。リンク先を消さないため、スクリプトでは外しません`);
  }
  const checked = await checkRecordedFiles(projectRootPath, packName, [...record.files].sort());
  if ('code' in checked) {
    return refuse(checked.code, checked.reason);
  }

  const settingsPlans = await planSettings(projectRootPath, packName);
  if (!Array.isArray(settingsPlans)) {
    return settingsPlans;
  }

  const manifestAbsolute = resolveUnderClaudeDir(projectRootPath, MANIFEST_RELATIVE_PATH);
  if (manifestAbsolute === null) {
    return refuse('unsafe-path', '注入記録のパスが .claude/ の外を指しています');
  }
  const remainingEntries = manifest.packs.filter((entry) => entry.name !== packName);

  const gitignoreAbsolute = path.join(projectRootPath, GITIGNORE_FILENAME);
  const gitignoreBefore = await readTextOrNull(gitignoreAbsolute);
  const gitignoreAfter =
    gitignoreBefore === null
      ? null
      : removeGitignoreEntries(gitignoreBefore, packName, {
          removeManifestEntry: remainingEntries.length === 0,
        });

  return {
    ok: true,
    projectRootPath,
    packName,
    files: checked.files,
    settings: settingsPlans.map((write) => ({
      relativePath: path.relative(projectRootPath, write.absolute).split(path.sep).join('/'),
      write,
    })),
    gitignore:
      gitignoreBefore !== null && gitignoreAfter !== null && gitignoreAfter !== gitignoreBefore
        ? { absolute: gitignoreAbsolute, content: gitignoreAfter }
        : null,
    manifest: {
      absolute: manifestAbsolute,
      content: remainingEntries.length === 0 ? null : serializeManifest({ packs: remainingEntries }),
      remainingPacks: remainingEntries.map((entry) => entry.name),
    },
    unresolvedPacks: unresolved,
  };
}
