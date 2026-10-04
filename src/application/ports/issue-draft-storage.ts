import type { IssueDraft } from '../../domain/issue-draft.js';

/**
 * 不具合報告の下書き (bdboard-4y8q.1) の保存先ポート。実装は infrastructure/fs 配下の
 * ファイルシステム版 (`<基点>/issue-drafts/<id>/draft.json` と `images/`) のみを想定する。
 * キャッシュ DB (~/.bdboard/cache.db) には置かない (エピック決定 5)。
 *
 * id は呼び出し側 (application) が domain の isDraftId で検証済みの値を渡す前提。実装側も
 * パス閉じ込めを再確認する (defense in depth。添付画像の AttachmentStoragePort と同じ流儀)。
 */
export interface StoredDraftImage {
  /** サーバーが採番した安全なファイル名 (例: "1758300000000-a1b2c3d4e5f6a7b8.png")。 */
  readonly fileName: string;
  readonly byteLength: number;
  readonly createdAt: Date;
}

export interface IssueDraftStoragePort {
  /**
   * 全下書き。読めない・壊れている下書き (権限、ディレクトリでないもの、不正な JSON など) は
   * 警告を出して読み飛ばす (1件の破損で一覧や受け取り全体を落とさない)。
   */
  list(): Promise<readonly IssueDraft[]>;
  /** 1件取得。存在しない・読めない・壊れているときは undefined (読めない・壊れているときは警告)。 */
  get(id: string): Promise<IssueDraft | undefined>;
  /** 新規作成または上書き。途中状態を読ませないよう原子的に書く。 */
  save(draft: IssueDraft): Promise<void>;
  /** 下書きに付いている画像の枚数。上限チェックに使う。 */
  countImages(id: string): Promise<number>;
  /** 検証済みのバイト列を保存し、サーバー採番のファイル名を返す。 */
  saveImage(id: string, extension: string, data: Uint8Array): Promise<StoredDraftImage>;
  /** 画像の一覧 (作成日時昇順)。 */
  listImages(id: string): Promise<readonly StoredDraftImage[]>;
  /** 画像本体。存在しなければ undefined。 */
  readImage(id: string, fileName: string): Promise<Buffer | undefined>;
}
