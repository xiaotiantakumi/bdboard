// bd-cli-human-decisions.ts (bdboard-sso1.16) の分割で切り出した、gate/ticket への回答
// (comment 追記・gate の close または resolve・human ラベル解除)の書き込み担当。
// respond は元は createBdCliHumanDecisions() が返すオブジェクトのメソッドで
// commandRunner/bdPath/timeoutMs をクロージャで捕捉していたが、モジュール分割にあたり
// それらを明示引数に変えただけで本体のロジックは1文字も変えていない(入口の
// createBdCliHumanDecisions は bd-cli-human-decisions.ts に残し、ここへ委譲する)。
// コメント本文の組み立ては ./respond-comment.ts、close/gate resolve の引数組み立ては
// ./respond-args.ts へ委譲する(このファイルだけで 200 行の上限を超えるため)。
import type { CommandRunner } from '../../../application/ports/command-runner.js';
import type { RespondOutcome } from '../../../application/ports/human-decisions.js';
import { BdError } from '../../../application/ports/issue-repository.js';
import { classifyBdError } from '../classify-bd-error.js';
import { resolveKindAndBlockingGates } from './shared.js';
import {
  buildRemoveHumanLabelArgs,
  clearHumanLabelOnUnblockedTickets,
  resolveGateBlockedTicketIds,
} from './labels.js';
import { buildAddResponseCommentArgs } from './respond-comment.js';
import { buildCloseRespondedIssueArgs, buildGateResolveArgs } from './respond-args.js';

// NOTE(bdboard-3tj): 以下の respond() はリトライ非対応のまま。bd comment は
// 追記系で呼ぶたびに新しいコメントが増えるためべき等ではなく、bd close も
// bd label remove も直前の comment 呼び出しとの一貫性のため非リトライにしている
// (label remove は冪等だが、comment 二重投稿のリスクを避ける)。lock-contention
// 時にここで自動リトライすると二重実行のリスクがある。手動リトライ(呼び出し元
// での再実行)に委ねる。
// bdboard-07d: bd-m7zzd's needsStoreHumanSubcommands exception to
// noDbCommands regressed between beads v1.2.1 and v1.2.2. Avoid `human
// respond` until upstream keeps that fix.
export async function respond(
  commandRunner: CommandRunner,
  bdPath: string,
  timeoutMs: number,
  rootPath: string,
  issueId: string,
  responseText: string,
): Promise<RespondOutcome> {
  const { kind, blockingHumanGateIds, hasOwnDecisionQuestion } = await resolveKindAndBlockingGates(
    commandRunner,
    bdPath,
    rootPath,
    issueId,
  );

  // bdboard-q1k9: 独立した質問を表す open な human gate が2件以上あると、
  // 1つの回答テキストで全部を resolve してしまうと回答していない質問まで
  // 閉じてしまう。この場合はコメントの文面を変え、どの gate も resolve せず・
  // human ラベルも外さない(下の分岐で resolvedGateIds は返さず ambiguousGateIds を返す)。
  // bdboard-cine: T 自身が standalone な decision_question を持っている場合、T の blocking
  // human gate が1件でも「その1件への回答」と「T自身の質問への回答」のどちらのつもりかが
  // 特定できない。安全側に倒し、この組み合わせも ambiguous 扱いにして gate を自動 resolve
  // しない(T 自身の質問への回答としてコメントには記録するが、gate 側は個別に回答してもらう)。
  const isAmbiguousTicketAnswer =
    kind === 'ticket' &&
    (blockingHumanGateIds.length > 1 ||
      (hasOwnDecisionQuestion && blockingHumanGateIds.length >= 1));

  const commentResult = await commandRunner.run(
    bdPath,
    buildAddResponseCommentArgs(
      rootPath,
      issueId,
      responseText,
      kind,
      blockingHumanGateIds,
      hasOwnDecisionQuestion,
    ),
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
    // work ticket のうち、他に何もブロックしていないものだけ human ラベルを外す。
    // 判定条件(他の open human gate なし かつ standalone な decision_question も
    // 記録していない)は clearHumanLabelOnUnblockedTickets のコメント参照
    // (bdboard-mw8y)。gate の close 自体は既に成功しているので、清掃の失敗を
    // 理由に respond() 全体を失敗させない(fail-soft、同関数内)。
    const blockedTicketIds = await resolveGateBlockedTicketIds(
      commandRunner,
      bdPath,
      rootPath,
      issueId,
    );
    const clearedHumanLabelTicketIds = await clearHumanLabelOnUnblockedTickets(
      commandRunner,
      bdPath,
      rootPath,
      timeoutMs,
      blockedTicketIds,
    );

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
    // することはない。isAmbiguousTicketAnswer(2件以上、または own decision_question
    // ありで1件以上、bdboard-cine)で該当するケースは上で早期 return しているので、
    // ここに来る時点で blockingHumanGateIds は高々 1 件かつ hasOwnDecisionQuestion は false。
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

    // bdboard-ixx9: bdboard-giyt の逆方向(gate 側respond()の兄弟チケット清掃)の
    // 抜け。ticket→gate 方向で gate を resolve したとき、同じ gate が他のチケット
    // もブロックしていれば(1つの Gate: human が複数チケットを blocks する形。
    // bd dep add で作れる)、その兄弟チケットの human ラベルは(bdboard-vy0h以来)
    // 何もチェックされず残ったままだった。resolvedGateIds は上の
    // isAmbiguousTicketAnswer 早期 return により高々1件なので、ここは実質
    // 0〜1回のループ。gate の resolve と自分自身のラベル解除は既に成功して
    // いるので、ここから先は gate 側と同じ fail-soft
    // (clearHumanLabelOnUnblockedTickets 内)。
    const siblingTicketIds: string[] = [];
    for (const resolvedGateId of resolvedGateIds) {
      const blockedByGate = await resolveGateBlockedTicketIds(
        commandRunner,
        bdPath,
        rootPath,
        resolvedGateId,
      );
      for (const blockedTicketId of blockedByGate) {
        if (blockedTicketId !== issueId && !siblingTicketIds.includes(blockedTicketId)) {
          siblingTicketIds.push(blockedTicketId);
        }
      }
    }
    const clearedHumanLabelTicketIds = await clearHumanLabelOnUnblockedTickets(
      commandRunner,
      bdPath,
      rootPath,
      timeoutMs,
      siblingTicketIds,
    );

    return {
      kind,
      closed: false,
      resolvedGateIds,
      ...(clearedHumanLabelTicketIds.length > 0 ? { clearedHumanLabelTicketIds } : {}),
    };
  }
  // kind === 'unknown': 迷ったら閉じないだけでなく、human ラベルも剥がさない。
  // 回答コメントだけ残し確認待ちのままにする(fail-safe)。

  return { kind, closed: false };
}
