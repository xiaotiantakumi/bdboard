// bdboard-sso1.46: commit-message-guard.mjs から move-only 分割。CLI 本体 (「エントリポイント」節の
// main/readStdin)。isMain の判定と実行は薄い入口である commit-message-guard.mjs 側に残す。
// main は元ファイルでは非公開関数だったが、分割によりモジュール境界を越えて呼ばれるため export した
// (呼び出し方・挙動は変えていない)。check-commit-parse.mjs への動的 import のパス調整は evaluate.mjs
// と同じ理由(ディレクトリが1段深くなった分)。
import { evaluateCommand } from './evaluate.mjs';
import { formatDenial, formatNotice } from './format.mjs';

export const EXIT_ALLOW = 0;
const EXIT_DENY = 2;

// --- エントリポイント ---

export async function main() {
  const input = await readStdin();
  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    return EXIT_ALLOW;
  }

  const toolName = payload?.tool_name;
  if (toolName != null && toolName !== 'Bash') {
    return EXIT_ALLOW;
  }

  const command = payload?.tool_input?.command;
  const cwd = typeof payload?.cwd === 'string' && payload.cwd.length > 0 ? payload.cwd : process.cwd();

  const result = await evaluateCommand(command, { cwd });
  const notable = result.verdict === 'deny' || result.warning != null || result.overrode != null;
  if (!notable) {
    return EXIT_ALLOW;
  }

  let helpers;
  try {
    const module = await import('../check-commit-parse.mjs');
    helpers = { caretLine: module.caretLine, escapeControlChars: module.escapeControlChars };
  } catch {
    return EXIT_ALLOW;
  }

  if (result.verdict !== 'deny') {
    for (const line of formatNotice(result, helpers)) {
      process.stderr.write(`${line}\n`);
    }
    return EXIT_ALLOW;
  }

  for (const line of formatDenial(result, helpers)) {
    process.stderr.write(`${line}\n`);
  }
  return EXIT_DENY;
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
  });
}
