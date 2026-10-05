import fs from 'node:fs/promises';
import path from 'node:path';
import type { Stats } from 'node:fs';
import { isDraftId, type IssueDraft } from '../../domain/issue-draft.js';
import type { DraftFootprint } from '../../domain/issue-draft-retention.js';
import type { DraftIndexEntry, DraftSurvey } from '../../application/ports/issue-draft-storage.js';
import { classifyReadError } from './issue-draft-file-reader.js';

/**
 * 下書きディレクトリの棚卸しと削除 (bdboard-00qh)。fs-issue-draft-storage.ts から切り出した。
 * 何を消すかの方針は domain/issue-draft-retention.ts、いつ走らせるかは application
 * (issue-draft-retention.ts)。ここは測る・消すだけ。
 *
 * 1 下書き = `<id>/draft.json` と `<id>/images/*`。大きさは draft.json の stat と images/ 直下の
 * ファイルの stat の合計で、再帰では歩かない (保存層はこれ以外の場所に書かない)。保存の途中で
 * 落ちたときの一時ファイル (draft.json.*.tmp) は数えない (1 つ最大 200KB で、下書きごと消せば消える)。
 * 画像ディレクトリの readdir・stat が失敗したら、その場所は 0 バイトで数えて code を unmeasured に
 * 積む: 投げると、1 つの画像ディレクトリの EIO のせいで掃除も容量の確認もできなくなる。
 */

/** 1 下書きのディレクトリの中身 (fs-issue-draft-storage.ts と共有する)。 */
export const DRAFT_FILE = 'draft.json';
export const IMAGES_DIR = 'images';

/** 一度に開くファイルの数の上限。数千件を一斉に開いて EMFILE にしない。 */
const SURVEY_BATCH_SIZE = 64;

export interface FsDraftFootprintDeps {
  /** path.resolve 済みの issue-drafts ディレクトリ。 */
  readonly baseDir: string;
  /** id を検証してパスを返す (ストアの draftDir)。 */
  readonly draftDir: (id: string) => string;
  /** 読めて使える下書きだけ ok で返す。読めない・壊れているものは unusable (ストアの get と同じ扱い。incomplete もそのまま)。 */
  readonly readDraft: (id: string) => Promise<FootprintRead>;
  /** draft.json の stat の失敗を、読み出しと同じ分類 (classifyReadError) で扱うための OS。 */
  readonly platform: NodeJS.Platform;
}

export type FootprintRead =
  | { readonly kind: 'ok'; readonly draft: IssueDraft }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unusable'; readonly incomplete: boolean };

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? code : 'unknown';
}

export function createFsDraftFootprints(
  deps: FsDraftFootprintDeps,
): { survey(): Promise<DraftSurvey>; remove(id: string): Promise<void> } {
  /** ENOENT (無い) は 0 バイトで正常。それ以外の失敗は 0 バイトで数えて code を積む。 */
  function noteUnmeasured(error: unknown, unmeasured: string[]): void {
    if (errorCode(error) !== 'ENOENT') unmeasured.push(errorCode(error));
  }

  async function measureImages(id: string, unmeasured: string[]): Promise<number> {
    const dir = path.join(deps.draftDir(id), IMAGES_DIR);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (error) {
      noteUnmeasured(error, unmeasured);
      return 0;
    }
    let bytes = 0;
    for (const name of names) {
      try {
        const stat = await fs.stat(path.join(dir, name));
        if (stat.isFile()) bytes += stat.size;
      } catch (error) {
        noteUnmeasured(error, unmeasured);
      }
    }
    return bytes;
  }

  async function footprintOf(
    id: string,
    unmeasured: string[],
  ): Promise<{ readonly footprint: DraftFootprint; readonly entry?: DraftIndexEntry; readonly incomplete: boolean }> {
    let jsonStat: Stats | undefined;
    let statIncomplete = false;
    try {
      jsonStat = await fs.stat(path.join(deps.draftDir(id), DRAFT_FILE));
    } catch (error) {
      noteUnmeasured(error, unmeasured);
      // scan() が同じ draft.json を読んだときと同じ判定: 無い (ENOENT) と恒久 (ENOTDIR など) は一覧を欠かさない。
      // それ以外 (あとで通るかもしれない失敗) は、stat しか試さない棚卸しの索引の材料を欠けた扱いにする。
      statIncomplete = errorCode(error) !== 'ENOENT' && classifyReadError(errorCode(error), deps.platform) !== 'permanent';
    }
    const imageBytes = await measureImages(id, unmeasured);
    const bytes = (jsonStat?.isFile() ? jsonStat.size : 0) + imageBytes;
    const read = jsonStat?.isFile() ? await deps.readDraft(id) : undefined;
    if (read?.kind !== 'ok' || jsonStat === undefined) {
      return {
        footprint: { id, bytes },
        incomplete: statIncomplete || (read?.kind === 'unusable' && read.incomplete),
      };
    }
    const draft = read.draft;
    return {
      footprint: { id, bytes, known: { status: draft.status, updatedAtMs: jsonStat.mtimeMs } },
      entry: { id: draft.id, fingerprint: draft.fingerprint, firstOccurredAt: draft.firstOccurredAt, status: draft.status },
      incomplete: false,
    };
  }

  return {
    async survey() {
      let names: string[];
      try {
        names = await fs.readdir(deps.baseDir);
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return { drafts: [], totalBytes: 0, unmeasured: [], indexSeed: { entries: [], complete: true } };
        throw error;
      }
      const ids = names.filter(isDraftId);
      const unmeasured: string[] = [];
      const drafts: DraftFootprint[] = [];
      const entries: DraftIndexEntry[] = [];
      let complete = true;
      for (let start = 0; start < ids.length; start += SURVEY_BATCH_SIZE) {
        const batch = ids.slice(start, start + SURVEY_BATCH_SIZE);
        const results = await Promise.all(batch.map((id) => footprintOf(id, unmeasured)));
        for (const result of results) {
          drafts.push(result.footprint);
          if (result.entry !== undefined) entries.push(result.entry);
          if (result.incomplete) complete = false;
        }
      }
      return { drafts, totalBytes: drafts.reduce((sum, draft) => sum + draft.bytes, 0), unmeasured, indexSeed: { entries, complete } };
    },

    async remove(id) {
      await fs.rm(deps.draftDir(id), { recursive: true, force: true });
    },
  };
}
