import fs from 'node:fs/promises';

/**
 * draft.json を読むときの errno の扱い (bdboard-r50m)。fs-issue-draft-storage.ts から切り出した。
 *
 * エラーを 4 つに分ける:
 * - プロセス全体 (process-wide): EMFILE・ENFILE・EAGAIN。ファイルを開きすぎ・資源の一時的な不足で、どの下書きを
 *   読んでも起きる。短い待ちを挟んで回数上限つきで再試行し、使い切ったら元のエラーを投げる。1 件ずつ飛ばすと
 *   一覧のほとんどが空になるので、飛ばさない。
 * - ファイル単位 (per-file): EBUSY と、win32 だけの EPERM・EACCES。そのファイルを他のプロセス (同期クライアント・
 *   アンチウイルス) が握っている間だけ起きる。同じように再試行し、使い切ったら**その 1 件だけ**を警告つきで飛ばして
 *   「一覧が欠けた」印 (incomplete) を付ける。投げると、握られたままの 1 件のせいで一覧も受け取りも 500 になり、
 *   クライアントは再送しない (docs/ISSUE-REPORTING.md 9節) ので報告が失われる。
 * - 恒久 (permanent): その場では直らない (種類が違う・非 win32 で読む権限が無い)。再試行せず警告つきで飛ばす。
 * - 未列挙 (unlisted): 上のどれでもない (EIO・ELOOP・ERR_FS_FILE_TOO_LARGE・code の無いエラーなど)。再試行せず
 *   その 1 件を警告つきで飛ばす。直るかもしれないので incomplete を付け、受け取りの索引 (issue-draft-service) に
 *   キャッシュさせない。
 */

/** 再試行の前の待ち (ms)。長さ = 再試行の回数 (最初の 1 回と合わせて 4 回試す)。合計 140ms。 */
export const DRAFT_READ_RETRY_DELAYS_MS: readonly number[] = [20, 40, 80];

const PROCESS_WIDE_CODES: ReadonlySet<string> = new Set(['EMFILE', 'ENFILE', 'EAGAIN']);
const PER_FILE_CODES: ReadonlySet<string> = new Set(['EBUSY']);
/** Windows ではアンチウイルスのスキャンや削除待ちで一時的に出ることが多い。それ以外の OS では権限そのもの (恒久)。 */
const PER_FILE_ON_WIN32_CODES: ReadonlySet<string> = new Set(['EPERM', 'EACCES']);
const PERMANENT_CODES: ReadonlySet<string> = new Set(['ENOTDIR', 'EISDIR', 'EPERM', 'EACCES']);

export type ReadErrorClass = 'process-wide' | 'per-file' | 'permanent' | 'unlisted';

export function classifyReadError(code: string | undefined, platform: NodeJS.Platform): ReadErrorClass {
  if (code === undefined) return 'unlisted';
  if (PROCESS_WIDE_CODES.has(code)) return 'process-wide';
  if (PER_FILE_CODES.has(code)) return 'per-file';
  if (platform === 'win32' && PER_FILE_ON_WIN32_CODES.has(code)) return 'per-file';
  if (PERMANENT_CODES.has(code)) return 'permanent';
  return 'unlisted';
}

export type RawDraftRead =
  | { readonly kind: 'ok'; readonly raw: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unusable'; readonly reason: string; readonly incomplete: boolean };

export interface DraftFileReaderOptions {
  readonly platform: NodeJS.Platform;
  readonly delaysMs: readonly number[];
  readonly sleep: (ms: number) => Promise<void>;
}

export function sleepForMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 存在しない (missing)・あるが読めない (unusable)・読めた (ok) を返す。プロセス全体のエラーを使い切ったときだけ
 * 投げる (元のエラーをそのまま)。unusable の reason は警告に出るので、エラーの message やパスは入れず code だけにする。
 */
export function createDraftFileReader(options: DraftFileReaderOptions): (file: string) => Promise<RawDraftRead> {
  return async (file) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return { kind: 'ok', raw: await fs.readFile(file, 'utf8') };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (code === 'ENOENT') return { kind: 'missing' };
        const reason = `unreadable (${code ?? 'unknown'})`;
        const errorClass = classifyReadError(code, options.platform);
        if (errorClass === 'permanent') return { kind: 'unusable', reason, incomplete: false };
        if (errorClass === 'unlisted') return { kind: 'unusable', reason, incomplete: true };
        // process-wide / per-file: 再試行する。使い切ったとき、per-file はその 1 件を飛ばし、process-wide は投げる。
        if (attempt >= options.delaysMs.length) {
          if (errorClass === 'per-file') return { kind: 'unusable', reason, incomplete: true };
          throw error;
        }
        await options.sleep(options.delaysMs[attempt]);
      }
    }
  };
}
