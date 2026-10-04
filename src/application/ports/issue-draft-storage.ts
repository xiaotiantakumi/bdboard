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

export interface DraftListing {
  readonly drafts: readonly IssueDraft[];
  /**
   * false: 一覧が欠けているかもしれない。未列挙の理由 (EIO など、あとで読めるかもしれないもの) で
   * 読めず飛ばした下書きがある。呼び出し側はこの一覧から作ったものをキャッシュしない (次の呼び出しで
   * 読み直す)。恒久的な理由 (権限、ディレクトリでないもの、壊れた JSON など) で飛ばしただけなら true。
   */
  readonly complete: boolean;
}

export interface IssueDraftStoragePort {
  /** list() と同じ一覧に、欠けていないかどうかを添える。受け取りの索引づくり用 (bdboard-r50m)。 */
  scan(): Promise<DraftListing>;
  /**
   * 全下書き。読めない・壊れている下書き (権限、ディレクトリでないもの、不正な JSON、形や時刻の
   * 不正、EIO のような未列挙のエラーなど) は警告を出して読み飛ばす (1件の破損で一覧や受け取り全体を
   * 落とさない)。EMFILE のような一時的なエラーは実装が回数上限つきで再試行し、使い切ったときだけ
   * 投げる。未列挙のエラーで飛ばした一覧は scan() が complete: false で知らせる。
   */
  list(): Promise<readonly IssueDraft[]>;
  /** 1件取得。存在しない・読めない・壊れているときは undefined (読めない・壊れているときは警告)。 */
  get(id: string): Promise<IssueDraft | undefined>;
  /**
   * 新規作成または上書き。途中状態を読ませないよう原子的に書く。draft.json が 200KB
   * (ISSUE_DRAFT_MAX_JSON_BYTES) を超える下書きは、何も書かずに投げる (縮められる欄は呼び出し側が
   * fitDraftToByteLimit で先に縮める。題名・本文など固定の欄の長さは入口で抑える)。
   */
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
