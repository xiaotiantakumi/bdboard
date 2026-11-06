import {
  GITIGNORE_MANAGED_HEADER,
  gitignoreManifestEntry,
  gitignorePackSkillDirEntry,
} from './harness-path.js';

export interface GitignoreRemovalOptions {
  /** 最後のパックを外すとき true。注入記録 (manifest) の行も戻す。 */
  readonly removeManifestEntry: boolean;
}

/**
 * 注入が `.gitignore` に足した管理行のうち、**そのパックの分**を取り除いた全文を返す
 * (`appendGitignoreEntries` の逆。bdboard-l1m1.7)。
 *
 * - 取り除く: 管理ヘッダーより**後ろ**にある `.claude/skills/<pack>/` の行。最後のパックなら注入記録
 *   (`.claude/bdboard-packs.json`) の行も。行は前後の空白を除いた完全一致で見る (部分一致や、
 *   ヘッダーより前にあるユーザー自身の同じ行を巻き込まない)。ヘッダーが無ければ何もしない。
 * - **残す**: 管理ヘッダー (`# bdboard-harness: ...`) と `.claude/settings.local.json` の行。
 *   `settings.local.json` は全パックが共有し、ユーザー自身も使う個人設定なので、パックを
 *   外しても ignore を外さない (外すと個人設定が突然 git の差分に出る)。
 *   その行がヘッダーの下に残るので、ヘッダーも残す。
 * - 該当行が無ければ入力をそのまま返す (呼び出し側は同一性で「変更なし」を判定できる)。
 */
export function removeGitignoreEntries(
  content: string,
  packName: string,
  options: GitignoreRemovalOptions,
): string {
  const targets = new Set<string>();
  const packEntry = gitignorePackSkillDirEntry(packName);
  if (packEntry !== null) {
    targets.add(packEntry);
  }
  if (options.removeManifestEntry) {
    targets.add(gitignoreManifestEntry());
  }
  if (targets.size === 0) {
    return content;
  }

  // 注入が足した行は管理ヘッダーより後ろにしか無い。ヘッダーより前 (ユーザーが自分で書いた
  // 同じ行) は巻き込まない。ヘッダーが無ければ我々の管理行は無いので何もしない。
  const lines = content.split('\n');
  const headerIndex = lines.findIndex((line) => line.trim() === GITIGNORE_MANAGED_HEADER.trim());
  if (headerIndex === -1) {
    return content;
  }
  const kept = lines.filter((line, index) => index <= headerIndex || !targets.has(line.trim()));
  if (kept.length === lines.length) {
    return content;
  }
  return kept.join('\n');
}
