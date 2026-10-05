import type { StoredExternalIssueSnapshot } from '../../domain/external-issue-snapshot-record.js';

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
   * 読める写しの全件。中身が使えない (JSON でない・形が合わない・番号がファイル名と食い違う) ファイルは、警告を出して
   * 飛ばす (1 件の破損で全体を落とさない。その番号は `listUnusable` で分かり、次の保存で書き直される)。読み取りの I/O の
   * 失敗 (権限・EIO など。ファイルが無いのは失敗ではない) は投げる: 読めない写しを「無い」と見て、判定時点の写しを
   * 新しい内容で書き換えてしまわないため。
   */
  list(): Promise<readonly StoredExternalIssueSnapshot[]>;
  /**
   * ファイルはあるが使えない (JSON でない・形が合わない・番号がファイル名と食い違う・ディレクトリ) 写しの番号。昇順。
   * `list` が飛ばしたものと同じ。サービスが「初めて見た issue」(ファイルが無い) と区別して、作り直す写しに再判定の印を立てるために使う。
   * ファイルが無いのは含めない。読み取りの I/O の失敗は `list` と同じく投げる。
   */
  listUnusable(): Promise<readonly number[]>;
  /** 1 件取得。無い・使えないときは undefined (使えないときは警告)。I/O の失敗は投げる。 */
  get(number: number): Promise<StoredExternalIssueSnapshot | undefined>;
  /** 新規作成または上書き。原子的に書く。失敗したら一時ファイルを残さず投げる。 */
  save(snapshot: StoredExternalIssueSnapshot): Promise<void>;
  /** 消す。無ければ何もしない。 */
  remove(number: number): Promise<void>;
}
