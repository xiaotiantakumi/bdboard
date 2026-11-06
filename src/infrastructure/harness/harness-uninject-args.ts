import type { UninjectPlan } from './fs-harness-injector/uninject-pack.js';

/** `harness-uninject-cli.ts` の引数解釈・使い方・計画の表示 (bdboard-l1m1.7)。 */

export const UNINJECT_SCRIPT_NAME = 'scripts/harness-uninject.mjs';

export const UNINJECT_USAGE = `使い方:
  node <bdboard のルート>/${UNINJECT_SCRIPT_NAME} --project <注入先プロジェクトのパス> --pack <パック名> [--yes] [--allow-unresolved]

  既定は dry-run です (何を消すかを表示するだけで、何も変えません)。
  実際に外すには --yes を付けて、Claude Code の外の、あなた自身の端末 (対話シェル) で実行してください。
  --yes は、標準入力が TTY でない場合と、環境変数 CLAUDECODE が設定されている場合 (Claude Code の
  中) は拒否します。一覧の表示後に、制御端末 (/dev/tty) でパック名の入力を求めます。
  --allow-unresolved: パック一覧に無い注入済みパックがあっても、依存を確かめずに進めます。

  外すのは、注入が作ったもの (skill ファイル・settings.json / settings.local.json の hook・
  注入記録・.gitignore の管理行) です。コミットはしません。`;

export interface ParsedArgs {
  readonly project: string | undefined;
  readonly pack: string | undefined;
  readonly yes: boolean;
  readonly allowUnresolved: boolean;
  readonly help: boolean;
  readonly unknown: readonly string[];
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let project: string | undefined;
  let pack: string | undefined;
  let yes = false;
  let allowUnresolved = false;
  let help = false;
  const unknown: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--yes') {
      yes = true;
    } else if (arg === '--allow-unresolved') {
      allowUnresolved = true;
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--project' || arg === '--pack') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        unknown.push(`${arg} (値がありません)`);
      } else {
        if (arg === '--project') {
          project = value;
        } else {
          pack = value;
        }
        index += 1;
      }
    } else {
      unknown.push(arg ?? '');
    }
  }

  return { project, pack, yes, allowUnresolved, help, unknown };
}

export function describePlan(plan: UninjectPlan): string[] {
  const lines: string[] = [];
  const present = plan.files.filter((file) => file.exists);
  lines.push(`外す: ${plan.packName}  (注入先: ${plan.projectRootPath})`);
  lines.push('');
  lines.push(`skill ファイル: ${present.length} 件を削除 (記録は ${plan.files.length} 件)`);
  for (const file of present) {
    lines.push(`  - ${file.relativePath}`);
  }
  const missing = plan.files.length - present.length;
  if (missing > 0) {
    lines.push(`  (既に無いファイルが ${missing} 件。無視します)`);
  }

  if (plan.settings.length === 0) {
    lines.push('hook 登録: 取り除くものはありません (settings.json / settings.local.json)');
  }
  for (const { relativePath, write } of plan.settings) {
    lines.push(
      write.content === null
        ? `hook 登録: ${relativePath} から ${plan.packName} の hook を取り除くと空になるため、ファイルごと削除`
        : `hook 登録: ${relativePath} から ${plan.packName} の hook だけを取り除く (他の設定は変えません)`,
    );
  }

  lines.push(
    plan.gitignore === null
      ? '.gitignore: 戻す行はありません'
      : `.gitignore: ${plan.packName} の管理行を戻す (settings.local.json の行は共有なので残します)`,
  );
  lines.push(
    plan.manifest.content === null
      ? `注入記録: 最後のパックなので .claude/bdboard-packs.json ごと削除`
      : `注入記録: ${plan.packName} の entry を消す (残るパック: ${plan.manifest.remainingPacks.join(', ')})`,
  );
  lines.push('空になった .claude/ 配下のディレクトリは畳みます (他のファイルがあれば残します)。');

  if (plan.unresolvedPacks.length > 0) {
    lines.push('');
    lines.push(
      `注意: ${plan.unresolvedPacks.join(', ')} はパック一覧に無く、requires を確かめられませんでした (--allow-unresolved で依存の判定に含めずに進めます)`,
    );
  }
  return lines;
}
