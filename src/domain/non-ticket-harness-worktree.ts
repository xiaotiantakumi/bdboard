import { compareStrings } from './compare.js';
import { STALE_HARNESS_WORKTREE_MIN_COMMITS_BEHIND } from './hygiene.js';

/**
 * `bd/<id>` に紐づかない worktree (feature/* 等) のハーネス遅れ計測結果。1 worktree ぶん。
 *
 * **この一覧に載っていない worktree は「遅れていない」ではなく「測っていない / 測れ
 * なかった」**(HarnessWorktreeLag と同じ注意。scanNonTicketHarnessWorktreeLags のコメント
 * 参照)。
 */
export interface NonTicketHarnessWorktreeLag {
  readonly projectId: string;
  readonly worktreePath: string;
  readonly branchName: string;
  /** `git rev-list --count HEAD..<既定ブランチ>` の値 (harness 関連パスのみ) */
  readonly commitsBehind: number;
  /** 遅れの計測に実際に使えた既定ブランチ ref。 */
  readonly baseRef: string;
}

/**
 * 非チケット worktree のハーネス凍結警告。**`HygieneIssue` ではない** —
 * `HygieneIssue.ticketId` は必須で、チケットに紐づかないこれらの worktree はその形に
 * 乗せられない (bdboard-wadg。検討経緯は bdboard-tdua のレビュー major-1)。
 *
 * チケット単位の一覧・詳細パネルには載らず、盤面には別レーンとして表示する
 * (`/api/hygiene` レスポンスの `nonTicketHarnessWorktrees`)。cleanup は付けない —
 * `checkStaleHarnessWorktree` (hygiene.ts) と同じ理由で、rebase は掃除ではなく、
 * 未コミットの成果を抱えた worktree に対してワンクリック相当のコマンドを出すのは危険。
 */
export interface NonTicketHarnessWorktreeWarning {
  readonly projectId: string;
  readonly worktreePath: string;
  readonly branchName: string;
  readonly commitsBehind: number;
  readonly baseRef: string;
  readonly message: string;
}

/**
 * 遅れの閾値は hygiene.ts の `STALE_HARNESS_WORKTREE_MIN_COMMITS_BEHIND` を共有する
 * (チケット worktree と非チケット worktree で「凍っている」の基準をずらす理由が無い)。
 */
export function checkNonTicketHarnessWorktrees(
  lags: readonly NonTicketHarnessWorktreeLag[],
): readonly NonTicketHarnessWorktreeWarning[] {
  const warnings: NonTicketHarnessWorktreeWarning[] = [];

  for (const lag of lags) {
    if (lag.commitsBehind < STALE_HARNESS_WORKTREE_MIN_COMMITS_BEHIND) {
      continue;
    }

    warnings.push({
      projectId: lag.projectId,
      worktreePath: lag.worktreePath,
      branchName: lag.branchName,
      commitsBehind: lag.commitsBehind,
      baseRef: lag.baseRef,
      message:
        `この worktree (ブランチ ${lag.branchName}) のハーネスは ${lag.baseRef} より ` +
        `${lag.commitsBehind} コミットぶん古いままです。チケットに紐づかない worktree の` +
        'ため盤面のチケット一覧には出ません。ハーネス (.claude/skills と ' +
        '.claude/settings.json) はチェックアウト単位なので、ここでまだセッションが動いて' +
        'いるならその作成時点の古い規律・hooks のまま動作しています(このレーンは生存確認を' +
        `していません ― まだ使うなら git -C ${lag.worktreePath} rebase ${lag.baseRef} で` +
        '追従、使っていないなら worktree ごと削除してください)',
    });
  }

  return [...warnings].sort((a, b) => {
    const projectDiff = compareStrings(a.projectId, b.projectId);
    return projectDiff !== 0 ? projectDiff : compareStrings(a.worktreePath, b.worktreePath);
  });
}
