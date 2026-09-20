import fs from 'node:fs';
import path from 'node:path';
import { mergeHarnessHooks, SETTINGS_RELATIVE_PATH } from '../../../domain/harness-hooks.js';
import type { PackDefinition } from '../../../domain/harness-pack.js';
import { resolveUnderClaudeDir } from '../../../domain/harness-path.js';
import {
  HarnessInjectionError,
  HarnessPathTraversalError,
} from '../../../application/ports/harness-injector.js';

/**
 * 表示 (hooksState) 用の寛容な読み取り。読めない理由を問わず null にする —
 * ここでの失敗はハーネス状態の表示を諦める理由にはなるが、ボード全体を落とす
 * 理由ではない。**書き込み経路ではこれを使わない** (下の readSettingsForWrite)。
 */
export async function readSettingsFromDisk(projectRootPath: string): Promise<string | null> {
  const settingsAbsolute = resolveUnderClaudeDir(projectRootPath, SETTINGS_RELATIVE_PATH);
  if (settingsAbsolute === null) {
    return null;
  }

  try {
    return await fs.promises.readFile(settingsAbsolute, 'utf8');
  } catch {
    return null;
  }
}

/**
 * 書き込み経路用の厳格な読み取り。**「無い」と「読めない」を混同しない**。
 *
 * 寛容な読み取りをそのまま使うと、EACCES / EISDIR / EMFILE で null が返り、
 * マージが「settings.json が存在しない」と解釈して `{}` から組み立てた JSON で
 * 既存ファイルを丸ごと潰す。ENOENT だけを「無い」とみなし、それ以外は注入ごと
 * 失敗させる (PR#290 レビュー major-1)。
 */
async function readSettingsForWrite(settingsAbsolute: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(settingsAbsolute, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return null;
    }
    throw new HarnessInjectionError('failed to read .claude/settings.json', error);
  }
}

/**
 * `.claude/settings.json` に hook を登録する。壊れた JSON は上書きせず注入ごと
 * 失敗させる — 人が書いた設定を我々の生成物で潰すほうが、注入が失敗するより
 * 悪い (bdboard-pkr6.2)。
 */
export async function registerHooks(
  projectRootPath: string,
  pack: PackDefinition,
): Promise<readonly string[]> {
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
}
