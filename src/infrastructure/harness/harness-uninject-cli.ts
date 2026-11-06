import path from 'node:path';
import { createFsPackRegistry } from './fs-pack-registry.js';
import { applyUninject } from './fs-harness-injector/uninject-apply.js';
import { planUninject, type UninjectPlan } from './fs-harness-injector/uninject-pack.js';

/**
 * `scripts/harness-uninject.mjs` の本体 (bdboard-l1m1.7)。引数の解釈・TTY ゲート・表示だけを
 * 持ち、何を消すかの判断は `planUninject` / `applyUninject` に任せる。
 *
 * 既定は dry-run (何を消すかを表示するだけ)。実際に消すには `--yes` と対話端末 (標準入力が
 * TTY) の両方が要る。エージェントの Bash は TTY を持たないので `--yes` は機械的に拒否される。
 * 実行はユーザーが自分の端末で行う (エージェントはコマンドを提示するだけ)。
 */

export const EXIT_OK = 0;
/** 規則による拒否 (自己注入先・依存されている・注入記録に無い、など)。 */
export const EXIT_REFUSED = 1;
/** 使い方の誤り、または TTY が無いのに --yes。 */
export const EXIT_USAGE = 2;

export interface UninjectCliIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  /** 標準入力が対話端末か。`process.stdin.isTTY === true`。 */
  readonly stdinIsTty: boolean;
}

interface ParsedArgs {
  readonly project: string | undefined;
  readonly pack: string | undefined;
  readonly yes: boolean;
  readonly help: boolean;
  readonly unknown: readonly string[];
}

export const UNINJECT_SCRIPT_NAME = 'scripts/harness-uninject.mjs';

export const UNINJECT_USAGE = `使い方:
  node <bdboard のルート>/${UNINJECT_SCRIPT_NAME} --project <注入先プロジェクトのパス> --pack <パック名> [--yes]

  既定は dry-run です (何を消すかを表示するだけで、何も変えません)。
  実際に外すには --yes を付けて、あなた自身の端末 (対話シェル) で実行してください。
  エージェント (TTY の無い実行) からの --yes は拒否されます。

  外すのは、注入が作ったもの (skill ファイル・settings.json / settings.local.json の hook・
  注入記録・.gitignore の管理行) です。コミットはしません。`;

function parseArgs(argv: readonly string[]): ParsedArgs {
  let project: string | undefined;
  let pack: string | undefined;
  let yes = false;
  let help = false;
  const unknown: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--yes') {
      yes = true;
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

  return { project, pack, yes, help, unknown };
}

function describePlan(plan: UninjectPlan): string[] {
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
      `注意: ${plan.unresolvedPacks.join(', ')} はパック一覧に無く、requires を確かめられませんでした (依存の判定に含めていません)`,
    );
  }
  return lines;
}

/**
 * `packsRoot` はパック原本の置き場 (`<bdboard のルート>/harness/packs`)。テストでは一時
 * ディレクトリを渡す。戻り値は終了コード。
 */
export async function runHarnessUninject(
  argv: readonly string[],
  io: UninjectCliIo,
  packsRoot: string,
): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    io.out(`${UNINJECT_USAGE}\n`);
    return EXIT_OK;
  }
  if (args.unknown.length > 0 || args.project === undefined || args.pack === undefined) {
    const problems =
      args.unknown.length > 0
        ? `解釈できない引数: ${args.unknown.join(' ')}`
        : '--project と --pack は必須です';
    io.err(`${problems}\n\n${UNINJECT_USAGE}\n`);
    return EXIT_USAGE;
  }

  // TTY ゲートは何を読む前にも行う。--yes は「ユーザーが自分の端末で実行する」ことの証明に
  // 対話端末を要求する。エージェントの Bash (TTY 無し) はここで止まる。
  if (args.yes && !io.stdinIsTty) {
    io.err(
      [
        '拒否: --yes (実際に外す操作) は対話端末でしか実行できません。',
        'ユーザーが自分の端末 (対話シェル) で実行してください。エージェントや自動化からは実行できません。',
        'dry-run (--yes なし) なら、何を消すかを表示だけします。',
      ].join('\n') + '\n',
    );
    return EXIT_USAGE;
  }

  const projectRootPath = path.resolve(args.project);
  const available = await createFsPackRegistry(packsRoot).listPacks();
  const plan = await planUninject({
    projectRootPath,
    packName: args.pack,
    packsRoot,
    available,
  });

  if (!plan.ok) {
    io.err(`拒否 (${plan.code}): ${plan.reason}\n`);
    return EXIT_REFUSED;
  }

  io.out(`${describePlan(plan).join('\n')}\n\n`);

  if (!args.yes) {
    io.out(
      'これは dry-run です。何も変更していません。実際に外すには、あなた自身の端末で同じコマンドに --yes を付けて実行してください。\n',
    );
    return EXIT_OK;
  }

  await applyUninject(plan);
  io.out(
    [
      `完了: ${plan.packName} を外しました。`,
      '注入先の作業ツリーに差分が出ることがあります (.gitignore や settings.json の変更など)。',
      'このスクリプトは commit しません。コミットは別途行ってください。',
    ].join('\n') + '\n',
  );
  return EXIT_OK;
}
