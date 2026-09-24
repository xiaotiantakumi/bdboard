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

// bdboard-cine: T 自身が standalone な decision_question(metadata.decision_question)を
// 持っているのに、T をブロックする open な human gate も1件以上ある場合、この回答が
// 「T自身の質問への回答」なのか「gate の質問への回答」なのか respond() 側では特定できない。
// bdboard-q1k9(2件以上の gate で ambiguous にする分岐)と同じ安全側の方針で、gate は
// resolve せず・human ラベルも外さない。回答自体は T 自身の質問への回答としてコメントに
// 記録する。
export function buildTicketOwnQuestionAmbiguousResponseCommentBody(
  responseText: string,
  blockingHumanGateIds: readonly string[],
): string {
  const gateList = blockingHumanGateIds.map((id) => `- ${id}`).join('\n');
  return `${buildGateResponseCommentBody(responseText)}

(bdboard: このチケット自身の確認待ちの質問への回答として記録しました。このチケットは同時に、
別の質問を表している可能性がある open な human gate にもブロックされているため、その gate の
resolve と human ラベルの解除は行っていません。確認待ちのまま残ります。以下の gate カードを
個別に開いて、それぞれの質問に回答してください。gate に回答した後もこのチケットが確認待ちの
まま残っている場合は、このチケットにもう一度回答してください(このチケット自身が
decision_question を持つ限り、gate 側の自動掃除はこのチケットの human ラベルを外しません)。
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
  hasOwnDecisionQuestion = false,
): string {
  if (kind === 'gate') {
    return buildGateResponseCommentBody(responseText);
  }
  if (kind === 'ticket') {
    if (blockingHumanGateIds.length > 1) {
      return buildTicketAmbiguousGatesResponseCommentBody(responseText, blockingHumanGateIds);
    }
    if (hasOwnDecisionQuestion && blockingHumanGateIds.length >= 1) {
      return buildTicketOwnQuestionAmbiguousResponseCommentBody(responseText, blockingHumanGateIds);
    }
    return buildTicketResponseCommentBody(responseText);
  }
  return buildUnknownKindResponseCommentBody(responseText);
}

export function buildAddResponseCommentArgs(
  rootPath: string,
  issueId: string,
  responseText: string,
  kind: ResolvedDecisionKind,
  blockingHumanGateIds: readonly string[] = [],
  hasOwnDecisionQuestion = false,
): readonly string[] {
  return [
    '-C',
    rootPath,
    'comment',
    issueId,
    buildResponseCommentBody(responseText, kind, blockingHumanGateIds, hasOwnDecisionQuestion),
  ];
}
