// bdboard-l1m1.1: 設定画面のパック選択 (HarnessPacksSection) の表示用ヘルパー。
// harnessDisplay.ts がファイル行数の上限に近いので別ファイルにしている。
import type { HarnessPackRoleDto, ProjectHarnessPackStatusDto } from './api';

/**
 * パックの「選んでいる」状態。選択状態の正は注入先の注入記録
 * (`.claude/bdboard-packs.json`) で、入れた = 選んだ。別の保存先は持たないので、
 * `installedVersion` があるかどうかがそのまま選択状態になる。
 */
export function isHarnessPackSelected(pack: ProjectHarnessPackStatusDto): boolean {
  return pack.installedVersion !== null;
}

const PACK_ROLE_LABELS: Record<HarnessPackRoleDto, string> = {
  base: 'ベース',
  optional: '任意',
};

export function formatHarnessPackRole(role: HarnessPackRoleDto): string {
  return PACK_ROLE_LABELS[role];
}

/**
 * ベースは土台、任意パックはベース (requires) を前提に載せる、という区別を 1 行で書く。
 * 依存先は pack.json の requires をそのまま並べる。
 */
export function formatHarnessPackRoleDetail(pack: ProjectHarnessPackStatusDto): string {
  if (pack.role === 'base') {
    return 'ベースのハーネス (他のパックの土台)';
  }
  return pack.requires.length > 0
    ? `任意パック (前提: ${pack.requires.join(', ')})`
    : '任意パック';
}

/**
 * 「外す」コマンドの仮置き。実体の uninject スクリプトは bdboard-l1m1.7 で作る。
 * スクリプト名・引数が決まったらこの 1 か所を差し替える (画面は文字列を出すだけ)。
 * サーバーはパックを外さない — 実行はユーザーが自分の端末で行い、エージェントは実行しない。
 */
export const HARNESS_UNINJECT_COMMAND_TEMPLATE =
  'node scripts/uninject-harness-pack.mjs <PROJECT_PATH> <PACK_NAME>';

function quoteForShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildHarnessUninjectCommand(projectRootPath: string, packName: string): string {
  return HARNESS_UNINJECT_COMMAND_TEMPLATE.replace('<PROJECT_PATH>', () =>
    quoteForShell(projectRootPath),
  ).replace('<PACK_NAME>', () => quoteForShell(packName));
}
