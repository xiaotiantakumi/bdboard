// bd-cli-human-decisions.ts (bdboard-sso1.16) の分割で切り出した、gate 解決/回答に伴う
// human ラベルの掃除担当。挙動・型は分割前と同一(移動のみ)。
import { z } from 'zod';
import type { CommandRunner } from '../../../application/ports/command-runner.js';
import { withLockContentionRetry } from '../bd-retry.js';
import { bdShowDependencySchema, KIND_PROBE_TIMEOUT_MS, resolveKindAndBlockingGates } from './shared.js';

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

// gate が close された直後に、それがブロックしていた work ticket の ID を読み取るための
// show 呼び出し(bdboard-giyt)。--include-dependents を付けたときだけ dependents[] が
// stdout に含まれる(付けない buildShowArgs には含まれない)。
function buildShowWithDependentsArgs(
  rootPath: string,
  issueId: string,
): readonly string[] {
  return ['--readonly', '-C', rootPath, 'show', issueId, '--json', '--include-dependents'];
}

export function buildRemoveHumanLabelArgs(
  rootPath: string,
  issueId: string,
): readonly string[] {
  return ['-C', rootPath, 'label', 'remove', issueId, 'human'];
}

// bd show <gate-id> --json --include-dependents の stdout から、この gate がブロック
// している open な work ticket の ID 一覧を読み取る(bdboard-giyt)。壊れた/想定外の
// stdout は空配列にフォールバックする(呼び出し側 resolveGateBlockedTicketIds が
// fail-soft で扱う)。
export function parseShowWithDependentsStdout(stdout: string): readonly string[] {
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
export async function resolveGateBlockedTicketIds(
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

// bdboard-giyt(gate 側respond())と bdboard-ixx9(ticket 側respond())の両方が使う
// 共通の fail-soft 清掃ループ。渡された各チケットについて、他に open な human gate が
// 残っていない かつ standalone な decision_question を記録していない(bdboard-mw8y)
// ものだけ human ラベルを外す。対象チケットが実際に human ラベルを持っている場合だけ
// 外す(bdboard-ld8d)。呼び出し時点でこのラベル解除の前提となる主処理
// (gate の close、または ticket 自身の gate resolve + ラベル解除)は既に成功して
// いるので、個々のチケットでの読み取り・ラベル解除の失敗はそのチケットだけスキップして
// 次へ進む(gate/ticket 側の既存コメントと同じ fail-soft 方針)。
export async function clearHumanLabelOnUnblockedTickets(
  commandRunner: CommandRunner,
  bdPath: string,
  rootPath: string,
  timeoutMs: number,
  ticketIds: readonly string[],
): Promise<readonly string[]> {
  const clearedHumanLabelTicketIds: string[] = [];
  for (const ticketId of ticketIds) {
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
        ticketState.hasOwnDecisionQuestion ||
        !ticketState.hasHumanLabel
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
  return clearedHumanLabelTicketIds;
}
