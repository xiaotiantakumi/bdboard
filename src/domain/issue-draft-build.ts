import {
  ISSUE_DRAFT_MAX_FOLDED_FINGERPRINTS,
  ISSUE_DRAFT_MAX_PROJECTS,
  capErrorTextRaw,
  capFreeText,
  isMassOccurrenceFingerprint,
  summarizeErrorText,
  type DraftEnvInfo,
  type IssueDraft,
  type LocalOnlyContext,
  type OccurredProject,
} from './issue-draft.js';
import { fitDraftToByteLimit } from './issue-draft-size.js';
import type { ReceiveDraftInput } from './issue-draft-input.js';
import {
  buildMassOccurrenceText,
  buildProvisionalDraftText,
  type DraftText,
} from './issue-draft-text.js';

export type { ReceiveDraftInput } from './issue-draft-input.js';
export { canonicalizeReceiveInput } from './issue-draft-input.js';

/**
 * 受け取った 1 回分の報告から下書きを作る・足す純粋関数 (bdboard-4y8q.1、設計 4節の状態遷移の表)。
 * 保存や排他は application の IssueDraftService が受け持つ。
 */

function normalizeEnvInfo(env: Partial<DraftEnvInfo> | undefined): DraftEnvInfo {
  return {
    bdboardVersion: env?.bdboardVersion ?? 'unknown',
    os: env?.os ?? 'unknown',
    nodeVersion: env?.nodeVersion ?? 'unknown',
    ...(env?.harnessVersion !== undefined ? { harnessVersion: env.harnessVersion } : {}),
    ...(env?.bdVersion !== undefined ? { bdVersion: env.bdVersion } : {}),
    ...(env?.ghVersion !== undefined ? { ghVersion: env.ghVersion } : {}),
  };
}

/** 指紋の材料にしたのと同じ (前後の空白を除いた) 値を、下書き自身の欄として持つ。 */
function identifierFields(input: ReceiveDraftInput): Pick<IssueDraft, 'catalogSlug' | 'source'> {
  if (input.kind === 'A') {
    const catalogSlug = input.catalogSlug?.trim();
    return catalogSlug === undefined || catalogSlug === '' ? {} : { catalogSlug };
  }
  const source = input.source?.trim();
  return source === undefined || source === '' ? {} : { source };
}

function buildLocalOnly(input: ReceiveDraftInput): LocalOnlyContext {
  const errorTextRaw = input.errorText === undefined ? undefined : capErrorTextRaw(input.errorText);
  const summary = errorTextRaw === undefined ? undefined : summarizeErrorText(errorTextRaw);
  return {
    symptomRaw: capFreeText(input.symptom ?? ''),
    causeRaw: capFreeText(input.cause ?? ''),
    preventionRaw: capFreeText(input.prevention ?? ''),
    ...(errorTextRaw !== undefined && summary !== undefined
      ? { errorTextRaw, errorTextHead: summary.head, errorTextTail: summary.tail }
      : {}),
    errorTextTruncated: summary?.truncated ?? false,
    ...(input.agentNote !== undefined ? { agentNoteRaw: capFreeText(input.agentNote) } : {}),
    envInfo: normalizeEnvInfo(input.envInfo),
  };
}

/** 同じパスのプロジェクトは lastSeenAt だけ更新し、新しいパスは (上限まで) 足す。 */
function upsertProject(
  projects: readonly OccurredProject[],
  project: ReceiveDraftInput['project'],
  nowIso: string,
): readonly OccurredProject[] {
  if (project === undefined) return projects;
  const existing = projects.find((entry) => entry.path === project.path);
  if (existing !== undefined) {
    return projects.map((entry) => (entry === existing ? { ...entry, lastSeenAt: nowIso } : entry));
  }
  if (projects.length >= ISSUE_DRAFT_MAX_PROJECTS) return projects;
  return [...projects, { name: project.name, path: project.path, firstSeenAt: nowIso, lastSeenAt: nowIso }];
}

function textFor(draft: IssueDraft): DraftText {
  if (isMassOccurrenceFingerprint(draft.fingerprint)) {
    const folded = draft.localOnly.foldedFingerprints ?? [];
    return buildMassOccurrenceText({
      kind: draft.kind,
      bucket: draft.fingerprint.slice(draft.fingerprint.lastIndexOf(':') + 1),
      foldedCount: folded.length,
      foldedCountCapped: folded.length >= ISSUE_DRAFT_MAX_FOLDED_FINGERPRINTS,
      occurrenceCount: draft.occurrenceCount,
      firstOccurredAt: draft.firstOccurredAt,
      lastOccurredAt: draft.lastOccurredAt,
    });
  }
  // 名前は下書きが持っている source / catalogSlug を使う (指紋から切り出し直さない)。
  return buildProvisionalDraftText({
    kind: draft.kind,
    ...(draft.catalogSlug !== undefined ? { catalogSlug: draft.catalogSlug } : {}),
    ...(draft.source !== undefined ? { source: draft.source } : {}),
    versions: draft.localOnly.envInfo,
    occurrenceCount: draft.occurrenceCount,
    firstOccurredAt: draft.firstOccurredAt,
    lastOccurredAt: draft.lastOccurredAt,
  });
}

/** 題名・本文を作り直し、大きさの上限に収める。ユーザーが編集済みの項目は触らない (設計 4節)。 */
function finalize(draft: IssueDraft): IssueDraft {
  const text = textFor(draft);
  return fitDraftToByteLimit({
    ...draft,
    title: draft.titleEditedByUser ? draft.title : text.title,
    body: draft.bodyEditedByUser ? draft.body : text.body,
  });
}

/** 既知の指紋が無いときの新規下書き (status='pending'、回数 1)。 */
export function createDraftFromReport(
  input: ReceiveDraftInput,
  meta: { readonly id: string; readonly fingerprint: string; readonly nowIso: string },
): IssueDraft {
  const localOnly = buildLocalOnly(input);
  return finalize({
    id: meta.id,
    kind: input.kind,
    fingerprint: meta.fingerprint,
    ...identifierFields(input),
    title: '',
    body: '',
    titleEditedByUser: false,
    bodyEditedByUser: false,
    localOnly,
    occurredProjects: upsertProject([], input.project, meta.nowIso),
    occurrenceCount: 1,
    firstOccurredAt: meta.nowIso,
    lastOccurredAt: meta.nowIso,
    status: 'pending',
    ...(localOnly.envInfo.harnessVersion !== undefined
      ? { harnessVersionAtOccurrence: localOnly.envInfo.harnessVersion }
      : {}),
    ...(input.sourceTicketRef !== undefined ? { sourceTicketRef: input.sourceTicketRef } : {}),
    draftSchemaVersion: 1,
  });
}

/**
 * 回数だけ足す (見送り・投稿済みの下書き)。時刻・プロジェクト・題名・本文・丸め込んだ指紋は
 * 触らない。回数の桁が増えても 200KB を超えないよう、大きさの確認はかける。
 */
function countOnly(existing: IssueDraft): IssueDraft {
  return fitDraftToByteLimit({ ...existing, occurrenceCount: existing.occurrenceCount + 1 });
}

/**
 * 既存の下書きへ 1 回分の発生を足す (設計 4節の表)。
 * pending: 回数・最終発生時刻・プロジェクト一覧を更新し、編集されていなければ題名・本文を作り直す。
 * dismissed: 回数を足すだけ (エピック決定どおり)。
 * posted: 開いている issue への表示・閉じた issue の再発は bdboard-4y8q.5 の仕事。それまでは
 * 回数を失わないよう dismissed と同じく足すだけにする (現時点では posted になる経路が無い)。
 */
export function addOccurrence(existing: IssueDraft, input: ReceiveDraftInput, nowIso: string): IssueDraft {
  if (existing.status !== 'pending') return countOnly(existing);
  return finalize({
    ...existing,
    ...latestEnvironment(existing, input),
    occurrenceCount: existing.occurrenceCount + 1,
    lastOccurredAt: nowIso,
    occurredProjects: upsertProject(existing.occurredProjects, input.project, nowIso),
  });
}

/**
 * 手元の版 (envInfo と harnessVersionAtOccurrence) を最後の発生のものにする (#859 のレビュー m-6、bdboard-4y8q.3.1)。
 * 画面の「版の比較」は、最新の harness pack の版と並べて「最新の版では直っているかもしれない」を出すので、比べるのは
 * 最後に起きたときの版。最初の発生の版は残さない (残すなら欄を足す。docs/ISSUE-REPORTING.md 4節の状態遷移の表)。
 * 版の分からない報告 (envInfo の無い報告) では前の値を残す。envInfo があってハーネスの版だけ無い報告では、
 * harnessVersionAtOccurrence も無くす (envInfo.harnessVersion と食い違わせない)。
 */
function latestEnvironment(
  existing: IssueDraft,
  input: ReceiveDraftInput,
): Pick<IssueDraft, 'localOnly' | 'harnessVersionAtOccurrence'> {
  if (input.envInfo === undefined) {
    return { localOnly: existing.localOnly, harnessVersionAtOccurrence: existing.harnessVersionAtOccurrence };
  }
  const envInfo = normalizeEnvInfo(input.envInfo);
  return { localOnly: { ...existing.localOnly, envInfo }, harnessVersionAtOccurrence: envInfo.harnessVersion };
}

/**
 * 1 時間 20 件の枠を超えた新規指紋を、その時間バケツの「大量発生」下書きへ丸め込む。
 * existing が無ければ新しく作る。公開本文は一般的な文面に留め、元の指紋は localOnly にだけ残す。
 * existing が pending でなければ (見送り・投稿済み)、通常の下書きと同じく回数だけ足す:
 * 題名・本文・時刻・プロジェクト・丸め込んだ指紋は触らず、作り直しもしない。
 */
export function foldIntoMassDraft(
  existing: IssueDraft | undefined,
  input: ReceiveDraftInput,
  meta: {
    readonly id: string;
    readonly massFingerprint: string;
    readonly foldedFingerprint: string;
    readonly nowIso: string;
  },
): IssueDraft {
  if (existing !== undefined && existing.status !== 'pending') return countOnly(existing);
  const base: IssueDraft = existing ?? {
    id: meta.id,
    kind: input.kind,
    fingerprint: meta.massFingerprint,
    title: '',
    body: '',
    titleEditedByUser: false,
    bodyEditedByUser: false,
    localOnly: {
      symptomRaw: '',
      causeRaw: '',
      preventionRaw: '',
      errorTextTruncated: false,
      envInfo: normalizeEnvInfo(input.envInfo),
      foldedFingerprints: [],
    },
    occurredProjects: [],
    occurrenceCount: 0,
    firstOccurredAt: meta.nowIso,
    lastOccurredAt: meta.nowIso,
    status: 'pending',
    draftSchemaVersion: 1,
  };
  const folded = base.localOnly.foldedFingerprints ?? [];
  const foldedNext =
    folded.includes(meta.foldedFingerprint) || folded.length >= ISSUE_DRAFT_MAX_FOLDED_FINGERPRINTS
      ? folded
      : [...folded, meta.foldedFingerprint];
  return finalize({
    ...base,
    occurrenceCount: base.occurrenceCount + 1,
    lastOccurredAt: meta.nowIso,
    occurredProjects: upsertProject(base.occurredProjects, input.project, meta.nowIso),
    localOnly: { ...base.localOnly, foldedFingerprints: foldedNext },
  });
}
