import { isSingleLineText } from '../../domain/issue-draft-identifier.js';

/** 版が読めない・まだ読み終わっていないときの値。下書きの他の版 (bdboard・OS・Node) の欠けと同じ語にしてある。 */
export const BD_VERSION_UNKNOWN = 'unknown';

/**
 * 受け入れる版の長さの上限 (UTF-16 コード単位)。HTTP の受け取りの envInfo (issue-report-routes.ts の versionString) と同じ。
 * draft.json の余白の見積もり (issue-draft-edit.ts の ISSUE_DRAFT_EDIT_HEADROOM_BYTES) は envInfo の各欄が 100 文字までを前提にしている。
 */
export const BD_VERSION_MAX_CHARS = 100;

/** 今分かっている bd の版 (同期で引ける。読めていなければ BD_VERSION_UNKNOWN)。 */
export type BdVersionSource = () => string;

/**
 * 起動時に 1 回読んだ bd の版 (bdboard-424g) を、同期で引ける形で持つ。
 *
 * - 下書きの envInfo の元 (`serverEnvInfo`) は同期の関数なので、Promise を渡すのでなく「読めていればその版、まだなら 'unknown'」を返す getter にする。
 *   async にすると IssueDraftService / SelfErrorReporter の型が変わる。
 * - 起動を待たせない: `read` は呼び出し側が await しない (これは内部の then だけ)。
 * - `bd version` を追加で起動しない: 渡された 1 回分の Promise を共有するだけ。起動後に bd を入れ替えても、版は再起動まで起動時のまま。
 * - 読み終わる前に作られた下書きの 'unknown' は、同じ pending の下書きが再発したときに最後の発生の envInfo で置き換わる (「大量発生」の下書きは置き換わらない)。
 * - 版は外のコマンドの出力なので、HTTP の受け取りと同じく 1 行・100 文字までのものだけ受け、ほかは 'unknown' にする
 *   (サーバーが埋める envInfo は入口の schema を通らず、暫定の本文の `- bd: …` の行にそのまま入るため)。
 *
 * `read` が null・空文字・reject でも投げず、'unknown' のまま。
 */
export function createBdVersionSnapshot(read: Promise<string | null>): BdVersionSource {
  let version = BD_VERSION_UNKNOWN;
  void read.then(
    (value) => {
      const trimmed = value?.trim();
      if (trimmed !== undefined && trimmed !== '' && trimmed.length <= BD_VERSION_MAX_CHARS && isSingleLineText(trimmed)) {
        version = trimmed;
      }
    },
    // 読めなかった (reject) ときは 'unknown' のまま。未処理の rejection にしないためにここで握る。
    () => undefined,
  );
  return () => version;
}
