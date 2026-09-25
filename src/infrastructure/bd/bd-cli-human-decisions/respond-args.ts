// bd-cli-human-decisions.ts (bdboard-sso1.16) の分割で切り出した、respond() が
// close/gate resolve に使う bd CLI 引数の組み立て担当。respond.ts からだけ使う
// 内部モジュール。分割時点の挙動・型は分割前と同一(移動のみ)だったが、
// buildUnsetOwnDecisionMetadataArgs (bdboard-rftd) はこのファイルへの新規追加。

function normalizeResponseTextForCloseReason(responseText: string): string {
  // \s だけでは ESC(U+001B) や BS(U+0008) を除去できず、close reason 経由で
  // bd show を端末表示したときにエスケープ注入が起きうる。
  return responseText
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const GATE_CLOSE_REASON_MAX_LEN = 200;

export function buildGateCloseReason(responseText: string): string {
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

export function buildCloseRespondedIssueArgs(
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

// 作業チケットをブロックしている open な human gate を resolve する。
// `bd gate resolve` は `bd close <gate-id>` と等価(gate --help より)だが、
// gate 種別に応じた前提チェック(誤って human 以外を resolve していないか)は
// 呼び出し側(filterBlockingHumanGateIds)で担保する。reason は close/gate 双方で
// 同じ整形(buildGateCloseReason: 制御文字除去 + 200 コードポイント切り詰め)を使う。
export function buildGateResolveArgs(
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

// bdboard-rftd: T が自分自身の standalone な decision_question を持ち、かつ
// ちょうど1件の無関係な blocking human gate によって respond() が ambiguous
// 扱いにする(このチケット自身の質問への回答として記録する)とき、T の
// own-question 状態を丸ごと消すために使う。
// opus レビュー指摘(major): decision_question だけを消して decision_options /
// decision_allow_freeform を残すと、T のカードは「質問文の無い、古い選択肢ボタンだけが
// 残ったフォーム」になる。この状態で G がまだ open のまま T のカードにもう一度回答すると、
// hasOwnDecisionQuestion が false に戻っているため isOwnQuestionAmbiguousAnswer が
// 成立せず、通常分岐(ちょうど1件の blocking gate を自動 resolve する経路)に落ちて、
// 古い選択肢ボタンの誤クリックが無関係な G を黙って resolve してしまう
// (bdboard-cine が直そうとした「意図しない gate resolve」と同じ形の事故)。
// 3つとも同じ `bd update` 呼び出しで一括して消し、T のカードを「質問も選択肢も無い
// (=もう own question を持たない、ただの gate 待ちチケットと同じ見た目の)状態」に
// 揃える。--unset-metadata は繰り返し指定でき、既にキーが無くても exit 0 で成功する
// (bdboard-3tj、bd-cli-session-link-writer.ts の unlinkSession と同じ冪等性)ので、
// 3キーとも存在しない場合でも安全。
export function buildUnsetOwnDecisionMetadataArgs(
  rootPath: string,
  issueId: string,
): readonly string[] {
  return [
    '-C',
    rootPath,
    'update',
    issueId,
    '--unset-metadata',
    'decision_question',
    '--unset-metadata',
    'decision_options',
    '--unset-metadata',
    'decision_allow_freeform',
  ];
}
