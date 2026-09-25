import { compareStrings } from './compare.js';
import type { NonTicketWorktree } from './git-worktree.js';
import { isPathInside } from './harness-path.js';
import { STALE_HARNESS_WORKTREE_MIN_COMMITS_BEHIND } from './hygiene.js';
import type { AgentSession } from './session.js';

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
  /**
   * baseRef と HEAD に共通の祖先があるか。false なら rebase では追いつけない
   * (bdboard-0chq)。
   */
  readonly hasCommonAncestor: boolean;
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

    const message = lag.hasCommonAncestor
      ? `この worktree (ブランチ ${lag.branchName}) のハーネスは ${lag.baseRef} より ` +
        `${lag.commitsBehind} コミットぶん古いままです。チケットに紐づかない worktree の` +
        'ため盤面のチケット一覧には出ません。ハーネス (.claude/skills と ' +
        '.claude/settings.json) はチェックアウト単位なので、生存セッションが cwd をここに' +
        '置いたまま動いているとその作成時点の古い規律・hooks のまま動作しています' +
        '(このレーンは生存セッションのある worktree だけを対象にしています ― まだ使うなら ' +
        `git -C ${lag.worktreePath} rebase ${lag.baseRef} で追従、使い終わったなら worktree ` +
        'ごと削除してください)'
      : `この worktree (ブランチ ${lag.branchName}) は ${lag.baseRef} と共通の祖先が` +
        'ありません (履歴の作り直しより前に作られた checkout)。チケットに紐づかない' +
        'worktree のため盤面のチケット一覧には出ません。ハーネス (.claude/skills と ' +
        '.claude/settings.json) はチェックアウト単位なので、生存セッションが cwd をここに' +
        '置いたまま動いているとその作成時点の古い規律・hooks のまま動作しています' +
        '(このレーンは生存セッションのある worktree だけを対象にしています ― rebase では' +
        '追いつけないので、まだ使うなら中身を確認してから手で整理し、使い終わったなら' +
        ` worktree ごと削除してください。git -C ${lag.worktreePath} の内容を確認してから` +
        '判断してください)';

    warnings.push({
      projectId: lag.projectId,
      worktreePath: lag.worktreePath,
      branchName: lag.branchName,
      commitsBehind: lag.commitsBehind,
      baseRef: lag.baseRef,
      message,
    });
  }

  return [...warnings].sort((a, b) => {
    const projectDiff = compareStrings(a.projectId, b.projectId);
    return projectDiff !== 0 ? projectDiff : compareStrings(a.worktreePath, b.worktreePath);
  });
}

/**
 * 生存セッション (alive かつ cwd がその worktree の内側) が無い non-ticket worktree を
 * 除外する (bdboard-cjsa)。ticket 紐づきの worktree は `ticket.status === 'in_progress'`
 * で「まだ使われている」を判定しているが (routes.ts の `isMeasured`)、非チケット worktree
 * にはチケットが無いためその代わりにこれを使う。
 *
 * 実測 (bdboard-wadg の Opus レビュー時点, 2026-09-20): しきい値超過の非チケット worktree
 * の大半が、直近数週間コミットの無い放棄済みのものだった。放棄された worktree に対して
 * `checkNonTicketHarnessWorktrees` の「まだ使うなら rebase、使っていないなら削除」という
 * 文言は的外れ (誰も使っていない = 削除一択) で、生存セッションのゲートが無いと放置
 * worktree が増えるほど警告が積み上がり続け、盤面上でアクション不能なノイズになる。
 *
 * 除外は「遅れていない」ではなく「もう測る価値が無い」の意味 ― `scanNonTicketHarnessWorktreeLags`
 * を呼ぶ前にここで絞ることで、生存確認できない worktree ぶんの git 呼び出しも増やさない。
 *
 * **既知の限界 (bdboard-cjsa の Opus レビュー指摘):**
 * - `isPathInside` は文字列比較 (`path.resolve` ベース) で、symlink を解決しない
 *   (`harness-path.ts` の既存の前提と同じ ― 呼び出し側が realpath 済みの絶対パスを渡す
 *   前提)。`worktreePath` / `session.cwd` のどちらかだけが realpath 形
 *   (`git-worktree-provisioner.ts` が worktree パスに `fs.realpathSync.native` を使う
 *   のと同じ理由で起こりうる) だと、実際は同じ場所でも不一致と判定し偽陰性 (誤って
 *   「放棄済み」扱い) になりうる。resolve は呼び出し側 (scanner / セッション収集側) の
 *   責務とし、ここでは行わない。
 * - 「生存セッションが無い」は `deps.sessions()` が追跡できる Claude Code セッションの
 *   範囲でしか判定できない。その worktree で Codex/Cursor 等の別ツールが動いている、
 *   または `isolation: "worktree"` のサブエージェントが親セッションと別の cwd 追跡経路を
 *   持つ、といったケースは検知できず、偽陰性 (実際は使用中なのに「放棄済み」扱い) になりうる。
 *   このレーンは「確実に放棄されたもの」だけを削れば十分という前提に立っており、この
 *   偽陰性は許容している (偽陽性 ― 使っていないのに警告し続ける ― の防止が本題のため)。
 */
export function filterNonTicketWorktreesWithLiveSession(
  worktrees: readonly NonTicketWorktree[],
  sessions: readonly AgentSession[],
): readonly NonTicketWorktree[] {
  const aliveCwds = sessions.filter((session) => session.alive).map((session) => session.cwd);
  if (aliveCwds.length === 0) {
    return [];
  }

  return worktrees.filter((worktree) =>
    aliveCwds.some((cwd) => isPathInside(worktree.worktreePath, cwd)),
  );
}
