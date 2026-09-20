import { z } from 'zod';
import type { CommandRunner } from '../../application/ports/command-runner.js';
import type {
  HumanDecisionsPort,
  PendingDecision,
  PendingDecisionKind,
  PendingDecisionOption,
  ResolvedDecisionKind,
  RespondOutcome,
} from '../../application/ports/human-decisions.js';
import { BdError } from '../../application/ports/issue-repository.js';
import { classifyBdError } from './classify-bd-error.js';
import { withLockContentionRetry } from './bd-retry.js';

const DEFAULT_BD_PATH = 'bd';
const DEFAULT_TIMEOUT_MS = 30_000;
const GATE_CLOSE_REASON_MAX_LEN = 200;
// resolveKind は fail-safe の読み取りプローブなので長く粘る必要がない。
// 既定の lock-contention リトライ込みだと最悪 ~91s かかるが、5s + リトライなしで足りる。
const KIND_PROBE_TIMEOUT_MS = 5_000;

export type { HumanDecisionsPort, PendingDecision, PendingDecisionOption, RespondOutcome };

export interface BdCliHumanDecisionsOptions {
  readonly bdPath?: string;
  readonly timeoutMs?: number;
}

const decisionOptionSchema = z.object({
  label: z.string(),
  value: z.string(),
});

const bdHumanListItemSchema = z.object({
  id: z.string(),
  issue_type: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

// e2e fixture の契約テスト (e2e-fixtures-contract.test.ts, bdboard-0rch) から参照するため export する。
export const bdGateListItemSchema = z.object({
  id: z.string(),
  issue_type: z.string().optional(),
  await_type: z.string().optional(),
  description: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

// bd show --json の dependencies[] 各要素。作業チケットをブロックしている open な
// human gate を見つけるために使う (bdboard-vy0h)。dependency_type は 'blocks' 以外にも
// 'discovered-from' / 'related' 等が混在しうるので、'blocks' だけを対象にする。
const bdShowDependencySchema = z.object({
  id: z.string(),
  issue_type: z.string().optional(),
  await_type: z.string().optional(),
  status: z.string().optional(),
  dependency_type: z.string().optional(),
});

// bdboard-vy0h レビュー指摘: dependencies を bdShowItemSchema に厳密な配列型として
// 混ぜると、bd の別コマンド(`bd list --json` の生 dependency レコード等)が将来
// 混入した場合や 1 件でも想定外の形の要素が来た場合に item 全体の safeParse が
// 失敗し、kind 判定まで 'unknown' に道連れで倒れてしまう(=ラベルも gate も一切
// 触らなくなり、この PR が直そうとしているバグより悪化する)。kind 判定は
// issue_type だけに依存させ、dependencies は unknown のまま受け取って要素ごとに
// safeParse する(parseListStdout / parseGateListStdout と同じ「1件の不正で
// 全体を隠さない」方針)。
// metadata は bdboard-mw8y: 作業チケットが自分自身のスタンドアロンな決定待ち
// (metadata.decision_question)を持っているかどうかを判定するために読む。
// dependencies と同じ理由で緩く z.record(z.unknown()) のまま受け取る。
const bdShowItemSchema = z.object({
  issue_type: z.string().optional(),
  dependencies: z.unknown().optional(),
  metadata: z.record(z.unknown()).optional(),
});

// mapListItemToPendingDecision の question 抽出と同じ判定(非空文字列の
// decision_question)。bd gate create --type=human --blocks によって human ラベルが
// 付いたチケットでも、そのチケット自身が独立した decision_question を持つことがある
// (bdboard-v4pl / bdboard-51qb のような実データ)。この場合はラベルがどちらの
// 意味を担っているか区別できないので、gate 側の掃除では剥がさない(bdboard-mw8y)。
function hasOwnDecisionQuestion(metadata: unknown): boolean {
  if (metadata === null || typeof metadata !== 'object') {
    return false;
  }
  const question = (metadata as Record<string, unknown>).decision_question;
  return typeof question === 'string' && question.length > 0;
}

// 作業チケットの dependencies[] のうち、respond() が resolve してよい対象だけを絞り込む。
// 要素ごとに safeParse し、1件でも形が崩れていれば「その要素だけ」スキップする
// (dependencies 全体の形が想定外でも kind 判定には影響させない)。
// - dependency_type === 'blocks': このチケットをブロックしている依存だけ(discovered-from 等を除く)
// - issue_type === 'gate' かつ await_type === 'human': human gate 以外 (timer/gh:run/gh:pr) は絶対に触らない
// - status === 'open': 既に閉じている gate は対象外(冪等な再実行で二重に触らない)
function filterBlockingHumanGateIds(dependencies: unknown): readonly string[] {
  if (!Array.isArray(dependencies)) {
    return [];
  }

  const ids: string[] = [];
  for (const rawDep of dependencies) {
    const depResult = bdShowDependencySchema.safeParse(rawDep);
    if (!depResult.success) {
      continue;
    }
    const dep = depResult.data;
    if (
      dep.dependency_type === 'blocks' &&
      dep.issue_type === 'gate' &&
      dep.await_type === 'human' &&
      dep.status === 'open'
    ) {
      ids.push(dep.id);
    }
  }

  return ids;
}

// bd show <gate-id> --json --include-dependents の item 全体。dependents 以外の
// フィールドはここでは不要なので z.unknown() のまま受け取る(bdShowItemSchema と
// 同じ「壊れた形が kind 判定に波及しない」方針)。
const bdShowWithDependentsItemSchema = z.object({
  dependents: z.unknown().optional(),
});

// gate の dependents[] のうち、respond() がラベルを外してよい対象だけを絞り込む。
// dependents[] の各要素は bdShowDependencySchema と同じ形(id/issue_type/await_type/
// status/dependency_type)で返る(await_type はここでは使わないが、専用スキーマを
// 別に持つと2つのほぼ同じ形を維持する重複になるだけなので再利用する)。要素ごとに
// safeParse し、1件でも形が崩れていれば「その要素だけ」スキップする。
// - dependency_type === 'blocks': この gate がブロックしている依存だけ
// - status !== 'closed': 既に閉じているチケットは対象外(触る意味が無い)。status が
//   無い/未知の値でも「閉じている」と確証が持てない限りは対象に含める(vy0h 側の
//   filterBlockingHumanGateIds がチケットの状態を問わずラベルを外すのと対称)。
// - issue_type !== 'gate': gate 同士の blocks は対象外(human ラベルは work ticket 側の運用)
function filterBlockedTicketIds(dependents: unknown): readonly string[] {
  if (!Array.isArray(dependents)) {
    return [];
  }

  const ids: string[] = [];
  for (const rawDependent of dependents) {
    const result = bdShowDependencySchema.safeParse(rawDependent);
    if (!result.success) {
      continue;
    }
    const dependent = result.data;
    if (
      dependent.dependency_type === 'blocks' &&
      dependent.status !== 'closed' &&
      dependent.issue_type !== 'gate'
    ) {
      ids.push(dependent.id);
    }
  }

  return ids;
}

function buildListArgs(rootPath: string): readonly string[] {
  return [
    '--readonly',
    '-C',
    rootPath,
    'list',
    '-l',
    'human',
    '--json',
    '--limit',
    '0',
    '--no-pager',
  ];
}

function buildGateListArgs(rootPath: string): readonly string[] {
  // bd gate list には --no-pager フラグが無い。
  return ['--readonly', '-C', rootPath, 'gate', 'list', '--json', '--limit', '0'];
}

function buildShowArgs(rootPath: string, issueId: string): readonly string[] {
  return ['--readonly', '-C', rootPath, 'show', issueId, '--json'];
}

// gate が close された直後に、それがブロックしていた work ticket の ID を読み取るための
// show 呼び出し(bdboard-giyt)。--include-dependents を付けたときだけ dependents[] が
// stdout に含まれる(付けない buildShowArgs には含まれない)。
function buildShowWithDependentsArgs(
  rootPath: string,
  issueId: string,
): readonly string[] {
  return ['--readonly', '-C', rootPath, 'show', issueId, '--json', '--include-dependents'];
}

function buildGateResponseCommentBody(responseText: string): string {
  return `Response: ${responseText}`;
}

function buildTicketResponseCommentBody(responseText: string): string {
  return `${buildGateResponseCommentBody(responseText)}

(bdboard: 確認待ちへの回答として記録しました。作業チケットのため close はせず、human ラベルと、
このチケットをブロックしている open な human gate(あれば)を解除します。human 以外の gate
(timer/gh:run/gh:pr)は対象外です。)`;
}

// bdboard-q1k9: 1チケットに独立した質問を表す open な human gate が2件以上ぶら下がって
// いる場合、作業チケット側への1回answerで全部を同じ理由でresolveすると、回答していない
// 質問まで同じ回答で閉じてしまう。安全側に倒し、この場合はどの gate も resolve せず・
// human ラベルも外さない(確認待ちのまま残す)。
function buildTicketAmbiguousGatesResponseCommentBody(
  responseText: string,
  blockingHumanGateIds: readonly string[],
): string {
  const gateList = blockingHumanGateIds.map((id) => `- ${id}`).join('\n');
  return `${buildGateResponseCommentBody(responseText)}

(bdboard: 確認待ちへの回答として記録しましたが、このチケットをブロックしている open な
human gate が${blockingHumanGateIds.length}件あり、どの質問への回答か特定できないため、gate の
resolve と human ラベルの解除は行っていません。確認待ちのまま残ります。以下の gate カードを
個別に開いて、それぞれの質問に回答してください。
${gateList})`;
}

function buildUnknownKindResponseCommentBody(responseText: string): string {
  return `${buildGateResponseCommentBody(responseText)}

(bdboard: 確認待ちへの回答として記録しました。種別(ゲート/作業チケット)を判定できなかったため、
close も human ラベルの解除も行っていません。確認待ちのまま残ります。)`;
}

function buildResponseCommentBody(
  responseText: string,
  kind: ResolvedDecisionKind,
  blockingHumanGateIds: readonly string[] = [],
): string {
  if (kind === 'gate') {
    return buildGateResponseCommentBody(responseText);
  }
  if (kind === 'ticket') {
    return blockingHumanGateIds.length > 1
      ? buildTicketAmbiguousGatesResponseCommentBody(responseText, blockingHumanGateIds)
      : buildTicketResponseCommentBody(responseText);
  }
  return buildUnknownKindResponseCommentBody(responseText);
}

function buildAddResponseCommentArgs(
  rootPath: string,
  issueId: string,
  responseText: string,
  kind: ResolvedDecisionKind,
  blockingHumanGateIds: readonly string[] = [],
): readonly string[] {
  return [
    '-C',
    rootPath,
    'comment',
    issueId,
    buildResponseCommentBody(responseText, kind, blockingHumanGateIds),
  ];
}

function normalizeResponseTextForCloseReason(responseText: string): string {
  // \s だけでは ESC(U+001B) や BS(U+0008) を除去できず、close reason 経由で
  // bd show を端末表示したときにエスケープ注入が起きうる。
  return responseText
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildGateCloseReason(responseText: string): string {
  const normalized = normalizeResponseTextForCloseReason(responseText);
  if (normalized.length === 0) {
    return 'Responded';
  }

  const codePoints = Array.from(normalized);
  const truncated =
    codePoints.length > GATE_CLOSE_REASON_MAX_LEN
      ? `${codePoints.slice(0, GATE_CLOSE_REASON_MAX_LEN).join('')}…`
      : normalized;

  return `Responded: ${truncated}`;
}

function buildCloseRespondedIssueArgs(
  rootPath: string,
  issueId: string,
  responseText: string,
): readonly string[] {
  return [
    '-C',
    rootPath,
    'close',
    issueId,
    '--reason',
    buildGateCloseReason(responseText),
  ];
}

function buildRemoveHumanLabelArgs(
  rootPath: string,
  issueId: string,
): readonly string[] {
  return ['-C', rootPath, 'label', 'remove', issueId, 'human'];
}

// 作業チケットをブロックしている open な human gate を resolve する。
// `bd gate resolve` は `bd close <gate-id>` と等価(gate --help より)だが、
// gate 種別に応じた前提チェック(誤って human 以外を resolve していないか)は
// 呼び出し側(filterBlockingHumanGateIds)で担保する。reason は close/gate 双方で
// 同じ整形(buildGateCloseReason: 制御文字除去 + 200 コードポイント切り詰め)を使う。
function buildGateResolveArgs(
  rootPath: string,
  gateId: string,
  responseText: string,
): readonly string[] {
  return [
    '-C',
    rootPath,
    'gate',
    'resolve',
    gateId,
    '--reason',
    buildGateCloseReason(responseText),
  ];
}

function parseAllowFreeform(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') {
      return true;
    }
    if (normalized === 'false') {
      return false;
    }
  }

  return true;
}

function parseDecisionOptions(
  value: unknown,
): readonly PendingDecisionOption[] | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }

  if (!Array.isArray(parsed)) {
    return undefined;
  }

  const options: PendingDecisionOption[] = [];
  for (const entry of parsed) {
    const result = decisionOptionSchema.safeParse(entry);
    if (result.success) {
      options.push(result.data);
    }
  }

  if (options.length === 0) {
    return undefined;
  }

  return options;
}

function mapListItemToPendingDecision(
  raw: z.infer<typeof bdHumanListItemSchema>,
  kindOverride?: PendingDecisionKind,
): PendingDecision | undefined {
  const metadata = raw.metadata;
  const question =
    metadata !== undefined &&
    typeof metadata.decision_question === 'string' &&
    metadata.decision_question.length > 0
      ? metadata.decision_question
      : undefined;

  const options =
    metadata !== undefined
      ? parseDecisionOptions(metadata.decision_options)
      : undefined;

  const allowFreeform =
    metadata !== undefined
      ? parseAllowFreeform(metadata.decision_allow_freeform)
      : true;

  const kind =
    kindOverride ??
    (raw.issue_type === 'gate' ? 'gate' : 'ticket');

  return {
    id: raw.id,
    kind,
    ...(question !== undefined ? { question } : {}),
    ...(options !== undefined ? { options } : {}),
    allowFreeform,
  };
}

interface ShowKindAndBlockingGates {
  readonly kind: ResolvedDecisionKind;
  readonly blockingHumanGateIds: readonly string[];
  /**
   * kind === 'ticket' のときだけ意味を持つ。このチケット自身が standalone な
   * decision_question(metadata.decision_question)を持っているかどうか(bdboard-mw8y)。
   * gate 側の掃除(respond() の kind === 'gate' 分岐)が、このチケット自身の未回答の
   * 質問を巻き込んで human ラベルを剥がさないようにするために使う。
   */
  readonly hasOwnDecisionQuestion: boolean;
}

// `bd show <id> --json` の stdout から種別(gate/ticket/unknown)と、作業チケットの場合に
// それをブロックしている open な human gate の ID 一覧を読み取る (bdboard-vy0h)。
// kind の判定は issue_type だけを見る従来の parseShowStdoutForKind と完全に同じであり、
// dependencies の形が想定外でも kind 判定には影響しない(filterBlockingHumanGateIds が
// 要素ごとに safeParse するため。壊れた/想定外の stdout は常に 'unknown' に倒す fail-safe)。
function parseShowStdout(stdout: string): ShowKindAndBlockingGates {
  const trimmedStdout = stdout.trim();
  if (trimmedStdout.length === 0) {
    return { kind: 'unknown', blockingHumanGateIds: [], hasOwnDecisionQuestion: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmedStdout) as unknown;
  } catch {
    return { kind: 'unknown', blockingHumanGateIds: [], hasOwnDecisionQuestion: false };
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { kind: 'unknown', blockingHumanGateIds: [], hasOwnDecisionQuestion: false };
  }

  const itemResult = bdShowItemSchema.safeParse(parsed[0]);
  if (!itemResult.success) {
    return { kind: 'unknown', blockingHumanGateIds: [], hasOwnDecisionQuestion: false };
  }

  const kind = itemResult.data.issue_type === 'gate' ? 'gate' : 'ticket';
  const blockingHumanGateIds =
    kind === 'ticket' ? filterBlockingHumanGateIds(itemResult.data.dependencies) : [];

  return {
    kind,
    blockingHumanGateIds,
    hasOwnDecisionQuestion:
      kind === 'ticket' ? hasOwnDecisionQuestion(itemResult.data.metadata) : false,
  };
}

// bdboard-xgvh レビュー指摘で追加されたテストが直接参照する。fail-safe の中核(gate と
// 判定できたときだけ close する)なので kind 判定だけを取り出す薄いラッパーとして残す。
function parseShowStdoutForKind(stdout: string): ResolvedDecisionKind {
  return parseShowStdout(stdout).kind;
}

function parseListStdout(stdout: string): readonly PendingDecision[] {
  const trimmedStdout = stdout.trim();
  if (trimmedStdout.length === 0) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmedStdout) as unknown;
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  const decisions: PendingDecision[] = [];
  for (const rawItem of parsed) {
    const itemResult = bdHumanListItemSchema.safeParse(rawItem);
    if (!itemResult.success) {
      // Skip only the malformed entry so one bad ticket doesn't hide the rest.
      continue;
    }

    const mapped = mapListItemToPendingDecision(itemResult.data);
    if (mapped !== undefined) {
      decisions.push(mapped);
    }
  }

  return decisions;
}

function parseGateListStdout(stdout: string): readonly PendingDecision[] {
  const trimmedStdout = stdout.trim();
  if (trimmedStdout.length === 0) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmedStdout) as unknown;
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  const decisions: PendingDecision[] = [];
  for (const rawItem of parsed) {
    const itemResult = bdGateListItemSchema.safeParse(rawItem);
    if (!itemResult.success) {
      // Skip only the malformed entry so one bad gate doesn't hide the rest.
      continue;
    }

    const { issue_type, await_type } = itemResult.data;
    if (issue_type !== 'gate' || await_type !== 'human') {
      continue;
    }

    const mapped = mapListItemToPendingDecision(itemResult.data, 'gate');
    if (mapped !== undefined) {
      decisions.push(mapped);
    }
  }

  return decisions;
}

function mergePendingDecisions(
  labelDecisions: readonly PendingDecision[],
  gateDecisions: readonly PendingDecision[],
): readonly PendingDecision[] {
  const byId = new Map<string, PendingDecision>();
  const labelOrder: string[] = [];

  for (const decision of labelDecisions) {
    byId.set(decision.id, decision);
    labelOrder.push(decision.id);
  }

  const newGateIds: string[] = [];
  for (const gate of gateDecisions) {
    const existing = byId.get(gate.id);
    if (existing !== undefined) {
      // metadata を持っている label 由来の question/options/allowFreeform を保ちつつ
      // kind だけ gate に上書きする。
      byId.set(gate.id, { ...existing, kind: 'gate' });
    } else {
      byId.set(gate.id, gate);
      newGateIds.push(gate.id);
    }
  }

  const merged: PendingDecision[] = [];
  for (const id of labelOrder) {
    const decision = byId.get(id);
    if (decision !== undefined) {
      merged.push(decision);
    }
  }
  for (const id of newGateIds) {
    const decision = byId.get(id);
    if (decision !== undefined) {
      merged.push(decision);
    }
  }

  return merged;
}

async function runBdCommandOrThrow(
  commandRunner: CommandRunner,
  bdPath: string,
  args: readonly string[],
  timeoutMs: number,
  errorContext: string,
): Promise<{ stdout: string; stderr: string }> {
  const result = await withLockContentionRetry(async () => {
    const commandResult = await commandRunner.run(bdPath, args, { timeoutMs });

    if (commandResult.exitCode !== 0) {
      const combined = `${commandResult.stdout}\n${commandResult.stderr}`.toLowerCase();
      const kind = classifyBdError(commandResult.exitCode, combined);
      throw new BdError(
        kind,
        errorContext,
        combined.trim() || `exit code ${commandResult.exitCode}`,
      );
    }

    return commandResult;
  });

  return result;
}

async function resolveKindAndBlockingGates(
  commandRunner: CommandRunner,
  bdPath: string,
  rootPath: string,
  issueId: string,
): Promise<ShowKindAndBlockingGates> {
  try {
    const result = await withLockContentionRetry(
      async () => {
        const commandResult = await commandRunner.run(
          bdPath,
          buildShowArgs(rootPath, issueId),
          { timeoutMs: KIND_PROBE_TIMEOUT_MS },
        );

        if (commandResult.exitCode !== 0) {
          const combined = `${commandResult.stdout}\n${commandResult.stderr}`.toLowerCase();
          const errorKind = classifyBdError(commandResult.exitCode, combined);
          if (errorKind === 'lock-contention') {
            throw new BdError(
              errorKind,
              issueId,
              combined.trim() || `exit code ${commandResult.exitCode}`,
            );
          }
          return null;
        }

        return commandResult;
      },
      { retries: 0 },
    );

    if (result === null) {
      return { kind: 'unknown', blockingHumanGateIds: [], hasOwnDecisionQuestion: false };
    }

    return parseShowStdout(result.stdout);
  } catch {
    return { kind: 'unknown', blockingHumanGateIds: [], hasOwnDecisionQuestion: false };
  }
}

// bd show <gate-id> --json --include-dependents の stdout から、この gate がブロック
// している open な work ticket の ID 一覧を読み取る(bdboard-giyt)。壊れた/想定外の
// stdout は空配列にフォールバックする(呼び出し側 resolveGateBlockedTicketIds が
// fail-soft で扱う)。
function parseShowWithDependentsStdout(stdout: string): readonly string[] {
  const trimmedStdout = stdout.trim();
  if (trimmedStdout.length === 0) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmedStdout) as unknown;
  } catch {
    return [];
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    return [];
  }

  const itemResult = bdShowWithDependentsItemSchema.safeParse(parsed[0]);
  if (!itemResult.success) {
    return [];
  }

  return filterBlockedTicketIds(itemResult.data.dependents);
}

// gate が close された直後に、それがブロックしていた work ticket の ID を読み取る
// (bdboard-giyt)。失敗しても gate の close 自体は既に成功しているので例外を投げず
// 空配列にフォールバックする(fail-soft) — ここで取りこぼしても、そのチケットへ
// 直接回答したときに filterBlockingHumanGateIds が既に閉じた gate を除外するので、
// human ラベルは既存の間接回復パス(bdboard-vy0h のレビューコメント参照)で自己修復する。
async function resolveGateBlockedTicketIds(
  commandRunner: CommandRunner,
  bdPath: string,
  rootPath: string,
  gateId: string,
): Promise<readonly string[]> {
  try {
    const result = await withLockContentionRetry(
      async () => {
        const commandResult = await commandRunner.run(
          bdPath,
          buildShowWithDependentsArgs(rootPath, gateId),
          { timeoutMs: KIND_PROBE_TIMEOUT_MS },
        );

        if (commandResult.exitCode !== 0) {
          return null;
        }

        return commandResult;
      },
      { retries: 0 },
    );

    if (result === null) {
      return [];
    }

    return parseShowWithDependentsStdout(result.stdout);
  } catch {
    return [];
  }
}

// テストと外部呼び出しが従来の「kind だけ返す」契約に依存しているため薄いラッパーとして残す。
async function resolveKind(
  commandRunner: CommandRunner,
  bdPath: string,
  rootPath: string,
  issueId: string,
): Promise<ResolvedDecisionKind> {
  const result = await resolveKindAndBlockingGates(commandRunner, bdPath, rootPath, issueId);
  return result.kind;
}

export function createBdCliHumanDecisions(
  commandRunner: CommandRunner,
  options?: BdCliHumanDecisionsOptions,
): HumanDecisionsPort {
  const bdPath = options?.bdPath ?? DEFAULT_BD_PATH;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    // bd list --readonly は読み取り専用でべき等なので、lock-contention なら
    // 数回まで自動リトライしてよい(bdboard-3tj)。respond() 側の bd comment /
    // bd close / bd label remove はどちらも書き込みで、特に comment は追記系で
    // べき等ではないため(二重投稿のリスク)意図的にリトライ対象から外している。
    //
    // gate bead は human ラベルを持たず await_type: 'human' を持つため、
    // `bd list -l human` だけでは取れない。追加で `bd gate list` を呼ぶ(bdboard-bh48)。
    // gate list の失敗を握りつぶすと ticket 分だけ返り gate が無言で消える —
    // refresh-projects は例外を catch してキャッシュ + errors にフォールバックする設計なので、
    // ここでは fail-soft にせず BdError を throw する。
    async listPendingDecisions(rootPath: string): Promise<readonly PendingDecision[]> {
      const labelResult = await runBdCommandOrThrow(
        commandRunner,
        bdPath,
        buildListArgs(rootPath),
        timeoutMs,
        rootPath,
      );
      const gateResult = await runBdCommandOrThrow(
        commandRunner,
        bdPath,
        buildGateListArgs(rootPath),
        timeoutMs,
        rootPath,
      );

      const labelDecisions = parseListStdout(labelResult.stdout);
      const gateDecisions = parseGateListStdout(gateResult.stdout);
      return mergePendingDecisions(labelDecisions, gateDecisions);
    },

    // NOTE(bdboard-3tj): 以下の respond() はリトライ非対応のまま。bd comment は
    // 追記系で呼ぶたびに新しいコメントが増えるためべき等ではなく、bd close も
    // bd label remove も直前の comment 呼び出しとの一貫性のため非リトライにしている
    // (label remove は冪等だが、comment 二重投稿のリスクを避ける)。lock-contention
    // 時にここで自動リトライすると二重実行のリスクがある。手動リトライ(呼び出し元
    // での再実行)に委ねる。
    // bdboard-07d: bd-m7zzd's needsStoreHumanSubcommands exception to
    // noDbCommands regressed between beads v1.2.1 and v1.2.2. Avoid `human
    // respond` until upstream keeps that fix.
    async respond(
      rootPath: string,
      issueId: string,
      responseText: string,
    ): Promise<RespondOutcome> {
      const { kind, blockingHumanGateIds } = await resolveKindAndBlockingGates(
        commandRunner,
        bdPath,
        rootPath,
        issueId,
      );

      // bdboard-q1k9: 独立した質問を表す open な human gate が2件以上あると、
      // 1つの回答テキストで全部を resolve してしまうと回答していない質問まで
      // 閉じてしまう。この場合はコメントの文面を変え、どの gate も resolve せず・
      // human ラベルも外さない(下の分岐で resolvedGateIds は返さず ambiguousGateIds を返す)。
      const isAmbiguousTicketAnswer = kind === 'ticket' && blockingHumanGateIds.length > 1;

      const commentResult = await commandRunner.run(
        bdPath,
        buildAddResponseCommentArgs(rootPath, issueId, responseText, kind, blockingHumanGateIds),
        { timeoutMs },
      );

      if (commentResult.exitCode !== 0) {
        const combined = `${commentResult.stdout}\n${commentResult.stderr}`.toLowerCase();
        const errorKind = classifyBdError(commentResult.exitCode, combined);
        throw new BdError(
          errorKind,
          issueId,
          combined.trim() || `exit code ${commentResult.exitCode}`,
        );
      }

      if (kind === 'gate') {
        const closeResult = await commandRunner.run(
          bdPath,
          buildCloseRespondedIssueArgs(rootPath, issueId, responseText),
          { timeoutMs },
        );

        if (closeResult.exitCode !== 0) {
          const combined = `${closeResult.stdout}\n${closeResult.stderr}`.toLowerCase();
          const errorKind = classifyBdError(closeResult.exitCode, combined);
          throw new BdError(
            errorKind,
            issueId,
            combined.trim() || `exit code ${closeResult.exitCode}`,
          );
        }

        // bdboard-giyt: bdboard-vy0h の逆方向。この gate が直接ブロックしていた
        // work ticket のうち、他に open な human gate が残っていない かつ
        // そのチケット自身が standalone な decision_question を持っていないものだけ
        // human ラベルを外す(兄弟 gate が残っているうちはそのチケットはまだ
        // 確認待ちなので触らない。bdboard-mw8y: standalone な decision_question を
        // 持つチケットは、たまたま無関係な human gate にもブロックされていた場合、
        // その gate への回答でチケット自身の未回答の質問まで確認待ちレーンから
        // 消えてしまう — この場合はここで剥がさず、そのチケット自身への回答時に
        // filterBlockingHumanGateIds 経由で既に閉じたこの gate が除外されて
        // 自己修復する)。gate の close 自体は既に成功しているので、
        // ここから先は fail-soft — 個々のチケットで読み取りやラベル解除に失敗
        // しても、そのチケットだけスキップして次へ進む。
        const blockedTicketIds = await resolveGateBlockedTicketIds(
          commandRunner,
          bdPath,
          rootPath,
          issueId,
        );
        const clearedHumanLabelTicketIds: string[] = [];
        for (const ticketId of blockedTicketIds) {
          try {
            const ticketState = await resolveKindAndBlockingGates(
              commandRunner,
              bdPath,
              rootPath,
              ticketId,
            );
            if (
              ticketState.kind !== 'ticket' ||
              ticketState.blockingHumanGateIds.length > 0 ||
              ticketState.hasOwnDecisionQuestion
            ) {
              continue;
            }

            const labelResult = await commandRunner.run(
              bdPath,
              buildRemoveHumanLabelArgs(rootPath, ticketId),
              { timeoutMs },
            );
            if (labelResult.exitCode === 0) {
              clearedHumanLabelTicketIds.push(ticketId);
            }
          } catch {
            // fail-soft: このチケットはスキップする。直接そのチケットへ回答すれば
            // filterBlockingHumanGateIds が既に閉じたこの gate を除外するので、
            // 既存の間接回復パスで自己修復する。
          }
        }

        return {
          kind,
          closed: true,
          ...(clearedHumanLabelTicketIds.length > 0 ? { clearedHumanLabelTicketIds } : {}),
        };
      } else if (kind === 'ticket') {
        if (isAmbiguousTicketAnswer) {
          return { kind, closed: false, ambiguousGateIds: blockingHumanGateIds };
        }

        // ブロックしている human gate を先に resolve してから human ラベルを外す。
        // 逆順(先にラベルだけ外す)だと、gate resolve が失敗したときに「確認待ち
        // レーンから消えたのに実は bd ready からブロックされたまま」という、
        // まさにこのチケット(bdboard-vy0h)の元バグと同じ形の中途半端な状態が
        // 残ってしまう。filterBlockingHumanGateIds が human/open/blocks だけに
        // 絞っているので、ここで timer/gh:run/gh:pr 等の gate を誤って resolve
        // することはない。isAmbiguousTicketAnswer で 2 件以上は上で早期 return
        // しているので、ここに来る時点で blockingHumanGateIds は高々 1 件。
        const resolvedGateIds: string[] = [];
        for (const gateId of blockingHumanGateIds) {
          const gateResolveResult = await commandRunner.run(
            bdPath,
            buildGateResolveArgs(rootPath, gateId, responseText),
            { timeoutMs },
          );

          if (gateResolveResult.exitCode !== 0) {
            const combined =
              `${gateResolveResult.stdout}\n${gateResolveResult.stderr}`.toLowerCase();
            const errorKind = classifyBdError(gateResolveResult.exitCode, combined);
            // fail-safe: 一部の gate だけ resolve できてラベルは剥がれていない状態で
            // throw する。「ラベル解除だけ成功して gate が残った」を成功として
            // 返さない(呼び出し元は human ラベルが付いたまま = 確認待ちのまま、と
            // 見なせる)。
            throw new BdError(
              errorKind,
              gateId,
              combined.trim() || `exit code ${gateResolveResult.exitCode}`,
            );
          }

          resolvedGateIds.push(gateId);
        }

        const labelResult = await commandRunner.run(
          bdPath,
          buildRemoveHumanLabelArgs(rootPath, issueId),
          { timeoutMs },
        );

        if (labelResult.exitCode !== 0) {
          const combined = `${labelResult.stdout}\n${labelResult.stderr}`.toLowerCase();
          const errorKind = classifyBdError(labelResult.exitCode, combined);
          throw new BdError(
            errorKind,
            issueId,
            combined.trim() || `exit code ${labelResult.exitCode}`,
          );
        }

        return { kind, closed: false, resolvedGateIds };
      }
      // kind === 'unknown': 迷ったら閉じないだけでなく、human ラベルも剥がさない。
      // 回答コメントだけ残し確認待ちのままにする(fail-safe)。

      return { kind, closed: false };
    },
  };
}

// Exported for unit tests. parseShowStdoutForKind は fail-safe の中核 (gate と判定
// できたときだけ close する) なので、respond() 経由の結合テストだけでなく分岐を直接
// 押さえる (bdboard-xgvh レビュー指摘)。
export {
  buildGateCloseReason,
  buildResponseCommentBody,
  buildTicketAmbiguousGatesResponseCommentBody,
  buildTicketResponseCommentBody,
  buildUnknownKindResponseCommentBody,
  parseShowStdoutForKind,
  parseShowWithDependentsStdout,
  resolveGateBlockedTicketIds,
  resolveKind,
  resolveKindAndBlockingGates,
};
