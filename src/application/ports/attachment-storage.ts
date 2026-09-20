/**
 * チケット添付画像 (bdboard-qw26) の保存先ポート。実装は infrastructure/fs 配下の
 * ファイルシステム版のみを想定しているが、interface 層からは抽象越しにしか触らせない
 * (onion architecture: interface -> infrastructure の直接依存を禁止する
 * dependency-cruiser ルールに合わせる)。
 *
 * projectKey / issueId / fileName はすべて呼び出し側 (interface 層) が
 * isSafePathSegment 等で検証済みの値を渡す前提。実装側もパス閉じ込め
 * (resolve 後に base dir 配下か再確認) を行う想定 (defense in depth)。
 */
export interface StoredAttachment {
  /** サーバーが採番した安全なファイル名 (例: "1758300000000-a1b2c3d4e5f6a7b8.png")。 */
  readonly fileName: string;
  readonly byteLength: number;
  readonly createdAt: Date;
}

export interface AttachmentStoragePort {
  /** 指定 issue の現在の添付枚数。上限チェックに使う。 */
  count(projectKey: string, issueId: string): Promise<number>;
  /** 検証済みのバイト列を保存し、サーバー採番のファイル名を返す。 */
  save(
    projectKey: string,
    issueId: string,
    extension: string,
    data: Uint8Array,
  ): Promise<StoredAttachment>;
  /** 保存済み添付の一覧 (作成日時昇順)。 */
  list(projectKey: string, issueId: string): Promise<readonly StoredAttachment[]>;
  /** 本体を読む。存在しなければ undefined。 */
  read(
    projectKey: string,
    issueId: string,
    fileName: string,
  ): Promise<Buffer | undefined>;
}
