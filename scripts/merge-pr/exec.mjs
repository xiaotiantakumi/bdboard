// bdboard-ulxa.1: merge-pr が外部コマンド (git / gh / bd / npm) を起こすための薄い層。
//
// gh / bd / npm は環境変数で差し替えられる (テスト用。check-drift の BDBOARD_DRIFT_GH と同じ
// 考え方で、PATH にもシェバンにも依存させない)。値は JSON 配列で、先頭が実行ファイル、
// 残りがその前に差し込む引数。例: BDBOARD_MERGE_GH='["/usr/bin/node","/abs/fake-tools.mjs","gh"]'
// git は差し替えない — テストは一時リポジトリと bare の origin で本物の git を動かす。
import { spawn, spawnSync } from 'node:child_process';

const TOOL_ENV = { gh: 'BDBOARD_MERGE_GH', bd: 'BDBOARD_MERGE_BD', npm: 'BDBOARD_MERGE_NPM' };

// ネットワークを跨ぐ呼び出し (gh / bd / git fetch / git ls-remote) の上限。枠を持ったまま
// ハングしないように切る (切れたら status 127 = 失敗として扱われる)。
const NETWORK_TIMEOUT_MS = 120_000;

function defaultTimeout(tool, args) {
  if (tool === 'gh' || tool === 'bd') {
    return NETWORK_TIMEOUT_MS;
  }
  return tool === 'git' && (args[0] === 'fetch' || args[0] === 'ls-remote') ? NETWORK_TIMEOUT_MS : undefined;
}

function commandFor(tool) {
  const envName = TOOL_ENV[tool];
  const raw = envName === undefined ? undefined : process.env[envName];
  if (!raw) {
    return { argv: [tool], injected: false };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${envName} is not a JSON array`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((x) => typeof x === 'string')) {
    throw new Error(`${envName} must be a non-empty JSON array of strings`);
  }
  return { argv: parsed, injected: true };
}

/**
 * コマンドを同期実行し、終了コードと出力を返す (throw しない)。
 * stdio: 'inherit' を渡すと出力は呼び出し元の端末へそのまま流れる。
 */
export function run(tool, args, options = {}) {
  const { argv, injected } = commandFor(tool);
  const [bin, ...prefix] = argv;
  // Windows の npm は npm.cmd なので shell 経由でないと起動できない (scripts/npm-command.mjs)。
  const shell = tool === 'npm' && !injected && process.platform === 'win32';
  const result = spawnSync(bin, [...prefix, ...args], {
    cwd: options.cwd ?? process.cwd(),
    encoding: 'utf8',
    env: options.env ?? process.env,
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    shell,
    timeout: options.timeout ?? defaultTimeout(tool, args),
  });
  if (result.error) {
    return { status: 127, stdout: '', stderr: String(result.error.message ?? result.error) };
  }
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** git を実行し、失敗したら stderr 付きで throw する。stdout は末尾の改行を落として返す。 */
export function git(args, options = {}) {
  const result = run('git', args, options);
  if (result.status !== 0) {
    const error = new Error(`git ${args.join(' ')} failed (exit ${result.status}): ${result.stderr.trim()}`);
    error.status = result.status;
    throw error;
  }
  return result.stdout.replace(/\n+$/, '');
}

/** git の成否だけを知りたいとき (merge-base --is-ancestor 等)。 */
export function gitOk(args, options = {}) {
  return run('git', args, options).status === 0;
}

/** 文字列 1 個をシェルの単一引用符で安全に囲む (印字するコマンド行用)。 */
export function shellQuote(value) {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * 検証コマンド (契約の verify) を shell 経由で実行し、出力をログファイルへ落とす。終了コードを
 * resolve する。実行中は heartbeatMs ごとに onHeartbeat を呼ぶ (台帳の pending を更新し続け、
 * verify スロット待ちで長引いても他の merger の LEASE を切らさない)。onHeartbeat は throw しないこと。
 */
export function runShellToLog(command, { cwd, logFd, heartbeatMs = 0, onHeartbeat = () => {} }) {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(command, { cwd, shell: true, stdio: ['ignore', logFd, logFd], env: process.env });
    const timer = heartbeatMs > 0 ? setInterval(onHeartbeat, heartbeatMs) : null;
    const done = (code) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== null) {
        clearInterval(timer);
      }
      resolve(code);
    };
    child.once('error', () => done(127));
    child.once('close', (code) => done(code ?? 1));
  });
}
