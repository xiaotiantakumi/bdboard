import type { StoredExternalIssueSnapshot } from '../../domain/external-issue-snapshot-record.js';

/** `scan` の結果。1 回の走査で分けた、読める写しと使えない番号。 */
export interface ExternalIssueSnapshotScan {
  /** 読める写しの全件。番号の昇順。 */
  readonly snapshots: readonly StoredExternalIssueSnapshot[];
  /**
   * ファイルはあるが使えない (JSON でない・形が合わない・番号がファイル名と食い違う・ディレクトリ) 写しの番号。昇順。
   * サービスが「初めて見た issue」(ファイルが無い) と区別して、作り直す写しに再判定の印を立てるために使う。
   */
  readonly unusable: readonly number[];
}

/**
 * 届いた issue の「判定時点の写し」の保存先ポート (bdboard-4y8q.9.3)。実装は infrastructure/fs 配下の
 * ファイルシステム版 (`<基点>/external-issues/<number>.json`) のみを想定する。キャッシュ DB には置かない。
 *
 * 写しには第三者が書いた文章が入るので、ディレクトリは 0700・ファイルは 0600 で作り、一時ファイルへ書いてから
 * rename で置く (途中まで書いたファイルを読ませない)。number は `^[1-9][0-9]{0,9}$` の形だけを受け付け、
 * 外れた値は読み取りの失敗ではなくプログラムの誤りなので投げる。
 */
export interface ExternalIssueSnapshotStoragePort {
  /**
   * 1 回の走査で、読める写しと使えない番号を分けて返す。使えない (JSON でない・形が合わない・番号がファイル名と食い違う・
   * ディレクトリ) ファイルは警告して飛ばす (1 件の破損で全体を落とさない)。次の保存で書き直せるよう番号も返す。同じ番号が
   * `snapshots` と `unusable` の両方に出ることは無い。走査の途中で消えたファイルはどちらにも出ない (無いのと同じ)。
   * 読み取りの I/O の失敗 (権限・EIO など。ファイルが無いのは失敗ではない) は投げる: 読めない写しを「無い」と見て、
   * 判定時点の写しを新しい内容で書き換えてしまわないため。
   */
  scan(): Promise<ExternalIssueSnapshotScan>;
  /** 1 件取得。無い・使えないときは undefined (使えないときは警告)。I/O の失敗は投げる。 */
  get(number: number): Promise<StoredExternalIssueSnapshot | undefined>;
  /** 新規作成または上書き。原子的に書く。失敗したら一時ファイルを残さず投げる。 */
  save(snapshot: StoredExternalIssueSnapshot): Promise<void>;
  /** 消す。無ければ何もしない。 */
  remove(number: number): Promise<void>;
}
