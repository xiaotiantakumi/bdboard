import fs from 'node:fs/promises';

/**
 * draft.json を読むときの errno の扱い (bdboard-r50m)。fs-issue-draft-storage.ts から切り出した。
 *
 * エラーを 3 つに分ける:
 * - 一時的 (transient): すぐ直るかもしれない。短い待ちを挟んで回数上限つきで再試行し、使い切ったら投げる。
 * - 恒久 (permanent): その場では直らない (種類が違う・読む権限が無い)。その下書きを警告つきで飛ばす。
 * - 未列挙 (unlisted): 上のどちらでもない (EIO・ELOOP・ERR_FS_FILE_TOO_LARGE・code の無いエラーなど)。
 *   一覧と受け取り全体を落とさないよう、その 1 件を警告つきで飛ばす。ただし直るかもしれないので
 *   「一覧が欠けた」印 (incomplete) を付け、受け取りの索引 (issue-draft-service) にキャッシュさせない。
 */

/** 再試行の前の待ち (ms)。長さ = 再試行の回数 (最初の 1 回と合わせて 4 回試す)。合計 140ms。 */
export const DRAFT_READ_RETRY_DELAYS_MS: readonly number[] = [20, 40, 80];

const TRANSIENT_CODES: ReadonlySet<string> = new Set(['EMFILE', 'ENFILE', 'EBUSY', 'EAGAIN']);
/** Windows ではアンチウイルスのスキャンや削除待ちで一時的に出ることが多い。それ以外の OS では権限そのもの。 */
const TRANSIENT_ON_WIN32_CODES: ReadonlySet<string> = new Set(['EPERM', 'EACCES']);
const PERMANENT_CODES: ReadonlySet<string> = new Set(['ENOTDIR', 'EISDIR', 'EPERM', 'EACCES']);

export type ReadErrorClass = 'transient' | 'permanent' | 'unlisted';

export function classifyReadError(code: string | undefined, platform: NodeJS.Platform): ReadErrorClass {
  if (code === undefined) return 'unlisted';
  if (TRANSIENT_CODES.has(code)) return 'transient';
  if (platform === 'win32' && TRANSIENT_ON_WIN32_CODES.has(code)) return 'transient';
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
 * 存在しない (missing)・あるが読めない (unusable)・読めた (ok) を返す。一時的なエラーを使い切ったときだけ投げる
 * (元のエラーをそのまま)。unusable の reason は警告に出るので、エラーの message やパスは入れず code だけにする。
 */
export function createDraftFileReader(options: DraftFileReaderOptions): (file: string) => Promise<RawDraftRead> {
  return async (file) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return { kind: 'ok', raw: await fs.readFile(file, 'utf8') };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (code === 'ENOENT') return { kind: 'missing' };
        const errorClass = classifyReadError(code, options.platform);
        if (errorClass === 'permanent') return { kind: 'unusable', reason: `unreadable (${code ?? 'unknown'})`, incomplete: false };
        if (errorClass === 'unlisted') return { kind: 'unusable', reason: `unreadable (${code ?? 'unknown'})`, incomplete: true };
        if (attempt >= options.delaysMs.length) throw error;
        await options.sleep(options.delaysMs[attempt]);
      }
    }
  };
}
