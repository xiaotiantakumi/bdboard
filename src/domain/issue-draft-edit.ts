import { ISSUE_DRAFT_MAX_JSON_BYTES, type DraftSuspectedLeak, type IssueDraft, type OccurredProject } from './issue-draft.js';
import { cutKeepingHead } from './issue-draft-cut.js';
import { foldHomePaths, hasVisibleText } from './issue-draft-identifier.js';
import { draftJsonBytes } from './issue-draft-size.js';
import { prepareKeys } from './issue-public-keys.js';
import { detectSuspectedLeaks } from './issue-public-leaks.js';
import type { LocalOnlyKeys } from './issue-public-types.js';
import { autoTextOf } from './issue-draft-text.js';

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
/**
 * 編集のあとに残す draft.json の余白 (bdboard-4y8q.3.1 の再レビュー m-B)。編集で 200KB ちょうどまで膨らませると、次の受け取り・
 * 見送りが従来の縮め (fitDraftToByteLimit) で古いプロジェクトや人が書いた欄を削るので、編集は 200KB からこの余白を引いた
 * 大きさまでにする。根拠 (JSON のバイト数。入口の上限は interface/http/issue-report-routes.ts の受け取り・見送りの schema):
 * - 受け取り 1 回: 新しいプロジェクト 1 件 (path 1000 文字 × エスケープで最大 6 バイト + name 200 文字 × 3 バイト ≈ 6.8KB)、
 *   版の入れ替え (envInfo 6 欄と harnessVersionAtOccurrence、各 100 文字 × 3 バイト ≈ 2.1KB) と自動の本文に載る版 (≈ 2KB)、
 *   直した欄の疑いのかけ直し (最大 200 件 × 約 66 バイト ≈ 13.2KB)、回数と時刻 (数十バイト)。合わせて約 24KB。
 * - 見送り: 理由 200 文字 × 3 バイトと状態・時刻 (≈ 0.7KB)。
 * 足して約 25KB。切りのよい 32KiB にする。
 */
export const ISSUE_DRAFT_EDIT_HEADROOM_BYTES = 32 * 1024;

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
 * トンネル (手元の外) の読み手へ返す疑いの鍵: 表示名だけで、根のパスは入れない (bdboard-4y8q.3.1 のレビュー M-1)。
 * トンネルの読み手は occurredProjects[].name を見ているが path は見ていない。根を鍵にすると、本文に推測のパスを
 * 並べて送り、疑いの種別 (project-path) が付くかどうかで隠したパスやフォルダ名を当てて確かめられる (根の末尾の
 * フォルダ名も名前の鍵として足されるため)。ホームのパス・トークン・鍵ブロック・メールは鍵なしで探すので、そのまま出る。
 */
export function displayedKeysOf(projects: readonly OccurredProject[]): LocalOnlyKeys {
  return {
    projectRoots: [],
    // トンネルが見る名前は foldHomePaths で畳んだもの (issue-report-dto.ts)。保存先へ直接書かれた生の名前
    // (/Users/alice/tool) でも、見えている ~/tool と同じ鍵にする (再レビュー n-A)。
    properNouns: projects.map((project) => ({ category: 'project' as const, value: foldHomePaths(project.name) })),
  };
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
 * 検出がかかる欄の文字列 (直していない欄は無い。自動で組んだ欄は調べない)。検出 (scanEditedText) の入力は、ここで返す文字列と鍵だけ。
 * トンネル側の結果の再利用 (interface/http/issue-report-leak-cache.ts) の指紋も同じものから作る: 検出する欄が変われば指紋が変わって
 * 検出をかけ直し、検出しない欄 (直していない欄の自動の文は受け取りのたびに変わる) が変わっても当たる。検出する欄を足すときはここに足す
 * (検出と指紋が同時に変わる。指紋だけが古いまま、検出する欄を見落とすことが無い)。
 */
export function scannedFieldsOf(text: DraftTextToScan): { readonly title?: string; readonly body?: string } {
  return { ...(text.titleEdited ? { title: text.title } : {}), ...(text.bodyEdited ? { body: text.body } : {}) };
}

/**
 * 直した欄に置き換え漏れの検出をかける。印 (RedactionMark) は渡さない: 利用者が書いた文には、どこを置き換えたかの記録が
 * 無いので、印の文字列 (`<project>` など) の中の一致も疑いとして出る (過検出の側)。鍵を上限で落としたときは、
 * 4y8q.2 の組み立てと同じく位置の無い 'key-overflow' を先頭に足す (「疑いが空か」だけを見る側が漏れなしと読まない)。
 */
export function scanEditedText(text: DraftTextToScan, keys: LocalOnlyKeys): DraftLeakScan {
  const prepared = prepareKeys(keys);
  const overflow: DraftSuspectedLeak[] = prepared.truncated
    ? [{ field: 'body', kind: 'key-overflow', start: 0, end: 0 }]
    : [];
  const fields = scannedFieldsOf(text);
  const found = [
    ...(fields.title !== undefined ? detectSuspectedLeaks('title', fields.title, [], prepared) : []),
    ...(fields.body !== undefined ? detectSuspectedLeaks('body', fields.body, [], prepared) : []),
  ].map(({ field, kind, start, end }): DraftSuspectedLeak => ({ field, kind, start, end }));
  const all = [...overflow, ...found];
  return {
    suspectedLeaks: all.slice(0, ISSUE_DRAFT_MAX_SUSPECTED_LEAKS),
    omitted: Math.max(0, all.length - ISSUE_DRAFT_MAX_SUSPECTED_LEAKS),
  };
}

/** どの欄も直していない下書きに、古い疑いを残さない (「一度も直していない下書きには無い」の約束。直した印を戻した PATCH のあと)。 */
function withoutSuspectedLeaks(draft: IssueDraft): IssueDraft {
  const clean: { -readonly [K in keyof IssueDraft]: IssueDraft[K] } = { ...draft };
  delete clean.suspectedLeaks;
  delete clean.suspectedLeaksOmitted;
  return clean;
}

/** 直した欄に検出をかけ直した疑いを持たせる (手元の鍵 = 発生したプロジェクトのパスと名前)。直した欄が無ければそのまま。 */
export function withRescannedLeaks(draft: IssueDraft): IssueDraft {
  if (!draft.titleEditedByUser && !draft.bodyEditedByUser) return withoutSuspectedLeaks(draft);
  const scan = scanEditedText(
    { title: draft.title, body: draft.body, titleEdited: draft.titleEditedByUser, bodyEdited: draft.bodyEditedByUser },
    localKeysOf(draft.occurredProjects),
  );
  return { ...draft, suspectedLeaks: scan.suspectedLeaks, suspectedLeaksOmitted: scan.omitted };
}

/**
 * 編集で limit を超えた分を、手元の生ログ (errorTextRaw) の末尾からだけ削る (レビュー M-2)。発生プロジェクト (漏れ検出の鍵と
 * パス)・丸め込んだ指紋・人が書いた欄 (症状・原因・対策・メモ) は、編集では削らない: 手元の外 (トンネル) の書き手が
 * 本文の大きさだけで、見られない手元のデータを消せてしまうため。先頭・末尾の切り出し (errorTextHead / Tail) は残す。
 * 削ったら errorTextTruncated を立てる。生ログを削り切っても超えるなら、そのまま返す (呼び出し側が 413 にする)。
 */
function trimErrorTextToFit(draft: IssueDraft, limit: number): { readonly draft: IssueDraft; readonly trimmed: boolean } {
  let current = draft;
  let trimmed = false;
  for (;;) {
    const excess = draftJsonBytes(current) - limit;
    const raw = current.localOnly.errorTextRaw;
    if (excess <= 0 || raw === undefined || raw.length === 0) return { draft: current, trimmed };
    // fitDraftToByteLimit の cutTextFrom と同じく、1 文字は最大 3 バイトとして一度に落とす (足りなければもう一周)。切れ目は
    // 行の終わりへ戻し、サロゲートの対を割らない (issue-draft-cut.ts、bdboard-4y8q.13: 名前・根・トークンの途中で切ると、その
    // 断片が公開本文の欄の端に残る)。1 回で必ず 1 コード単位以上短くなるので、繰り返しは空になって止まる。
    const cut = Math.max(1, Math.ceil(excess / 3));
    current = {
      ...current,
      localOnly: { ...current.localOnly, errorTextRaw: cutKeepingHead(raw, raw.length - cut), errorTextTruncated: true },
    };
    trimmed = true;
  }
}

export interface DraftEditOutcome {
  readonly draft: IssueDraft;
  /** 編集の上限に収めるために生ログの末尾を削った。 */
  readonly errorTextTrimmed: boolean;
  /** 編集の上限に収まった。false なら保存しない (413)。 */
  readonly fits: boolean;
}

/**
 * 題名・本文を替え、渡した欄の「直した」印を立て、置き換え漏れの検出をかけ直す。状態の確認 (pending だけ) と長さの
 * 上限は呼び出し側。大きくなった分は生ログの末尾からだけ削り (trimErrorTextToFit)、それでも編集の上限 (200KB から
 * ISSUE_DRAFT_EDIT_HEADROOM_BYTES を引いた大きさ) を超えるなら fits を false にし、呼び出し側が断る。検出の入力 (題名・本文・発生プロジェクト) は削る前と後で変わらない (削るのは生ログだけ) ので、
 * 疑いは保存する下書きの鍵と食い違わない。疑いの分 (最大 200 件) も大きさに入れて削る。
 */
export function applyDraftEdit(draft: IssueDraft, edit: DraftTextEdit): DraftEditOutcome {
  const automatic = autoTextOf(draft);
  // 戻すかの判定は題名も本文も同じ hasVisibleText: 見える文字が無い (空・空白だけ・ZWSP や U+2800 などの見えない文字だけ) 欄は、
  // 「直した」見えない文を保存せず、自動で組んだ文へ戻す (bdboard-ov0t。以前は本文だけ trim() で見ていた)。
  const titleReset = edit.title !== undefined && !hasVisibleText(edit.title);
  const bodyReset = edit.body !== undefined && !hasVisibleText(edit.body);
  const edited = withRescannedLeaks({
    ...draft,
    title: titleReset ? automatic.title : edit.title ?? draft.title,
    body: bodyReset ? automatic.body : edit.body ?? draft.body,
    titleEditedByUser: titleReset ? false : draft.titleEditedByUser || edit.title !== undefined,
    bodyEditedByUser: bodyReset ? false : draft.bodyEditedByUser || edit.body !== undefined,
  });
  // 編集の上限は 200KB から余白を引いた大きさ。受け取りで既にそれを超えている下書きは、今より大きくしなければ通す
  // (題名の一字の直しまで断らない。余白を割ったのは編集ではないので、編集が余白を食うことにはならない)。
  const limit = Math.max(ISSUE_DRAFT_MAX_JSON_BYTES - ISSUE_DRAFT_EDIT_HEADROOM_BYTES, draftJsonBytes(draft));
  const fitted = trimErrorTextToFit(edited, limit);
  return { draft: fitted.draft, errorTextTrimmed: fitted.trimmed, fits: draftJsonBytes(fitted.draft) <= limit };
}
