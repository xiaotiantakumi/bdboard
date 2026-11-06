import fs from 'node:fs';
import path from 'node:path';
import { compareStrings } from '../../../domain/compare.js';
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
  MANIFEST_RELATIVE_PATH,
  resolveUnderClaudeDir,
} from '../../../domain/harness-path.js';
import {
  HarnessInjectionError,
  HarnessPathTraversalError,
} from '../../../application/ports/harness-injector.js';
import { readManifestFromDisk, serializeManifest } from './manifest.js';
import { isSelfInjection } from './self-injection.js';
import { planHookRemoval, type PlannedWrite } from './settings-hooks.js';

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
  readonly files: readonly { readonly relativePath: string; readonly exists: boolean }[];
  readonly settings: readonly {
    readonly relativePath: string;
    readonly write: PlannedWrite;
  }[];
  readonly gitignore: { readonly absolute: string; readonly content: string } | null;
  /** 最後のパックなら注入記録ファイルごと消す。 */
  readonly manifest: {
    readonly absolute: string;
    readonly content: string | null;
    readonly remainingPacks: readonly string[];
  };
  /** 注入記録にあるがレジストリに無く、依存の判定に入れられなかったパック。 */
  readonly unresolvedPacks: readonly string[];
}

export interface PlanUninjectInput {
  readonly projectRootPath: string;
  readonly packName: string;
  /** パック原本の置き場 (自己注入の判定に使う)。 */
  readonly packsRoot: string;
  /** レジストリが知っているパック一覧 (`requires` の出どころ)。 */
  readonly available: readonly PackSummary[];
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

async function exists(absolute: string): Promise<boolean> {
  try {
    await fs.promises.access(absolute);
    return true;
  } catch {
    return false;
  }
}

export async function planUninject(
  input: PlanUninjectInput,
): Promise<UninjectPlan | UninjectRefusal> {
  const { projectRootPath, packName, packsRoot, available } = input;

  // 自己注入先 (パック原本を抱える repo。bdboard 自身) は、パックと設定を git で追跡する設計。
  // ここから外すと原本と注入コピーが食い違うので、スクリプトでは外さない。
  if (await isSelfInjection(projectRootPath, packsRoot)) {
    return refuse(
      'self-injection',
      `${projectRootPath} はパック原本を抱える repo (自己注入先) です。ここのパックはスクリプトでは外しません`,
    );
  }

  const manifest = await readManifestFromDisk(projectRootPath);
  const removability = evaluatePackRemovability(packName, available, manifest);
  if (!removability.ok) {
    return refuse(removability.code, removability.reason);
  }

  const record = manifest.packs.find((entry) => entry.name === packName);
  if (record === undefined) {
    return refuse('not-injected', `${packName} は注入記録にありません`);
  }

  const files: { relativePath: string; exists: boolean }[] = [];
  for (const relativePath of [...record.files].sort(compareStrings)) {
    const absolute = resolveUnderClaudeDir(projectRootPath, relativePath);
    if (absolute === null) {
      return refuse(
        'unsafe-path',
        `注入記録に .claude/ の外を指すパスがあります: ${relativePath} (記録を直してから外してください)`,
      );
    }
    files.push({ relativePath, exists: await exists(absolute) });
  }

  const settings: { relativePath: string; write: PlannedWrite }[] = [];
  try {
    for (const relativePath of [SETTINGS_RELATIVE_PATH, LOCAL_SETTINGS_RELATIVE_PATH]) {
      const write = await planHookRemoval(projectRootPath, packName, relativePath, {
        pruneEmpty: true,
      });
      if (write !== null) {
        settings.push({ relativePath, write });
      }
    }
  } catch (error) {
    if (error instanceof HarnessPathTraversalError || error instanceof HarnessInjectionError) {
      return refuse('settings-unreadable', error.message);
    }
    throw error;
  }

  const remainingPacks = manifest.packs
    .filter((entry) => entry.name !== packName)
    .map((entry) => entry.name);
  const manifestAbsolute = resolveUnderClaudeDir(projectRootPath, MANIFEST_RELATIVE_PATH);
  if (manifestAbsolute === null) {
    return refuse('unsafe-path', '注入記録のパスが .claude/ の外を指しています');
  }
  const manifestContent =
    remainingPacks.length === 0
      ? null
      : serializeManifest({ packs: manifest.packs.filter((entry) => entry.name !== packName) });

  const gitignoreAbsolute = path.join(projectRootPath, GITIGNORE_FILENAME);
  const gitignoreBefore = await readTextOrNull(gitignoreAbsolute);
  const gitignoreAfter =
    gitignoreBefore === null
      ? null
      : removeGitignoreEntries(gitignoreBefore, packName, {
          removeManifestEntry: remainingPacks.length === 0,
        });

  return {
    ok: true,
    projectRootPath,
    packName,
    files,
    settings,
    gitignore:
      gitignoreBefore !== null && gitignoreAfter !== null && gitignoreAfter !== gitignoreBefore
        ? { absolute: gitignoreAbsolute, content: gitignoreAfter }
        : null,
    manifest: { absolute: manifestAbsolute, content: manifestContent, remainingPacks },
    unresolvedPacks: unresolvedInstalledPacks(available, manifest),
  };
}
