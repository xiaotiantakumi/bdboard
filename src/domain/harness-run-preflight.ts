import {
  HARNESS_CONTRACT_RELATIVE_PATH,
  type HarnessPrFlow,
} from './harness-contract.js';
import { SETTINGS_RELATIVE_PATH } from './harness-hooks.js';
import type { ProjectHarnessStatus } from './harness-pack.js';

/**
 * エージェント実行 (POST /api/runs) の前提条件判定 (bdboard-pkr6.11)。
 *
 * run のプロンプトは「bdboard-harness skill が inject されている前提でその手順に
 * 従え」と言うだけで、注入されているかを確かめていなかった。skill が無ければ
 * 手順は存在せず、hook が未登録なら機械ガード (P1a) は効かず、検証コントラクトが
 * 無ければ「何をもって合格か」が誰にも分からない。前提が無い状態で spawn するのは
 * 「効いているつもりのハーネス」を量産するだけなので、ここで止める。
 *
 * ここが純粋関数なのは、ハーネス状態の読み取り (ファイル I/O) を持ち込まずに
 * 判定の優先順位と drift の扱いをテストで固定したいから。
 */

/** run の前提として要求するパック名。 */
export const RUN_REQUIRED_PACK_NAME = 'bdboard-harness';

/** drift は止めない。警告としてだけレスポンスに載せる。 */
export const HARNESS_DRIFT_WARNING = 'harness-drift';

export type RunPreflightFailureReason =
  | 'harness-not-injected'
  | 'harness-hooks-missing'
  | 'harness-contract-missing'
  | 'harness-contract-invalid';

export interface RunPreflightFailure {
  readonly ok: false;
  readonly reason: RunPreflightFailureReason;
  /** 何を直せばよいかまで書いた日本語の詳細。HTTP では `detail` として返す。 */
  readonly detail: string;
  /** `harness-hooks-missing` のときだけ非空。 */
  readonly missingHooks: readonly string[];
}

export interface RunPreflightSuccess {
  readonly ok: true;
  /** 止めはしないが伝える事柄 (現状 `harness-drift` のみ)。 */
  readonly warnings: readonly string[];
  readonly verify: string;
  readonly prFlow: HarnessPrFlow;
  readonly mainBranch: string;
}

export type RunPreflightOutcome = RunPreflightFailure | RunPreflightSuccess;

function failure(
  reason: RunPreflightFailureReason,
  detail: string,
  missingHooks: readonly string[] = [],
): RunPreflightFailure {
  return { ok: false, reason, detail, missingHooks };
}

/**
 * 判定順は「注入 → hook → コントラクト」。前段が満たされていないと後段の状態は
 * 意味を持たない (未注入プロジェクトのコントラクトは `not-applicable` になる) ので、
 * 最初に見つかった 1 件だけを返して直す順序をそのまま示す。
 *
 * `command-missing` は「コントラクトはあるが verify が指す npm script が無い」で、
 * ファイルの不在 (`missing`) とは別物だが、呼び出し側が分岐する必要は無いので
 * `harness-contract-invalid` に畳む — 直す場所はどちらも同じ 1 ファイル。
 * どこがどう壊れているかは `detail` に書く。
 */
export function evaluateRunPreflight(
  status: ProjectHarnessStatus,
  packName: string = RUN_REQUIRED_PACK_NAME,
): RunPreflightOutcome {
  const pack = status.packs.find((entry) => entry.name === packName);
  if (pack === undefined || pack.installedVersion === null) {
    return failure(
      'harness-not-injected',
      `${packName} が注入されていません。Hygiene パネルまたはプロジェクト見出しの「注入」から入れてください。`,
    );
  }

  if (pack.hooksState === 'missing' || pack.hooksState === 'partial') {
    return failure(
      'harness-hooks-missing',
      `hook が ${SETTINGS_RELATIVE_PATH} に未登録です (${pack.missingHooks.join(', ')})。「再注入」で登録されます。`,
      pack.missingHooks,
    );
  }

  const { contract } = status;
  switch (contract.state) {
    case 'missing':
    // 注入済みなら `not-applicable` は来ない (未注入だけがその状態) が、
    // 型を閉じるために「宣言が無い」と同じ扱いにしておく。
    case 'not-applicable':
      return failure(
        'harness-contract-missing',
        `${HARNESS_CONTRACT_RELATIVE_PATH} に検証コマンド (verify) を宣言してください。`,
      );
    case 'invalid':
      return failure(
        'harness-contract-invalid',
        `${HARNESS_CONTRACT_RELATIVE_PATH} が不正です: ${contract.message}`,
      );
    case 'command-missing':
      return failure(
        'harness-contract-invalid',
        `verify (${contract.verify}) が指す npm script ${contract.script} が package.json にありません。`,
      );
    case 'ok':
      return {
        ok: true,
        warnings: pack.drift ? [HARNESS_DRIFT_WARNING] : [],
        verify: contract.verify,
        prFlow: contract.prFlow,
        mainBranch: contract.mainBranch,
      };
  }
}
