// bdboard-sso1.46: commit-message-guard.mjs から move-only 分割。heredoc の切り出し。

// --- heredoc ---

// `<<` のみ。`<<<` (here-string) と紛れないよう前後を除外する。`<<<'EOF'` は 2 文字目からでも
// `<<'EOF'` に一致してしまうので、後読みまで付けないと here-string を heredoc と誤読する。
const HEREDOC_OPENER_RE =
  /(?<!<)<<(?!<)(-?)\s*(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))/g;

/**
 * コマンド文字列から heredoc の本文を切り出し、本文を除いた残り (residual) を返す。
 *
 * Claude Code が書く commit は `git commit -m "$(cat <<'EOF' … EOF)"` が常態で、本文には
 * `;` `|` `&` `"` が普通に含まれる。先に本文を抜いておかないと、後段のトークナイズが本文の
 * 記号でめちゃくちゃになる。抜いた本文はそのままメッセージ候補になる。
 *
 * 各 heredoc は `openerOffset` (residual の中で `<<` が現れる位置) を持つ。これが無いと
 * 「どの heredoc がどのコマンドに属するか」が分からず、`-F -` が無関係な heredoc の本文を
 * 掴んでしまう (指摘 m1)。
 */
export function extractHeredocs(command) {
  const lines = command.split('\n');
  const heredocs = [];
  const residual = [];
  let index = 0;
  // residual.join('\n') の中での、いま push する行の先頭オフセット。
  let residualOffset = 0;

  while (index < lines.length) {
    const line = lines[index];
    const lineStart = residualOffset;
    residual.push(line);
    residualOffset += line.length + 1;
    index += 1;

    const openers = [];
    HEREDOC_OPENER_RE.lastIndex = 0;
    let match;
    while ((match = HEREDOC_OPENER_RE.exec(line)) !== null) {
      openers.push({
        delimiter: match[2] ?? match[3] ?? match[4],
        // 区切り語を引用符で囲むと展開が起きない = 本文がそのままメッセージ。囲まない場合は
        // $VAR や $(…) が後で展開されるので、本文を最終形として扱ってはいけない。
        quoted: match[2] !== undefined || match[3] !== undefined,
        stripTabs: match[1] === '-',
        openerOffset: lineStart + match.index,
      });
    }

    // 同じ行に複数の heredoc があれば、本文は開いた順に並ぶ (シェルの仕様)。
    for (const opener of openers) {
      const body = [];
      let closed = false;
      while (index < lines.length) {
        const raw = lines[index];
        const candidate = opener.stripTabs ? raw.replace(/^\t+/, '') : raw;
        index += 1;
        if (candidate === opener.delimiter) {
          closed = true;
          break;
        }
        body.push(candidate);
      }
      heredocs.push({ ...opener, body: body.join('\n'), closed });
    }
  }

  return { heredocs, residual: residual.join('\n') };
}
