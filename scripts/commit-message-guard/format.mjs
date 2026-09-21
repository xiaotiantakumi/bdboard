// bdboard-sso1.46: commit-message-guard.mjs から move-only 分割。deny/notice の出力整形 (「出力」節)。
import { OVERRIDE_ENV } from './constants.mjs';

// --- 出力 ---

const REMEDY = {
  'across-lines': [
    '原因: 直前の語にくっついた `(` をパーサがスコープの開始として読み、閉じ `)` が同じ行に来ていません。',
    '直し方: 開き括弧の前に半角スペースを入れる (`採った(縦積み` → `採った (縦積み`)、または `)` を同じ行の中で閉じる。',
  ],
  nested: [
    '原因: スコープとして開いた `(` の内側にもう一つ `(` があり、そこでパーサが落ちています。',
    '直し方: 外側の開き括弧の前に半角スペースを入れる (`なっている(clear() の…)` → `なっている (clear() の…)`)。',
  ],
  unclosed: [
    '原因: スコープとして開いた `(` が最後まで閉じていません。',
    '直し方: `)` で閉じるか、開き括弧の前に半角スペースを入れる。',
  ],
};

const OVERRIDE_HINT =
  `どうしてもこの本文で commit するなら ${OVERRIDE_ENV}="<理由>" を git と同じコマンドの先頭に置いてください ` +
  `(例: ${OVERRIDE_ENV}="理由" git commit …)。別コマンドの \`export …\` や \`… && git commit\` では効きません。`;

export function formatDenial(result, helpers) {
  const { caretLine, escapeControlChars } = helpers;
  const lines = result.message.split('\n');
  const lineText =
    result.line != null && result.line >= 1 && result.line <= lines.length
      ? lines[result.line - 1]
      : '';
  const location =
    result.line != null && result.column != null ? `${result.line}:${result.column}` : '(位置不明)';
  const remedy = REMEDY[result.kind] ?? REMEDY.unclosed;
  // caretLine は行末で落ちたとき「次の行に持ち越されています」と書く。EOF で落ちた unclosed には
  // 次の行が無いので、その一文は出さない (すぐ下の 原因 行と矛盾する)。
  const caret =
    result.kind === 'unclosed' && result.column > lineText.length
      ? ''
      : caretLine(lineText, result.column);

  return [
    'commit-guard: このコミットメッセージには閉じない `(` があり、release-please と同じパーサで解析できません (bdboard-ekj3)。',
    `commit-guard:   ${location} — ${escapeControlChars(result.parserMessage)}`,
    lineText ? `commit-guard:   ${lineText}` : '',
    caret ? `commit-guard:   ${caret}` : '',
    `commit-guard:   ${remedy[0]}`,
    `commit-guard:   ${remedy[1]}`,
    'commit-guard:   このまま commit すると release-please がこのコミットを CHANGELOG から丸ごと落とし、タグを切ると永久に戻せません。',
    `commit-guard:   ${OVERRIDE_HINT}`,
  ].filter(Boolean);
}

/**
 * allow のまま出す 1 行。括弧以外の解析失敗の警告と、override を実際に使った痕跡。
 * 不可逆ガードを迂回したことは黙って通さない (指摘 n4)。
 */
export function formatNotice(result, helpers) {
  const { escapeControlChars } = helpers;
  if (result.overrode != null) {
    const location =
      result.overrode.line != null && result.overrode.column != null
        ? `${result.overrode.line}:${result.overrode.column}`
        : '(位置不明)';
    return [
      `commit-guard: ${OVERRIDE_ENV} により、閉じない \`(\` を含むコミットメッセージ (${location}) をそのまま通しました (bdboard-ekj3)。`,
    ];
  }
  if (result.warning != null) {
    const location =
      result.warning.line != null && result.warning.column != null
        ? `${result.warning.line}:${result.warning.column}`
        : '(位置不明)';
    return [
      `commit-guard: warning — ${location} ${escapeControlChars(result.warning.parserMessage)} : 括弧の問題ではないので通しますが、CHANGELOG 対象の type ならリリース時に落ちます (bdboard-ekj3)。`,
    ];
  }
  return [];
}
