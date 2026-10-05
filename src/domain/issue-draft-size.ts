import { cutKeepingHead } from './issue-draft-cut.js';
import { ISSUE_DRAFT_MAX_JSON_BYTES, type IssueDraft } from './issue-draft.js';

/**
 * draft.json の大きさ (bdboard-4y8q.1、docs/ISSUE-REPORTING.md 4節「上限」)。
 *
 * 保存する形 (serializeDraft) の長さで測って、200KB に収まるまで削る。判定と書き込みが同じ
 * 文字列を見るので、整形や JSON エスケープで書き込みのほうが大きくなることがない。
 */

/**
 * draft.json に書く中身 (末尾の改行つき、1 行)。上限の判定と書き込みが同じ文字列を見るよう、
 * 保存層もこの関数で書く。整形 (インデント) して書くと判定より大きくなって 200KB を超える。
 */
export function serializeDraft(draft: IssueDraft): string {
  return `${JSON.stringify(draft)}\n`;
}

function jsonBytes(draft: IssueDraft): number {
  return Buffer.byteLength(serializeDraft(draft), 'utf8');
}

type ShrinkableField = 'errorTextRaw' | 'agentNoteRaw' | 'symptomRaw' | 'causeRaw' | 'preventionRaw';

/** 超過バイト数を受け、削ったあとの下書きを返す。もう削るものが無ければ undefined。 */
type ShrinkStep = (draft: IssueDraft, excessBytes: number) => IssueDraft | undefined;

/**
 * 自由記述の欄を末尾から削る。切れ目は行の終わりへ戻し、サロゲートの対を割らない (issue-draft-cut.ts。戻した分だけ多めに
 * 削れる)。1 回で必ず 1 コード単位以上短くなるので、繰り返しは空になって止まる。
 */
function cutTextFrom(field: ShrinkableField): ShrinkStep {
  return (draft, excess) => {
    const value = draft.localOnly[field];
    if (value === undefined || value.length === 0) return undefined;
    // 1 文字は最大 3 バイト (BMP) として、超過分を削るのに足りる文字数を一度に落とす。
    const cut = Math.max(1, Math.ceil(excess / 3));
    return {
      ...draft,
      localOnly: { ...draft.localOnly, [field]: cutKeepingHead(value, value.length - cut) },
    };
  };
}

/** 古い順に丸ごと削る。age が同じなら先頭 (=先に足されたもの) から。超過分に足りるまで削る。 */
function dropOldest<T>(items: readonly T[], excess: number, ageOf: (item: T) => string): readonly T[] {
  const order = items
    .map((_, index) => index)
    .sort((a, b) => {
      const ageA = ageOf(items[a]);
      const ageB = ageOf(items[b]);
      return ageA < ageB ? -1 : ageA > ageB ? 1 : a - b;
    });
  const dropped = new Set<number>();
  let freed = 0;
  for (const index of order) {
    if (freed >= excess) break;
    dropped.add(index);
    // 要素 1 つぶんの JSON と区切りのカンマ 1 バイト。
    freed += Buffer.byteLength(JSON.stringify(items[index]), 'utf8') + 1;
  }
  return items.filter((_, index) => !dropped.has(index));
}

const dropOldestProjects: ShrinkStep = (draft, excess) =>
  draft.occurredProjects.length === 0
    ? undefined
    : { ...draft, occurredProjects: dropOldest(draft.occurredProjects, excess, (entry) => entry.lastSeenAt) };

const dropOldestFoldedFingerprints: ShrinkStep = (draft, excess) => {
  const folded = draft.localOnly.foldedFingerprints;
  if (folded === undefined || folded.length === 0) return undefined;
  return {
    ...draft,
    localOnly: { ...draft.localOnly, foldedFingerprints: dropOldest(folded, excess, () => '') },
  };
};

// 設計 4節: draft.json 全体の超過分は末尾から切る。いちばん大きくなりうる生ログから順に削る。
// その次は一覧 (発生プロジェクト・丸め込んだ指紋) の古い行。回数と時刻は別に持っているので、
// 失うのは一覧の古い行だけで済む。人が書いた欄 (症状・原因・対策・メモ) は最後に回す。
const SHRINK_STEPS: readonly ShrinkStep[] = [
  cutTextFrom('errorTextRaw'),
  dropOldestProjects,
  dropOldestFoldedFingerprints,
  cutTextFrom('agentNoteRaw'),
  cutTextFrom('symptomRaw'),
  cutTextFrom('causeRaw'),
  cutTextFrom('preventionRaw'),
];

/**
 * draft.json (画像を除く) を maxBytes に収める。収まっていればそのまま返す。収まらなければ
 * SHRINK_STEPS の順に削って収める。文字数ではなくバイト数で、ディスクに書く形 (serializeDraft)
 * の長さで判定する (多バイト文字や制御文字の JSON エスケープで、文字数の上限を守っても超えるため)。
 * 題名・id・版などの固定の短い欄は入口で長さを抑えてあるので、削る対象にしない。
 */
export function fitDraftToByteLimit(
  draft: IssueDraft,
  maxBytes: number = ISSUE_DRAFT_MAX_JSON_BYTES,
): IssueDraft {
  let current = draft;
  let size = jsonBytes(current);
  for (const step of SHRINK_STEPS) {
    while (size > maxBytes) {
      const next = step(current, size - maxBytes);
      if (next === undefined) break;
      current = next;
      size = jsonBytes(current);
    }
    if (size <= maxBytes) break;
  }
  return current;
}

/** 保存する大きさ (バイト)。テストと保存層の確認用。 */
export function draftJsonBytes(draft: IssueDraft): number {
  return jsonBytes(draft);
}
