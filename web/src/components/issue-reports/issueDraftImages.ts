import {
  ISSUE_DRAFT_IMAGE_MAX_BYTES,
  ISSUE_DRAFT_IMAGE_MAX_COUNT,
  ISSUE_DRAFT_IMAGE_MIME_TYPES,
  type IssueDraftImageMimeType,
} from './issueDraftImageLimits';

/**
 * 「新しく報告」の書く画面で、下書きに付ける画像を先に検査する純粋関数 (bdboard-4y8q.6.9)。
 * 上限と形式はサーバーの画像の受け口と同じ (issueDraftImageLimits.ts)。画面で先に断るのは、
 * 10 MiB 級の本文を送ってから 400 を返されるのを避けるため。正はサーバーの検査で、画面ではマジックバイト
 * (宣言した形式と中身が合うか) までは見ない。
 */

/** 利用者の画面に出す上限の言い方 (定数から作るので、上限を変えても文言が食い違わない)。 */
export const ISSUE_DRAFT_IMAGE_MAX_SIZE_LABEL = `${ISSUE_DRAFT_IMAGE_MAX_BYTES / (1024 * 1024)} MiB`;
export const ISSUE_DRAFT_IMAGE_FORMAT_LABEL = 'PNG・JPEG・WebP・GIF';

const UNNAMED_IMAGE_LABEL = '名称なしの画像';

/** File のうち検査に使う欄だけ。テストが File を作らずに値で渡せるようにしている。 */
export interface ImageFileLike {
  readonly name: string;
  readonly type: string;
  readonly size: number;
}

export function isIssueDraftImageMimeType(value: string): value is IssueDraftImageMimeType {
  return ISSUE_DRAFT_IMAGE_MIME_TYPES.some((mimeType) => mimeType === value);
}

/** ドラッグがファイルを運んでいるか (文字のドラッグは欄へふつうに入れるので、画像の処理では受けない)。 */
export function dragCarriesFiles(dataTransfer: Pick<DataTransfer, 'types'>): boolean {
  return Array.from(dataTransfer.types).includes('Files');
}

/** 貼り付けた文字を受ける input の type (file・checkbox・button などは文字を受けない)。 */
const TEXT_ENTRY_INPUT_TYPES: readonly string[] = ['text', 'search', 'url', 'tel', 'email', 'password', 'number'];

/** 貼り付け先が、文字を入れる欄 (textarea と、文字を受ける input) か。フォームの余白・ボタン・ファイル選択は含まない。 */
export function isTextEntryField(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement) return true;
  return target instanceof HTMLInputElement && TEXT_ENTRY_INPUT_TYPES.includes(target.type);
}

/**
 * クリップボードが文字を運んでいるか (bdboard-8zwi)。Excel・Word は文字 (text/plain) と HTML と画像を一度に載せるので、
 * 文字の欄へ貼るときは画像でなく文字を入れる。判定は types に text/plain があり、中身が空白だけでないこと。
 * text/html だけでは文字とは見なさない: Chrome の「画像をコピー」は <img> だけの HTML と画像を載せ、文字は無い。
 */
export function clipboardCarriesText(clipboardData: Pick<DataTransfer, 'types' | 'getData'>): boolean {
  return Array.from(clipboardData.types).includes('text/plain') && clipboardData.getData('text/plain').trim() !== '';
}

/**
 * 上限を超えた画像の大きさ (MiB、小数第 1 位)。四捨五入 (formatImageSize) ではなく切り上げる: 上限に 1 バイト足りないほど
 * 超えただけでも「10 MiB を超えている (10.0 MiB)」と、上限と同じ数字になってしまうため (bdboard-8zwi)。
 */
function formatOverLimitSize(bytes: number): string {
  const mebibytes = bytes / (1024 * 1024);
  return `${(Math.ceil(mebibytes * 10) / 10).toFixed(1)} MiB`;
}

function displayName(name: string): string {
  return name === '' ? UNNAMED_IMAGE_LABEL : name;
}

export interface ImageScreening<T extends ImageFileLike> {
  /** 付けてよい画像 (入力の順)。 */
  readonly accepted: T[];
  /** 断った理由 (利用者に出す文)。形式・空・大きさは 1 枚ずつ、枚数の超過は 1 件にまとめる。 */
  readonly problems: string[];
}

/**
 * 追加しようとする画像を、入力の順に 1 枚ずつ検査する。形式・空・大きさで断ったものだけを外し、残りは付ける。
 * 枚数は、すでに付いている枚数 (existingCount) と合わせて上限に達したところで打ち切り、超えた分の名前は 1 件の理由にまとめる
 * (20 枚貼って 10 枚が溢れても、10 件のアラートを並べない)。
 */
export function screenIssueDraftImages<T extends ImageFileLike>(
  existingCount: number,
  incoming: readonly T[],
): ImageScreening<T> {
  const accepted: T[] = [];
  const problems: string[] = [];
  const overLimitNames: string[] = [];
  for (const file of incoming) {
    const name = displayName(file.name);
    if (!isIssueDraftImageMimeType(file.type)) {
      problems.push(`「${name}」は付けられません。付けられる形式は ${ISSUE_DRAFT_IMAGE_FORMAT_LABEL} です。`);
    } else if (file.size === 0) {
      problems.push(`「${name}」は中身が空のため付けられません。`);
    } else if (file.size > ISSUE_DRAFT_IMAGE_MAX_BYTES) {
      problems.push(
        `「${name}」は ${ISSUE_DRAFT_IMAGE_MAX_SIZE_LABEL} を超えているため付けられません (${formatOverLimitSize(file.size)})。`,
      );
    } else if (existingCount + accepted.length < ISSUE_DRAFT_IMAGE_MAX_COUNT) {
      accepted.push(file);
    } else {
      overLimitNames.push(name);
    }
  }
  if (overLimitNames.length > 0) {
    const names = overLimitNames.map((name) => `「${name}」`).join('');
    problems.push(`画像は ${ISSUE_DRAFT_IMAGE_MAX_COUNT} 枚までです。次の画像は付けませんでした: ${names}`);
  }
  return { accepted, problems };
}

/**
 * 画像の受け口へ送る本文。`readFileAsDataUrl` が返す data URL (`data:image/png;base64,...`) の、最初のカンマより後ろ
 * (base64 だけ。サーバーは前置きを付けると 400 にする) を `data` にする。
 */
export function imageUploadPayload(
  file: ImageFileLike,
  dataUrl: string,
): { mimeType: IssueDraftImageMimeType; data: string } {
  if (!isIssueDraftImageMimeType(file.type)) {
    throw new Error('付けられる形式の画像ではありません。');
  }
  const commaIndex = dataUrl.indexOf(',');
  if (commaIndex < 0) {
    throw new Error('画像を送信形式に変換できませんでした。');
  }
  return { mimeType: file.type, data: dataUrl.slice(commaIndex + 1) };
}
