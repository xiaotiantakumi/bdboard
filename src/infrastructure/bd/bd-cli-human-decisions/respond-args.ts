// bd-cli-human-decisions.ts (bdboard-sso1.16) の分割で切り出した、respond() が
// close/gate resolve に使う bd CLI 引数の組み立て担当。respond.ts からだけ使う
// 内部モジュール。挙動・型は分割前と同一(移動のみ)。

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

