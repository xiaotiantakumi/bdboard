// bd-cli-human-decisions.ts (bdboard-sso1.16) の分割で切り出した、pending decisions
// (human ラベル一覧 + human gate 一覧)の読み取り担当。挙動・型は分割前と同一(移動のみ)。
// listPendingDecisions は元は createBdCliHumanDecisions() が返すオブジェクトのメソッドで
// commandRunner/bdPath/timeoutMs をクロージャで捕捉していたが、モジュール分割にあたり
// それらを明示引数に変えただけで本体のロジックは1文字も変えていない(入口の
// createBdCliHumanDecisions は bd-cli-human-decisions.ts に残し、ここへ委譲する)。
// bd stdout のパース (schema/parseListStdout/parseGateListStdout/mergePendingDecisions) は
// ./read-parse.ts へ委譲する (このファイルだけで 200 行の上限を超えるため)。
import type { CommandRunner } from '../../../application/ports/command-runner.js';
import type { PendingDecision } from '../../../application/ports/human-decisions.js';
import { runBdCommandOrThrow } from './shared.js';
import { mergePendingDecisions, parseGateListStdout, parseListStdout } from './read-parse.js';

function buildListArgs(rootPath: string): readonly string[] {
  return [
    '--readonly',
    '-C',
    rootPath,
    'list',
    '-l',
    'human',
    '--json',
    '--limit',
    '0',
    '--no-pager',
  ];
}

function buildGateListArgs(rootPath: string): readonly string[] {
  // bd gate list には --no-pager フラグが無い。
  return ['--readonly', '-C', rootPath, 'gate', 'list', '--json', '--limit', '0'];
}

// bd list --readonly は読み取り専用でべき等なので、lock-contention なら
// 数回まで自動リトライしてよい(bdboard-3tj)。respond() 側の bd comment /
// bd close / bd label remove はどちらも書き込みで、特に comment は追記系で
// べき等ではないため(二重投稿のリスク)意図的にリトライ対象から外している。
//
// gate bead は human ラベルを持たず await_type: 'human' を持つため、
// `bd list -l human` だけでは取れない。追加で `bd gate list` を呼ぶ(bdboard-bh48)。
// gate list の失敗を握りつぶすと ticket 分だけ返り gate が無言で消える —
// refresh-projects は例外を catch してキャッシュ + errors にフォールバックする設計なので、
// ここでは fail-soft にせず BdError を throw する。
export async function listPendingDecisions(
  commandRunner: CommandRunner,
  bdPath: string,
  timeoutMs: number,
  rootPath: string,
): Promise<readonly PendingDecision[]> {
  const labelResult = await runBdCommandOrThrow(
    commandRunner,
    bdPath,
    buildListArgs(rootPath),
    timeoutMs,
    rootPath,
  );
  const gateResult = await runBdCommandOrThrow(
    commandRunner,
    bdPath,
    buildGateListArgs(rootPath),
    timeoutMs,
    rootPath,
  );

  const labelDecisions = parseListStdout(labelResult.stdout);
  const gateDecisions = parseGateListStdout(gateResult.stdout);
  return mergePendingDecisions(labelDecisions, gateDecisions);
}
