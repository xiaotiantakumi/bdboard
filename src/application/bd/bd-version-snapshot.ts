/** 版が読めない・まだ読み終わっていないときの値。下書きの他の版 (bdboard・OS・Node) の欠けと同じ語にしてある。 */
export const BD_VERSION_UNKNOWN = 'unknown';

/** 今分かっている bd の版 (同期で引ける。読めていなければ BD_VERSION_UNKNOWN)。 */
export type BdVersionSource = () => string;

/**
 * 起動時に 1 回読んだ bd の版 (bdboard-424g) を、同期で引ける形で持つ。
 *
 * - 下書きの envInfo の元 (`serverEnvInfo`) は同期の関数なので、Promise を渡すのでなく「読めていればその版、まだなら 'unknown'」を返す getter にする。
 *   async にすると IssueDraftService / SelfErrorReporter の型が変わる。
 * - 起動を待たせない: `read` は呼び出し側が await しない (これは内部の then だけ)。
 * - `bd version` を追加で起動しない: 渡された 1 回分の Promise を共有するだけ。
 * - 読み終わる前に作られた下書きの 'unknown' は、同じ下書きが再発したときに最後の発生の envInfo で置き換わる。
 *
 * `read` が null・空文字・reject でも投げず、'unknown' のまま。
 */
export function createBdVersionSnapshot(read: Promise<string | null>): BdVersionSource {
  let version = BD_VERSION_UNKNOWN;
  void read.then(
    (value) => {
      const trimmed = value?.trim();
      if (trimmed !== undefined && trimmed !== '') version = trimmed;
    },
    // 読めなかった (reject) ときは 'unknown' のまま。未処理の rejection にしないためにここで握る。
    () => undefined,
  );
  return () => version;
}
