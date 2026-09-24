// bd-cli-human-decisions.ts (bdboard-sso1.16) の分割で切り出した、gate/ticket の種別
// (kind)判定と bd CLI コマンド実行の共通基盤。read.ts (pending decisions の読み取り) /
// respond.ts (gate 回答の解決と書き込み) / labels.ts (human ラベルの掃除) の3モジュールが
// ここへ依存する一方向の関係にし、循環 import を避けている。挙動・型は分割前と同一(移動のみ)。
import { z } from 'zod';
import type { CommandRunner } from '../../../application/ports/command-runner.js';
import type { ResolvedDecisionKind } from '../../../application/ports/human-decisions.js';
import { BdError } from '../../../application/ports/issue-repository.js';
import { classifyBdError } from '../classify-bd-error.js';
import { withLockContentionRetry } from '../bd-retry.js';

// resolveKind は fail-safe の読み取りプローブなので長く粘る必要がない。
// 既定の lock-contention リトライ込みだと最悪 ~91s かかるが、5s + リトライなしで足りる。
export const KIND_PROBE_TIMEOUT_MS = 5_000;

// bd show --json の dependencies[] 各要素。作業チケットをブロックしている open な
// human gate を見つけるために使う (bdboard-vy0h)。dependency_type は 'blocks' 以外にも
// 'discovered-from' / 'related' 等が混在しうるので、'blocks' だけを対象にする。
export const bdShowDependencySchema = z.object({
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
// dependencies と同じ理由(直上のコメント参照)で z.unknown() のまま受け取る —
// z.record(z.unknown()) は一見緩そうだが、値が object リテラルであることまで
// 要求するため metadata: null 等で item 全体の safeParse を失敗させ、
// dependencies が避けている「1件の不正で kind 判定まで道連れにする」失敗モードを
// このフィールドだけ再導入してしまう(opus レビュー指摘, PR #517)。型の妥当性は
// 呼び出し側の hasOwnDecisionQuestion() が typeof で自前チェックする。
const bdShowItemSchema = z.object({
  issue_type: z.string().optional(),
  dependencies: z.unknown().optional(),
  metadata: z.unknown().optional(),
});

// mapListItemToPendingDecision の question 抽出と同じ判定(非空文字列の
// decision_question)。true は「このチケットは decision_question を記録している」
// ことだけを意味し、その質問がまだ未回答かどうかまでは保証しない(respond() は
// decision_question を消す経路を持たないため、一度回答済みでも残り続けうる —
// opus レビュー指摘, PR #517)。bd gate create --type=human --blocks によって
// human ラベルが付いたチケットでも、そのチケット自身が独立した decision_question を
// 持つことがある(実データにこの形自体は存在する。この場合はラベルがどちらの
// 意味を担っているか区別できないので、gate 側の掃除では安全側に倒して剥がさない
// (bdboard-mw8y))。
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

function buildShowArgs(rootPath: string, issueId: string): readonly string[] {
  return ['--readonly', '-C', rootPath, 'show', issueId, '--json'];
}

interface ShowKindAndBlockingGates {
  readonly kind: ResolvedDecisionKind;
  readonly blockingHumanGateIds: readonly string[];
  /**
   * kind === 'ticket' のときだけ意味を持つ。このチケット自身が standalone な
   * decision_question(metadata.decision_question)を持っているかどうか(bdboard-mw8y)。
   * 2箇所で使う: (1) gate 側respond()の掃除(clearHumanLabelOnUnblockedTickets)が、
   * このチケット自身の未回答の質問を巻き込んで human ラベルを剥がさないようにするため
   * (bdboard-mw8y)。(2) ticket 側respond()が、このチケット自身の質問と、ちょうど1件の
   * blocking human gate の質問のどちらへの回答か特定できない場合に ambiguous 扱いにする
   * ため(bdboard-cine)。
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
export function parseShowStdoutForKind(stdout: string): ResolvedDecisionKind {
  return parseShowStdout(stdout).kind;
}

export async function runBdCommandOrThrow(
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

export async function resolveKindAndBlockingGates(
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

// テストと外部呼び出しが従来の「kind だけ返す」契約に依存しているため薄いラッパーとして残す。
export async function resolveKind(
  commandRunner: CommandRunner,
  bdPath: string,
  rootPath: string,
  issueId: string,
): Promise<ResolvedDecisionKind> {
  const result = await resolveKindAndBlockingGates(commandRunner, bdPath, rootPath, issueId);
  return result.kind;
}
