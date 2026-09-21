// bdboard-sso1.46: commit-message-guard.mjs から move-only 分割。トークン値の最終解決。

// --- 値の解決 ---

// `-m "$(cat <<'EOF' … )"` の外枠。residual では開き行と `)"` の行に分かれているので改行を
// 潰してから当てる。`cat` 以外 (sed 等を挟む形) は最終形が読めないので一致させない。
const CAT_HEREDOC_RE =
  /^"?\$\(\s*cat\s*<<-?\s*(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))\s*\)"?$/;

/**
 * トークン 1 個をメッセージ文字列へ解決する。確定できなければ null (= fail-open)。
 *
 * heredoc は「区切り語が一致するもの」ではなく「このトークンの綴りの中で開かれたもの」を選ぶ。
 * 同じ区切り語の heredoc が別のコマンドにもあるとき、名前だけで引くと他人の本文を掴む。
 */
export function resolveTokenValue(token, heredocs) {
  if (token == null) {
    return null;
  }
  if (token.value != null) {
    return token.value;
  }

  const flattened = token.raw.replace(/\n/g, '');
  const match = CAT_HEREDOC_RE.exec(flattened);
  if (match == null) {
    return null;
  }
  const delimiter = match[1] ?? match[2] ?? match[3];
  const candidates = heredocs.filter((item) => item.delimiter === delimiter && item.closed);
  const heredoc =
    token.start == null
      ? candidates[0]
      : candidates.find(
          (item) => item.openerOffset >= token.start && item.openerOffset < (token.end ?? Infinity),
        );
  // 区切り語が引用されていない heredoc は後で展開されるので、本文を最終形として扱えない。
  if (heredoc == null || !heredoc.quoted) {
    return null;
  }
  return heredoc.body;
}
