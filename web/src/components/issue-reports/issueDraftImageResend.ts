import { fetchIssueDraft, fetchIssueDraftImageBytes } from '../../api/issue-reports';
import type { PickedImage } from './issueDraftImageUpload';

/**
 * 画像の再送で同じ画像が二重に付かないようにする (bdboard-8zwi)。
 *
 * 送ったのに応答が届かなかった画像 (ImageUploadFailure.mayBeStored) は、サーバーに保存できているかもしれない。そのまま送り直すと
 * 同じ画像が 2 枚付く。そこで再送の前に下書きの画像の一覧を取り直し、もう付いているものは送らない。
 * サーバーは画像の元の名前も内容のハッシュも持たない (file 名は生成、一覧にあるのは大きさと時刻だけ) ので、見比べは次の順:
 *   1. 一覧にあって、こちらが「保存できた」と確かめていない画像 (knownFileNames に無いもの) だけを相手にする。
 *   2. 大きさ (バイト数) が同じものを候補にし、中身を取って 1 バイトずつ見比べる。大きさだけでは別の画像を同じものと見てしまい、
 *      その画像を黙って落とすことになるので、中身まで見る。
 *   3. 一致したサーバー側の 1 枚は、1 枚の画像にしか割り当てない (同じ画像を 2 回付けたい人の 2 枚目を落とさない)。
 * 一覧も中身も取れなかったときは「付いていない」とみなして送る (二重に付く可能性は残るが、画像が付かないよりよい)。
 * 冪等キーをサーバーに足す案もあるが、画面だけで足りるのでサーバーは変えない (docs/ISSUE-REPORTING.md)。
 */

/** File の中身 (送るときの readFileAsDataUrl と同じく FileReader で読む)。 */
function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      // readAsArrayBuffer の結果は ArrayBuffer か null。instanceof は realm をまたぐ (jsdom) と外れるので、文字列でないことで見る。
      if (reader.result !== null && typeof reader.result !== 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('画像を読み込めませんでした。'));
      }
    });
    reader.addEventListener('error', () => reject(reader.error ?? new Error('画像を読み込めませんでした。')));
    reader.readAsArrayBuffer(file);
  });
}

function sameBytes(left: ArrayBuffer, right: ArrayBuffer): boolean {
  if (left.byteLength !== right.byteLength) return false;
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  return a.every((value, index) => value === b[index]);
}

/** サーバーの画像 (url) が、この File と同じ中身か。取れなかったときは false。 */
async function hasSameContents(file: File, url: string): Promise<boolean> {
  try {
    const [remote, local] = await Promise.all([fetchIssueDraftImageBytes(url), readFileAsArrayBuffer(file)]);
    return sameBytes(remote, local);
  } catch {
    return false;
  }
}

/**
 * `candidates` のうち、サーバーにもう付いている画像を探す。返り値は、画像の id から、見つかったサーバー側の file 名への対応。
 * `knownFileNames` は、この画面が「保存できた」と応答で確かめたサーバー側の file 名 (それらは候補の相手にしない)。
 */
export async function findImagesAlreadyStored(
  draftId: string,
  candidates: readonly PickedImage[],
  knownFileNames: ReadonlySet<string>,
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (candidates.length === 0) return found;
  let detail: Awaited<ReturnType<typeof fetchIssueDraft>>;
  try {
    detail = await fetchIssueDraft(draftId);
  } catch {
    return found;
  }
  const unclaimed = (detail.images ?? []).filter((image) => !knownFileNames.has(image.fileName));
  for (const candidate of candidates) {
    const sameSize = unclaimed.filter((image) => image.byteLength === candidate.file.size);
    for (const serverImage of sameSize) {
      if (await hasSameContents(candidate.file, serverImage.url)) {
        found.set(candidate.id, serverImage.fileName);
        unclaimed.splice(unclaimed.indexOf(serverImage), 1);
        break;
      }
    }
  }
  return found;
}
