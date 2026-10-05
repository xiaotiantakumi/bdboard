import type { DraftSuspectedLeak, IssueDraft, OccurredProject } from './issue-draft.js';
import { fitDraftToByteLimit } from './issue-draft-size.js';
import { prepareKeys } from './issue-public-keys.js';
import { detectSuspectedLeaks } from './issue-public-leaks.js';
import type { LocalOnlyKeys } from './issue-public-types.js';

/**
 * 下書きの題名・本文の編集 (bdboard-4y8q.3.1、docs/ISSUE-REPORTING.md 3節「閲覧・編集(PATCH)側のフィールド範囲」)。
 * 外部 I/O を持たない純粋関数。保存と排他は application の IssueDraftService、入口の検査は HTTP のルートが受け持つ。
 *
 * 書き換えられるのは title / body だけ。titleEditedByUser / bodyEditedByUser は、ここが (渡された欄だけ) true にする
 * (利用者からは書かせない)。直した欄には 4y8q.2 の置き換え漏れの検出 (detectSuspectedLeaks) をかけ直して、結果を
 * 下書きに持たせる。置き換えはしない (利用者が書いた文をサーバーが黙って書き換えない。疑いを見せて人が直す)。
 */

/** 題名の上限 (UTF-16 コード単位)。GitHub の issue の題名の上限 (256 文字) に合わせる。 */
export const ISSUE_DRAFT_TITLE_MAX_CHARS = 256;
/** 本文の上限 (UTF-16 コード単位)。GitHub の issue の本文の上限 (65536 文字) に合わせる。 */
export const ISSUE_DRAFT_BODY_MAX_CHARS = 65_536;
/**
 * 保存する置き換え漏れの疑いの件数の上限。2〜3 文字の名前が単語として並ぶ本文では、疑いが本文の長さに比例して増え、
 * draft.json の 200KB を食い潰すため。1 件は 60 バイト前後なので、上限いっぱいでも 12KB 程度。
 */
export const ISSUE_DRAFT_MAX_SUSPECTED_LEAKS = 200;

/** PATCH drafts/:id で書き換える欄。渡した欄だけを替える。 */
export interface DraftTextEdit {
  readonly title?: string;
  readonly body?: string;
}

export interface DraftLeakScan {
  /** 位置の順 (title → body、それぞれ開始位置の順)。上限 ISSUE_DRAFT_MAX_SUSPECTED_LEAKS 件。 */
  readonly suspectedLeaks: readonly DraftSuspectedLeak[];
  /** 上限で落とした件数。 */
  readonly omitted: number;
}

export interface DraftTextToScan {
  readonly title: string;
  readonly body: string;
  /** true の欄だけを調べる (自動で組んだ欄は調べない。組み立ての側の責任)。 */
  readonly titleEdited: boolean;
  readonly bodyEdited: boolean;
}

/**
 * 手元の鍵: 発生したプロジェクトの根のパスと、その名前。ユーザー名・ホスト名・ブランチ名は、今の受け取りの入力に無い
 * (docs/ISSUE-REPORTING.md 5節「4y8q.2 の範囲外」の配線)。ホームのパス・トークン・鍵ブロック・メールは鍵が無くても探す。
 */
export function localKeysOf(projects: readonly OccurredProject[]): LocalOnlyKeys {
  return {
    projectRoots: projects.map((project) => project.path),
    properNouns: projects.map((project) => ({ category: 'project' as const, value: project.name })),
  };
}

/**
 * 直した欄に置き換え漏れの検出をかける。印 (RedactionMark) は渡さない: 利用者が書いた文には、どこを置き換えたかの記録が
 * 無いので、印の文字列 (`<project>` など) の中の一致も疑いとして出る (過検出の側)。鍵を上限で落としたときは、
 * 4y8q.2 の組み立てと同じく位置の無い 'key-overflow' を先頭に足す (「疑いが空か」だけを見る側が漏れなしと読まない)。
 */
export function scanEditedText(text: DraftTextToScan, projects: readonly OccurredProject[]): DraftLeakScan {
  const prepared = prepareKeys(localKeysOf(projects));
  const overflow: DraftSuspectedLeak[] = prepared.truncated
    ? [{ field: 'body', kind: 'key-overflow', start: 0, end: 0 }]
    : [];
  const found = [
    ...(text.titleEdited ? detectSuspectedLeaks('title', text.title, [], prepared) : []),
    ...(text.bodyEdited ? detectSuspectedLeaks('body', text.body, [], prepared) : []),
  ].map(({ field, kind, start, end }): DraftSuspectedLeak => ({ field, kind, start, end }));
  const all = [...overflow, ...found];
  return {
    suspectedLeaks: all.slice(0, ISSUE_DRAFT_MAX_SUSPECTED_LEAKS),
    omitted: Math.max(0, all.length - ISSUE_DRAFT_MAX_SUSPECTED_LEAKS),
  };
}

/**
 * 題名・本文を替え、渡した欄の「直した」印を立て、置き換え漏れの検出をかけ直す。状態の確認 (pending だけ) と長さの
 * 上限は呼び出し側。大きくなった分は、ほかの書き込み (見送り・回数の追加) と同じく fitDraftToByteLimit で手元の欄
 * (生ログの末尾など) から削る。削り切っても 200KB を超えるなら、呼び出し側が draftJsonBytes で見て断る。
 */
export function applyDraftEdit(draft: IssueDraft, edit: DraftTextEdit): IssueDraft {
  const title = edit.title ?? draft.title;
  const body = edit.body ?? draft.body;
  const titleEditedByUser = draft.titleEditedByUser || edit.title !== undefined;
  const bodyEditedByUser = draft.bodyEditedByUser || edit.body !== undefined;
  const scan = scanEditedText(
    { title, body, titleEdited: titleEditedByUser, bodyEdited: bodyEditedByUser },
    draft.occurredProjects,
  );
  return fitDraftToByteLimit({
    ...draft,
    title,
    body,
    titleEditedByUser,
    bodyEditedByUser,
    suspectedLeaks: scan.suspectedLeaks,
    suspectedLeaksOmitted: scan.omitted,
  });
}
