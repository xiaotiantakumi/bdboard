// bd-cli-human-decisions.ts (bdboard-sso1.16) の分割で切り出した、respond() が bd
// comment に書き込む本文の組み立て担当。respond.ts からだけ使う内部モジュール。
// 挙動・型は分割前と同一(移動のみ)。
import type { ResolvedDecisionKind } from '../../../application/ports/human-decisions.js';

function buildGateResponseCommentBody(responseText: string): string {
  return `Response: ${responseText}`;
}

export function buildTicketResponseCommentBody(responseText: string): string {
  return `${buildGateResponseCommentBody(responseText)}

(bdboard: 確認待ちへの回答として記録しました。作業チケットのため close はせず、human ラベルと、
このチケットをブロックしている open な human gate(あれば)を解除します。human 以外の gate
(timer/gh:run/gh:pr)は対象外です。)`;
}

// bdboard-q1k9: 1チケットに独立した質問を表す open な human gate が2件以上ぶら下がって
// いる場合、作業チケット側への1回answerで全部を同じ理由でresolveすると、回答していない
// 質問まで同じ回答で閉じてしまう。安全側に倒し、この場合はどの gate も resolve せず・
// human ラベルも外さない(確認待ちのまま残す)。
export function buildTicketAmbiguousGatesResponseCommentBody(
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

export function buildUnknownKindResponseCommentBody(responseText: string): string {
  return `${buildGateResponseCommentBody(responseText)}

(bdboard: 確認待ちへの回答として記録しました。種別(ゲート/作業チケット)を判定できなかったため、
close も human ラベルの解除も行っていません。確認待ちのまま残ります。)`;
}

export function buildResponseCommentBody(
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

export function buildAddResponseCommentArgs(
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
