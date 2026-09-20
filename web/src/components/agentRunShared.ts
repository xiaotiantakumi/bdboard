import {
  ApiError,
  type AgentRunNextStepDto,
  type AgentRunStatusDto,
  type ProjectHarnessStatusDto,
} from '../api';
import {
  HARNESS_CONTRACT_PATH,
  HARNESS_SETTINGS_PATH,
  harnessHooksNeedAttention,
} from '../harnessDisplay';
import { describeWriteError } from '../writeAccessMessage';

export const AGENT_RUN_POLL_INTERVAL_MS = 2000;
export const AGENT_RUN_POLL_MAX_FAILURES = 3;

const WORKTREE_DIRTY_ERROR_SUFFIX = ': uncommitted changes prevent agent run';
// git-worktree-provisioner.ts の formatWorktreeBranchMismatchMessage と同じ affix。
const WORKTREE_BRANCH_MISMATCH_ON_BRANCH = ': on branch ';
const WORKTREE_BRANCH_MISMATCH_EXPECTED = ', expected ';

function extractWorktreeBranchMismatchBranch(
  errorMessage: string | undefined,
): string | undefined {
  if (errorMessage === undefined) {
    return undefined;
  }

  const onBranchIndex = errorMessage.indexOf(WORKTREE_BRANCH_MISMATCH_ON_BRANCH);
  if (onBranchIndex === -1) {
    return undefined;
  }

  const afterOnBranch = errorMessage.slice(
    onBranchIndex + WORKTREE_BRANCH_MISMATCH_ON_BRANCH.length,
  );
  const expectedIndex = afterOnBranch.indexOf(WORKTREE_BRANCH_MISMATCH_EXPECTED);
  if (expectedIndex === -1) {
    return undefined;
  }

  const actualBranch = afterOnBranch.slice(0, expectedIndex).trim();
  return actualBranch.length > 0 ? actualBranch : undefined;
}

function withDetail(base: string, detail: string | undefined): string {
  return detail !== undefined && detail.length > 0 ? `${base}（${detail}）` : base;
}

// エージェント run 開始時の claim 失敗 (bdboard-miqg/bdboard-ezs7): サーバーの
// BdError メッセージは `[<kind>] project=<ticketId>: <bd の stdout+stderr を
// lowercase した本文>` の形 (throwBdToolFailure / BdError のコンストラクタ、
// src/infrastructure/bd/bd-cli-tool-runner.ts, issue-repository.ts)。「別アクターが
// 既に claim している」ケースは bd の実メッセージが
// `issue already claimed by <assignee>` (bd-cli-issue-writer.test.ts に実測値を
// 固定済み) なので、その一部だけを表示用に抜き出す。抜き出せなければ undefined を
// 返し、呼び出し側は汎用文言にフォールバックする。
const CLAIM_FAILED_ALREADY_CLAIMED_PATTERN = /issue already claimed by (.+?)\s*$/i;

function extractClaimFailedAssignee(
  errorMessage: string | undefined,
): string | undefined {
  if (errorMessage === undefined) {
    return undefined;
  }
  const match = CLAIM_FAILED_ALREADY_CLAIMED_PATTERN.exec(errorMessage);
  const assignee = match?.[1]?.trim();
  return assignee !== undefined && assignee.length > 0 ? assignee : undefined;
}

export function isAgentRunInProgress(status: AgentRunStatusDto): boolean {
  return (
    status === 'pending' || status === 'running' || status === 'cancelling'
  );
}

/** run の前提として要求するパック名。サーバーの RUN_REQUIRED_PACK_NAME と対。 */
export const RUN_REQUIRED_HARNESS_PACK = 'bdboard-harness';

/**
 * エージェント実行の前提 (ハーネス注入・hook 登録・検証コントラクト) を満たして
 * いないときの、ボタン脇に出す 1 行 (bdboard-pkr6.11 仕様2)。満たしていれば null。
 *
 * これはサーバー側 `evaluateRunPreflight` の**先出し**であって代替ではない。
 * 最終判定は常にサーバーの 409 で、ここは「押しても弾かれるボタン」を押させない
 * ための表示。したがって status が未取得 (`undefined`) の間は止めない — 取得
 * できないことを理由にボタンを殺すと、ハーネスが揃っているのに実行できない
 * 状態になる。判定順 (注入 → hook → コントラクト) はサーバーと揃える。
 */
export function describeHarnessRunBlock(
  status: ProjectHarnessStatusDto | undefined,
): string | null {
  if (status === undefined) {
    return null;
  }

  const pack = status.packs.find((entry) => entry.name === RUN_REQUIRED_HARNESS_PACK);
  if (pack === undefined || pack.installedVersion === null) {
    return 'ハーネス未注入 — Hygiene から注入';
  }
  if (harnessHooksNeedAttention(pack)) {
    return 'hook 未登録 — 再注入';
  }

  switch (status.contract.state) {
    case 'missing':
    // 注入済みなら not-applicable は来ないが、来たら「宣言が無い」と同じ扱い。
    case 'not-applicable':
      return `検証ループ未定義 — ${HARNESS_CONTRACT_PATH} を作成`;
    case 'invalid':
      return `検証コントラクト不正 — ${HARNESS_CONTRACT_PATH} を修正`;
    case 'command-missing':
      return `検証コマンド未定義 — npm script ${status.contract.script} を追加`;
    case 'ok':
      return null;
  }
}

/** 「次に実行」としてコピーさせる 1 行。worktree へ入ってから検証する。 */
export function buildRunNextStepCommand(nextStep: AgentRunNextStepDto): string {
  return `cd ${nextStep.worktreePath} && ${nextStep.verify}`;
}

export function describeRunStartError(error: unknown): string {
  if (error instanceof ApiError) {
    // 分岐はサーバーが返す機械可読な `reason` で行う。`error` の文言は
    // `<worktree path>: uncommitted changes prevent agent run` という可変の
    // 形なので、表示用のパス抽出にだけ使い、判定には使わない。
    if (error.status === 409 && error.reason === 'worktree-dirty') {
      const path = error.errorMessage?.endsWith(WORKTREE_DIRTY_ERROR_SUFFIX)
        ? error.errorMessage.slice(0, -WORKTREE_DIRTY_ERROR_SUFFIX.length)
        : undefined;
      const base =
        '対象の worktree に未コミットの変更があるため実行できません。変更を整理してから再実行してください。';
      return path !== undefined && path.length > 0 ? `${base}(${path})` : base;
    }
    // ハーネス preflight (bdboard-pkr6.11)。`detail` はサーバーが組み立てた
    // 「何を直すか」で、パック名や壊れている箇所を含む。
    if (error.status === 409 && error.reason === 'harness-not-injected') {
      return withDetail(
        'ハーネス (bdboard-harness) が注入されていないため実行できません。',
        error.detail,
      );
    }
    if (error.status === 409 && error.reason === 'harness-hooks-missing') {
      return withDetail(
        `ハーネスの hook が ${HARNESS_SETTINGS_PATH} に登録されていないため実行できません。「再注入」で登録されます。`,
        error.detail,
      );
    }
    if (error.status === 409 && error.reason === 'harness-contract-missing') {
      return withDetail(
        `検証ループが未定義のため実行できません。${HARNESS_CONTRACT_PATH} に verify を宣言してください。`,
        error.detail,
      );
    }
    if (error.status === 409 && error.reason === 'harness-contract-invalid') {
      return withDetail(
        '検証コントラクトが不正なため実行できません。',
        error.detail,
      );
    }
    if (error.status === 409 && error.reason === 'worktree-branch-mismatch') {
      const actualBranch = extractWorktreeBranchMismatchBranch(error.errorMessage);
      const base =
        '対象の worktree が別のブランチにあるため実行できません。正しいブランチに切り替えてから再実行してください。';
      return actualBranch !== undefined
        ? `対象の worktree が別のブランチ（${actualBranch}）にあるため実行できません。正しいブランチに切り替えてから再実行してください。`
        : base;
    }
    // run 開始時の claim 失敗 (bdboard-pkr6.26 の排他ゲート、bdboard-ezs7)。
    // 'worktree-dirty' 等と同じく機械可読な `reason` で分岐する。多くは
    // 「別セッションが既にこのチケットを claim 中」のケース (一時的な
    // lock-contention は bdboard-miqg でサーバー側が数回リトライ済みなので、
    // ここまで 409 が届くのは大半が真の排他違反)。
    if (error.status === 409 && error.reason === 'claim-failed') {
      const assignee = extractClaimFailedAssignee(error.errorMessage);
      const base =
        assignee !== undefined
          ? `このチケットは既に ${assignee} が claim 済みのため実行できません。`
          : 'このチケットを claim できなかったため実行できません。';
      return `${base}進行中のセッションが無いか確認し、しばらく待ってから再実行してください。`;
    }
    if (error.status === 409 || error.status === 429) {
      switch (error.errorMessage) {
        case 'ticket is closed':
          return '完了済みのチケットは実行できません。';
        case 'ticket is blocked':
          return 'ブロック中のチケットは実行できません。';
        case 'ticket is deferred':
          return '保留中のチケットは実行できません。';
        case 'run already in progress':
          return 'このチケットは既に実行中です。';
        case 'too many concurrent runs':
          return '同時に実行できる上限に達しています。実行中のものが終わってからお試しください。';
        default:
          break;
      }
    }
  }
  return describeWriteError(error, 'エージェントの実行を開始できませんでした');
}
