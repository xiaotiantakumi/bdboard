// bdboard-ulxa.1: npm run merge-pr -- <phase> ... の引数解釈とフェーズの振り分け。
import { EXIT, MergePrError, openContext } from './context.mjs';
import { finish, verifyLanded } from './finish.mjs';
import { gate } from './gate.mjs';
import { prepare } from './prepare.mjs';
import { say } from './state.mjs';

export const USAGE = `merge-pr — マージ手順 S1 / S2 (枠は CAS とマージの一瞬だけ握る。設計 bdboard-ulxa)

  npm run merge-pr -- prepare <PR> [--dry-run]   枠の外: PR / 必須チェック / main を確かめ PRED_BASE を記録
                                                 (S2: main が動いていれば着地予定ツリーを verify。--dry-run は
                                                  どの段階でも S2 の分類を参考表示し、verify はしない)
  npm run merge-pr -- gate <PR> [--repair]       層3 ゲート → bd merge-slot acquire → CAS → マージ行を stdout に印字
                                                 (--repair: main 破損の修復 PR 専用。main-broken の枠を引き継ぐ)
  <印字された gh pr merge ... --match-head-commit ... を 1 回だけ実行>
  npm run merge-pr -- finish <PR>                枠を返す → 着地後検証 (detach checkout + verify) → commit status
  npm run merge-pr -- verify <SHA>               任意の main の SHA を着地後検証して台帳に書く (復旧用)

  PR の worktree (git worktree add で作ったもの) で実行する。main checkout では着地後検証を拒否する。
  stdout を機械的に使うなら npm run -s merge-pr -- ... (npm の見出し行を出さない)。

  merge.mode (.claude/bdboard-harness.json、origin/main の値が正) が S0 の間は prepare の表示だけ動く。

終了コード: 0 成功 / 1 使い方・想定外 / 2 前提不成立 / 4 main が壊れている
            3 rebase が要る (S1: main が動いた / S2: テキスト衝突・hot file・着地予定ツリーの verify failure)
            5 finish: 未マージ (枠は返した) / 6 finish: 着地後検証 failure / 75 やり直し (CAS 負け等)`;

function parsePr(value) {
  if (!/^[1-9][0-9]*$/.test(value ?? '')) {
    throw new MergePrError(EXIT.USAGE, [`PR 番号が必要です (受領: ${value ?? '(なし)'})。npm run merge-pr -- --help`]);
  }
  return Number(value);
}

export async function main(argv) {
  const [phase, target, ...rest] = argv;
  try {
    if (phase === undefined || phase === '-h' || phase === '--help' || phase === 'help') {
      process.stdout.write(`${USAGE}\n`);
      return phase === undefined ? EXIT.USAGE : EXIT.OK;
    }
    const flags = new Set(rest);
    const allowed = { prepare: '--dry-run', gate: '--repair' };
    for (const flag of flags) {
      if (allowed[phase] !== flag) {
        throw new MergePrError(EXIT.USAGE, [`unknown option for ${phase}: ${flag}`]);
      }
    }
    switch (phase) {
      case 'prepare': {
        const pr = parsePr(target);
        return await prepare(openContext(), pr, { dryRun: flags.has('--dry-run') });
      }
      case 'gate': {
        const pr = parsePr(target);
        return await gate(openContext(), pr, { repair: flags.has('--repair') });
      }
      case 'finish': {
        const pr = parsePr(target);
        // 枠を返すのが最優先。fetch に失敗しても手元の origin/main で続ける。
        return await finish(openContext({ allowOffline: true }), pr);
      }
      case 'verify':
        if (!/^[0-9a-f]{7,40}$/.test(target ?? '')) {
          throw new MergePrError(EXIT.USAGE, [`SHA が必要です (受領: ${target ?? '(なし)'})`]);
        }
        return await verifyLanded(openContext(), target);
      default:
        throw new MergePrError(EXIT.USAGE, [`unknown phase: ${phase}。npm run merge-pr -- --help`]);
    }
  } catch (error) {
    if (error instanceof MergePrError) {
      say(...error.lines);
      return error.code;
    }
    say(`想定外のエラー: ${error?.message ?? error}`);
    return EXIT.USAGE;
  }
}
