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
 * 「外す」コマンド (bdboard-l1m1.7 の scripts/harness-uninject.mjs)。
 * スクリプト名・引数の正は src/infrastructure/harness/harness-uninject-args.ts
 * (UNINJECT_SCRIPT_NAME / UNINJECT_USAGE)。web/ から src/ は import できないので、
 * ここは意図的な二重定義 — そちらを変えるならここも変える (画面は文字列を出すだけ)。
 *
 * スクリプトは bdboard のチェックアウトにあるので、相対パスでは bdboard 以外のディレクトリから
 * 実行すると見つからない。サーバーが自分のルートを返したときはそれを絶対パスで埋め
 * (`bdboardRootPath`)、返さないときは `<BDBOARD_ROOT>` のプレースホルダを残す。
 *
 * サーバーはパックを外さない — 実行はユーザーが自分の端末で行い、エージェントは実行しない。
 * 既定は dry-run (何を消すかの表示だけ)。実際に外す `--yes` は Claude Code の外の端末だけで通る。
 */
export const HARNESS_UNINJECT_SCRIPT_PATH = 'scripts/harness-uninject.mjs';

export const HARNESS_UNINJECT_ROOT_PLACEHOLDER = '<BDBOARD_ROOT>';

export const HARNESS_UNINJECT_COMMAND_TEMPLATE = `node ${HARNESS_UNINJECT_ROOT_PLACEHOLDER}/${HARNESS_UNINJECT_SCRIPT_PATH} --project <PROJECT_PATH> --pack <PACK_NAME>`;

function quoteForShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * dry-run のコマンド。`bdboardRootPath` が無いときは `<BDBOARD_ROOT>` を残す (コピーしても
 * 実行前に置き換えが要る)。実際に外すコマンドは `buildHarnessUninjectYesCommand`。
 */
export function buildHarnessUninjectCommand(
  projectRootPath: string,
  packName: string,
  bdboardRootPath?: string,
): string {
  const placeholderScript = `${HARNESS_UNINJECT_ROOT_PLACEHOLDER}/${HARNESS_UNINJECT_SCRIPT_PATH}`;
  const script =
    bdboardRootPath === undefined || bdboardRootPath.length === 0
      ? placeholderScript
      : quoteForShell(`${bdboardRootPath.replace(/\/+$/, '')}/${HARNESS_UNINJECT_SCRIPT_PATH}`);
  return HARNESS_UNINJECT_COMMAND_TEMPLATE.replace(placeholderScript, () => script)
    .replace('<PROJECT_PATH>', () => quoteForShell(projectRootPath))
    .replace('<PACK_NAME>', () => quoteForShell(packName));
}

/** 実際に外すコマンド (`--yes`)。Claude Code の外のユーザーの端末でだけ通る。 */
export function buildHarnessUninjectYesCommand(
  projectRootPath: string,
  packName: string,
  bdboardRootPath?: string,
): string {
  return `${buildHarnessUninjectCommand(projectRootPath, packName, bdboardRootPath)} --yes`;
}

/**
 * ベースを外す前の注意。ほかのパックがそのベースに依存していると、スクリプトは外すのを
 * 拒否する (規則はスクリプト側が持つ)。画面はそれを強制せず、先に確認するよう促すだけ。
 */
export const HARNESS_BASE_UNINJECT_CAUTION =
  'ベースは他のパックの土台です。外す前に、このプロジェクトに入っている他のパックがこのベースに依存していないか確認し、依存しているパックを先に外してください (依存されているままだと、スクリプトは外すのを拒否します)。';
