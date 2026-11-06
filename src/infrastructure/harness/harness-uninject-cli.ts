import path from 'node:path';
import { createFsPackRegistry } from './fs-pack-registry.js';
import { applyUninject } from './fs-harness-injector/uninject-apply.js';
import { planUninject } from './fs-harness-injector/uninject-pack.js';
import { describePlan, parseArgs, UNINJECT_USAGE } from './harness-uninject-args.js';

export { UNINJECT_SCRIPT_NAME, UNINJECT_USAGE } from './harness-uninject-args.js';

/**
 * `scripts/harness-uninject.mjs` の本体 (bdboard-l1m1.7)。引数の解釈・ゲート・表示だけを
 * 持ち、何を消すかの判断は `planUninject` / `applyUninject` に任せる。
 *
 * 既定は dry-run (何を消すかを表示するだけ)。実際に消す `--yes` には 3 層のゲートがある:
 *   1. 環境変数 `CLAUDECODE` が設定されている (Claude Code の中) なら拒否。
 *   2. 標準入力が TTY でなければ拒否。
 *   3. 一覧を表示したあと、制御端末 (/dev/tty) でパック名を入力させ、一致しなければ何もしない。
 * 実行はユーザーが Claude Code の外の自分の端末で行う (エージェントはコマンドを提示するだけ)。
 * 1 と 2 は擬似端末 (`script` など) や環境変数の削除で抜けられるので、機械的な保証ではない —
 * permissions.deny と hook を併用する前提の、誤実行を止める層。TTY を偽装する手段は設けない。
 */

export const EXIT_OK = 0;
/** 規則による拒否 (自己注入先・依存されている・注入記録に無い、など)。 */
export const EXIT_REFUSED = 1;
/** 使い方の誤り、または --yes のゲートで止まった。 */
export const EXIT_USAGE = 2;

export interface UninjectCliIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  /** 標準入力が対話端末か。`process.stdin.isTTY === true`。 */
  readonly stdinIsTty: boolean;
  /**
   * Claude Code の中で動いているか (環境変数 `CLAUDECODE` が**設定されているか**だけを見る。値は読まない)。
   * エージェントの Bash では設定されている。擬似端末を作られても `--yes` を止める 2 層目。
   */
  readonly insideAgent: boolean;
  /**
   * 制御端末 (/dev/tty) に質問を出して 1 行の答えを返す。端末を開けなければ null。
   * 標準入力を使わない (パイプや擬似端末への入力では答えられない)。
   */
  readonly askTty: (question: string) => Promise<string | null>;
}

function gateRefusal(io: UninjectCliIo): string | null {
  if (io.insideAgent) {
    return [
      '拒否: --yes (実際に外す操作) は Claude Code の中からは実行できません (環境変数 CLAUDECODE が設定されています)。',
      'Claude Code の外の通常の端末 (対話シェル) で、ユーザー自身が実行してください。',
      'dry-run (--yes なし) なら、何を消すかを表示だけします。',
    ].join('\n');
  }
  if (!io.stdinIsTty) {
    return [
      '拒否: --yes (実際に外す操作) は対話端末でしか実行できません。',
      'ユーザーが自分の端末 (対話シェル) で実行してください。エージェントや自動化からは実行できません。',
      'dry-run (--yes なし) なら、何を消すかを表示だけします。',
    ].join('\n');
  }
  return null;
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

  // ゲートは何を読む前にも行う。
  const refusal = args.yes ? gateRefusal(io) : null;
  if (refusal !== null) {
    io.err(`${refusal}\n`);
    return EXIT_USAGE;
  }

  const plan = await planUninject({
    projectRootPath: path.resolve(args.project),
    packName: args.pack,
    packsRoot,
    available: await createFsPackRegistry(packsRoot).listPacks(),
    allowUnresolved: args.allowUnresolved,
  });

  if (!plan.ok) {
    io.err(`拒否 (${plan.code}): ${plan.reason}\n`);
    return EXIT_REFUSED;
  }

  io.out(`${describePlan(plan).join('\n')}\n\n`);

  if (!args.yes) {
    io.out(
      'これは dry-run です。何も変更していません。実際に外すには、Claude Code の外のあなた自身の端末で同じコマンドに --yes を付けて実行してください。\n',
    );
    return EXIT_OK;
  }

  const answer = await io.askTty(`本当に外すなら、パック名 (${plan.packName}) を入力してください: `);
  if (answer === null) {
    io.err('拒否: 制御端末 (/dev/tty) を開けないため、確認を取れません。何も変更していません。\n');
    return EXIT_USAGE;
  }
  if (answer.trim() !== plan.packName) {
    io.err('中止: 入力がパック名と一致しません。何も変更していません。\n');
    return EXIT_REFUSED;
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
