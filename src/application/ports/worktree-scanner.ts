import type { GitWorktreeSnapshot } from '../../domain/git-worktree.js';

export interface HarnessLagMeasurement {
  readonly commitsBehind: number;
  /** 遅れの計測に実際に使えた既定ブランチ ref。 */
  readonly baseRef: string;
}

export interface WorktreeScanner {
  /** rootPath の git worktree / bd ブランチを読み取り専用で調べる。破壊的操作は行わない */
  scan(rootPath: string): Promise<GitWorktreeSnapshot>;
  /**
   * worktree が触っているファイル (merge-base 以降のコミット差分 + 未コミット差分 +
   * 未追跡ファイル) をリポジトリルート相対で返す。読み取り専用で、checkout / reset /
   * clean / stash のような書き込み系 git は一切実行しない。
   *
   * 取得できなかったときは **throw する**。呼び出し側 (scanInFlightOverlaps) が
   * その worktree だけ skip して警告ログを出す。
   */
  listChangedFiles(worktreePath: string): Promise<readonly string[]>;
  /**
   * その worktree の HEAD が既定ブランチから何コミット遅れているかと、計測に使った
   * ref を返す (`git rev-list --count HEAD..<ref>`)。`options.mainBranch` が安全なら
   * origin 側、ローカル側の順で優先し、それ以外は既定の候補順を試す。読み取り専用。
   *
   * 注入コピー (`.claude/skills/` と `.claude/settings.json`) はチェックアウト単位なので、
   * worktree が古いままだとそこで動くセッションのハーネスも古いまま凍る (bdboard-tdua)。
   * その遅れを測るために使う。取得できなかったときは **throw する**。
   *
   * **任意実装**。既定ブランチの ref を持たない環境 (ミラーの無いクローン、テストの
   * スタブ) では実装しなくてよく、その場合 `stale_harness_worktree` は一切出ない。
   * 「測れなかった」を「遅れていない」と取り違えないよう、呼び出し側は未実装と
   * 0 コミット遅れを区別すること。
   */
  countHarnessCommitsBehindDefaultBranch?(
    worktreePath: string,
    options?: { readonly mainBranch?: string },
  ): Promise<HarnessLagMeasurement>;
}
