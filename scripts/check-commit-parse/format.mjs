// scripts/check-commit-parse.mjs から切り出した出力整形 (1 件分の失敗表示・除外手当ての
// 再掲・全体レポート組み立て)。bdboard-sso1.63: move-only 分割。

// bdboard-ekj3: scripts/commit-message-guard.mjs (PreToolUse フック) が同じ体裁で
// 診断を出せるように export する。表示の重複実装を作らないための共有であって、判定側の
// 挙動は変えない。
export function escapeControlChars(text) {
  return text.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

export function caretLine(lineText, column) {
  if (column == null || column < 1) {
    return '';
  }
  if (column > lineText.length) {
    return 'この行の末尾 (改行) で落ちています。開いた括弧が次の行に持ち越されています。';
  }
  return `${' '.repeat(column - 1)}^`;
}

function formatFailure(failure) {
  const shortSha = failure.sha.slice(0, 7);
  const location =
    failure.line != null && failure.column != null
      ? `${failure.line}:${failure.column}`
      : '(位置不明)';
  const lines = failure.message.split('\n');
  const lineText =
    failure.line != null && failure.line >= 1 && failure.line <= lines.length
      ? lines[failure.line - 1]
      : '';
  const caret = caretLine(lineText, failure.column);
  const parserMessage = escapeControlChars(failure.parserMessage);

  return [
    `commit-parse: ${shortSha} ${failure.subject}`,
    `commit-parse:   パーサ: ${location} — ${parserMessage}`,
    lineText ? `commit-parse:   ${lineText}` : '',
    caret ? `commit-parse:   ${caret}` : '',
    'commit-parse:   直し方: 本文で開いた `(` は同じ行の中で閉じる。行をまたぐと release-please が CHANGELOG からこのコミットを丸ごと落とす。',
    'commit-parse:   取りこぼしたままタグを切ると CHANGELOG から永久に消える — タグ前に直すか手で追記すること。',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * 除外したエントリの手当て (recovery) を毎回再掲する。
 *
 * allowlist は exit code を 0 に戻すだけで、やるべきことは消えていない。タグを切ると
 * その手当ては永久に不可能になるので、赤の代わりにこのブロックが恒久的なリマインダになる。
 */
function formatPendingRecovery(excluded) {
  const entries = [];
  for (const item of excluded) {
    const entry = item?.entry;
    if (entry && !entries.includes(entry)) {
      entries.push(entry);
    }
  }
  if (entries.length === 0) {
    return [];
  }

  const parts = [
    `commit-parse: === リリース (タグ生成) の前にやること ${entries.length} 件 — allowlist で除外した分の手当て ===`,
  ];
  for (const entry of entries) {
    parts.push(`commit-parse:   ${entry.sha.slice(0, 7)} ${entry.subject ?? ''}`.trimEnd());
    if (entry.ticket) {
      parts.push(`commit-parse:     チケット: ${entry.ticket}`);
    }
    for (const line of entry.recovery.split('\n')) {
      parts.push(`commit-parse:     ${line}`);
    }
  }
  return parts;
}

/**
 * 人間 (とエージェント) 向けの本文。exit code は持たせない。
 */
export function formatFindings(result, ctx = {}) {
  const { failures, warnings, excluded } = result;
  const { range, commitCount, reportUnused = false } = ctx;
  const header =
    range != null && commitCount != null
      ? `commit-parse: ${range} の範囲で ${commitCount} 件のコミットを調べました。`
      : `commit-parse: ${commitCount ?? 0} 件のコミットを調べました。`;

  const parts = [header];

  if (failures.length === 0 && warnings.length === 0) {
    parts.push('commit-parse: CHANGELOG 対象の解析不能コミットはありません。');
  }

  if (failures.length > 0) {
    parts.push(
      `commit-parse: CHANGELOG から落ちる解析不能コミットが ${failures.length} 件あります:`,
    );
    for (const failure of failures) {
      parts.push(formatFailure(failure));
    }
  }

  if (warnings.length > 0) {
    parts.push(`commit-parse: 参考 — CHANGELOG 対象外の解析不能コミット ${warnings.length} 件:`);
    for (const warning of warnings) {
      parts.push(
        `commit-parse:   ${warning.sha.slice(0, 7)} ${warning.subject} (${warning.parserMessage})`,
      );
    }
  }

  if (excluded?.length > 0) {
    parts.push(
      `commit-parse: allowlist により ${excluded.length} 件を除外しました (既知の取りこぼし)。`,
    );
    parts.push(...formatPendingRecovery(excluded));
  }

  // PR の限定範囲 (base..head) では allowlist のエントリが見つからないのが当たり前なので、
  // 既定範囲 (v<last>..HEAD) で走ったときだけ「もう消してよい」を伝える。
  if (reportUnused && result.unused?.length > 0) {
    parts.push(
      `commit-parse: allowlist の ${result.unused.length} 件が範囲内に見つかりません — タグが切られて範囲外になったなら KNOWN_UNPARSABLE から削除してください:`,
    );
    for (const entry of result.unused) {
      parts.push(
        `commit-parse:   ${entry.sha.slice(0, 7)} ${entry.subject ?? ''}${entry.ticket ? ` (${entry.ticket})` : ''}`.trimEnd(),
      );
    }
  }

  return parts.join('\n');
}
