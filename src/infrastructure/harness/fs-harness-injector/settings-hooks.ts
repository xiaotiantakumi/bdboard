import fs from 'node:fs';
import path from 'node:path';
import {
  CLAUDE_PROJECT_DIR_PLACEHOLDER,
  harnessHookMarker,
  LOCAL_SETTINGS_RELATIVE_PATH,
  mergeHarnessHooks,
  SETTINGS_RELATIVE_PATH,
} from '../../../domain/harness-hooks.js';
import type { PackDefinition } from '../../../domain/harness-pack.js';
import { resolveUnderClaudeDir } from '../../../domain/harness-path.js';
import {
  HarnessInjectionError,
  HarnessPathTraversalError,
} from '../../../application/ports/harness-injector.js';

/**
 * hook の登録先 (bdboard-l1m1.8)。
 *
 * - `local`: `.claude/settings.local.json` (git 管理外)。通常の注入先。注入と取り直しが
 *   git の差分に出ない。
 * - `tracked`: `.claude/settings.json` (git 追跡)。パック原本を抱える自己注入 (bdboard 自身。
 *   設定ごと追跡する設計) だけがこちら。
 */
export type HookSettingsTarget = 'local' | 'tracked';

function settingsRelativePathFor(target: HookSettingsTarget): string {
  return target === 'local' ? LOCAL_SETTINGS_RELATIVE_PATH : SETTINGS_RELATIVE_PATH;
}

function resolveSettingsAbsolute(projectRootPath: string, relativePath: string): string {
  const absolute = resolveUnderClaudeDir(projectRootPath, relativePath);
  if (absolute === null) {
    throw new HarnessPathTraversalError('settings path escapes .claude/');
  }
  return absolute;
}

/**
 * 表示 (hooksState) 用の寛容な読み取り。読めない理由を問わず null にする —
 * ここでの失敗はハーネス状態の表示を諦める理由にはなるが、ボード全体を落とす
 * 理由ではない。**書き込み経路ではこれを使わない** (下の readSettingsForWrite)。
 *
 * hook は書き込み先 (settings.local.json) にも、自己注入や移行前の注入先では
 * settings.json にも登録されうる。登録状況はその**和集合**で見るので、両方を
 * `[settings.json, settings.local.json]` の順で返す (片方でも読めれば状態は判定できる)。
 */
export async function readSettingsFromDisk(
  projectRootPath: string,
): Promise<readonly (string | null)[]> {
  return Promise.all(
    [SETTINGS_RELATIVE_PATH, LOCAL_SETTINGS_RELATIVE_PATH].map(async (relativePath) => {
      const absolute = resolveUnderClaudeDir(projectRootPath, relativePath);
      if (absolute === null) {
        return null;
      }
      try {
        return await fs.promises.readFile(absolute, 'utf8');
      } catch {
        return null;
      }
    }),
  );
}

/**
 * 書き込み経路用の厳格な読み取り。**「無い」と「読めない」を混同しない**。
 *
 * 寛容な読み取りをそのまま使うと、EACCES / EISDIR / EMFILE で null が返り、
 * マージが「設定ファイルが存在しない」と解釈して `{}` から組み立てた JSON で
 * 既存ファイルを丸ごと潰す。ENOENT だけを「無い」とみなし、それ以外は注入ごと
 * 失敗させる (PR#290 レビュー major-1)。
 */
async function readSettingsForWrite(
  settingsAbsolute: string,
  relativePath: string,
): Promise<string | null> {
  try {
    return await fs.promises.readFile(settingsAbsolute, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return null;
    }
    throw new HarnessInjectionError(`failed to read ${relativePath}`, error);
  }
}

async function writeSettings(
  settingsAbsolute: string,
  relativePath: string,
  content: string,
): Promise<void> {
  try {
    await fs.promises.mkdir(path.dirname(settingsAbsolute), { recursive: true });
    await fs.promises.writeFile(settingsAbsolute, content, 'utf8');
  } catch (error) {
    throw new HarnessInjectionError(`failed to write ${relativePath}`, error);
  }
}

interface PlannedWrite {
  readonly absolute: string;
  readonly content: string;
}

/**
 * 移行: 旧登録 (`.claude/settings.json` にある我々の entry) を取り除く計画を立てる。
 *
 * 書き込み先を settings.local.json に切り替えると、移行前の注入先では同じ hook が
 * 両方のファイルに載って二重に走る。再注入のたびに、マーカー (パックの hooks/ ディレクトリ)
 * を含む entry だけを settings.json から外す。他人の entry は一切変えない。
 *
 * - マーカーを含まないファイルは**読むだけで書かない** (人が整形したファイルを
 *   `JSON.stringify` の形に書き換えて、無意味な git 差分を作らないため)。
 * - マーカーがあるのに JSON として解釈できないときは、重複が無いと確かめられないので
 *   注入ごと失敗させる (壊れたファイルは上書きしない)。
 * - 取り除くものが無かったときは null (書かない)。
 */
async function planLegacyRegistrationRemoval(
  projectRootPath: string,
  packName: string,
): Promise<PlannedWrite | null> {
  const absolute = resolveSettingsAbsolute(projectRootPath, SETTINGS_RELATIVE_PATH);
  const existing = await readSettingsForWrite(absolute, SETTINGS_RELATIVE_PATH);
  if (existing === null || !existing.includes(harnessHookMarker(packName))) {
    return null;
  }

  const stripped = mergeHarnessHooks(
    existing,
    { name: packName, hooks: [] },
    CLAUDE_PROJECT_DIR_PLACEHOLDER,
    SETTINGS_RELATIVE_PATH,
  );
  if (!stripped.ok) {
    throw new HarnessInjectionError(
      `failed to remove legacy harness hooks from ${SETTINGS_RELATIVE_PATH}: ${stripped.error}`,
    );
  }

  // マーカーが hook entry 以外の場所 (コメント的な文字列など) にあっただけなら、構造は
  // 変わらない。整形だけの書き換えを避けるため、構造が同じなら書かない。
  if (JSON.stringify(JSON.parse(existing)) === JSON.stringify(JSON.parse(stripped.settingsJson))) {
    return null;
  }

  return { absolute, content: stripped.settingsJson };
}

/**
 * hook を `target` の設定ファイルに登録する。壊れた JSON は上書きせず注入ごと
 * 失敗させる — 人が書いた設定を我々の生成物で潰すほうが、注入が失敗するより
 * 悪い (bdboard-pkr6.2)。
 *
 * `local` のときは、旧登録 (settings.json 側の我々の entry) の除去も行う (二重登録の防止)。
 * 順序は **先に新しい登録を書き、その後で旧登録を消す**: 消す書き込みが失敗しても
 * 「一時的に二重」で済み (再注入で直る)、逆順だと hook が一つも無い窓ができる。
 * 検証 (読み取りと JSON の解釈) は両方とも書き込みより前に終えるので、どちらかの
 * ファイルが壊れていれば何も書かずに失敗する。
 */
export async function registerHooks(
  projectRootPath: string,
  pack: PackDefinition,
  target: HookSettingsTarget,
): Promise<readonly string[]> {
  const relativePath = settingsRelativePathFor(target);
  const settingsAbsolute = resolveSettingsAbsolute(projectRootPath, relativePath);

  const existing = await readSettingsForWrite(settingsAbsolute, relativePath);
  const merged = mergeHarnessHooks(existing, pack, CLAUDE_PROJECT_DIR_PLACEHOLDER, relativePath);
  if (!merged.ok) {
    throw new HarnessInjectionError(
      `failed to register harness hooks: ${merged.error}`,
    );
  }

  const legacyRemoval =
    target === 'local' ? await planLegacyRegistrationRemoval(projectRootPath, pack.name) : null;

  // 宣言も既存内容も無いなら書かない。hook を持たないパックの注入で、空の
  // 設定ファイルを新規作成しないため。
  // 内容が1バイトも変わらないなら書かない。再注入のたびに mtime だけ動くと、
  // ファイル監視や git の作業ツリー差分に無意味なノイズが出る (レビュー minor-1)。
  const skipWrite =
    (merged.registered.length === 0 && existing === null) || merged.settingsJson === existing;
  if (!skipWrite) {
    await writeSettings(settingsAbsolute, relativePath, merged.settingsJson);
  }

  if (legacyRemoval !== null) {
    await writeSettings(legacyRemoval.absolute, SETTINGS_RELATIVE_PATH, legacyRemoval.content);
  }

  return merged.registered;
}
