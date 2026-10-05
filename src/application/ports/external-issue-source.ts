/**
 * 公開リポジトリの open issue (他の人が出したもの) と、bdboard 自身の bd の external_ref を
 * 読むポート (bdboard-4y8q.9.2)。どちらも読み取りだけ。
 */

/** GitHub の open issue (PR を除く) 1 件。title / body は第三者が書いた文章。 */
export interface ExternalIssue {
  readonly number: number;
  readonly title: string;
  /**
   * gh の jq で先頭 20,001 文字に切った本文。20,000 文字への切り詰めと「省略」の印は
   * 後段の純粋関数が行う。
   */
  readonly body: string;
  /** 切る前の本文の文字数。 */
  readonly bodyLength: number;
  readonly updatedAt: string;
  /** 削除済みユーザーなどで取れないときは null。 */
  readonly author: string | null;
  readonly authorAssociation: string | null;
  /** 検査済みの slug と番号から組む `https://github.com/<slug>/issues/<N>`。gh の html_url は使わない。 */
  readonly url: string;
}

export type ExternalIssueFailureKind =
  /** gh が起動できない (未インストール・パスが違う)。 */
  | 'gh-missing'
  /** gh が未ログイン・認証切れ。 */
  | 'gh-unauthenticated'
  | 'rate-limited'
  /** 時間切れ・想定外の出力・その他。 */
  | 'failed';

export type ExternalIssueListResult =
  | {
      readonly ok: true;
      readonly issues: readonly ExternalIssue[];
      readonly pagesFetched: number;
      /** 最大ページ数まで読んでも、まだ続きがありうる (100 件ちょうどで打ち切った)。 */
      readonly truncatedByPageLimit: boolean;
      /** 読めずに捨てた行の数。 */
      readonly skippedLines: number;
    }
  | {
      readonly ok: false;
      readonly kind: ExternalIssueFailureKind;
      /** 画面に出しうる短い説明 (制御文字なし、300 文字まで)。 */
      readonly detail: string;
    };

export interface ExternalIssueSourcePort {
  /**
   * open issue を読む。gh 未インストール・未ログイン・レート制限・時間切れ・想定外の出力の
   * どれでも例外を投げず `{ ok: false }` を返す (認証無しの経路には落ちない)。例外は、
   * 読み取り専用の引数の表明に違反したとき (このコードのバグ) だけ。1 ページでも読めなければ
   * 途中までの結果は返さず `{ ok: false }` にする。
   */
  listOpenIssues(): Promise<ExternalIssueListResult>;
}

export interface BdExternalRefReaderPort {
  /**
   * 指定プロジェクトの bd の全チケット (closed を含む) の `external_ref` を返す。
   * 失敗は `BdError` を投げる (lease-reader と同じ)。
   */
  listExternalRefs(projectRootPath: string): Promise<readonly string[]>;
}
