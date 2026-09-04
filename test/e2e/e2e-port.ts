// bdboard-2ob0: E2E 用 TCP ポートの決定。per-ticket worktree で複数セッションが並列に
// 走るのが常態なのに、playwright.config.ts / global-setup.ts が固定 8799 を bind すると、
// 2 本目以降のプロセスがポートを掴めずテスト側だけ ERR_CONNECTION_REFUSED になる。
// 再実行すると通るため「フレーク」と誤診されやすい (実測 2026-09-05: 38 件中 6 件)。
//
// fullyParallel:false / workers:1 は同一 Playwright プロセス内の直列化にすぎず、別 worktree
// の別プロセス同士の同時実行は防がない。verify には machine-local な FIFO スロット
// (scripts/verify-slot.mjs) があるが e2e は verify に含まれない。
//
// BDBOARD_E2E_PORT が非空で設定されていれば parsePortNumber で検証してから返す (CI も
// 自動採番経路を通す)。未設定時は OS に ephemeral ポート (listen 127.0.0.1:0) を払い出させる。
// port 0 払い出しと実際の bind の間に TOCTOU 窓は残るが、固定 8799 より桁違いに衝突しにくい。
//
// 8787 は常時稼働の開発サーバー (CLAUDE.md "Always-On Local Hosting") のポート。
// env 指定で 8787 を拒否する。自動採番側にも sanity check があるが ephemeral 範囲外なので
// 実際には発火しない — 実効的な 8787 防御は env 分岐側。
//
// playwright.config.ts は同期的に評価されるため、listen(0) 自体は子プロセス
// (execFileSync + node -e) に任せて同期 API を保つ。

import { execFileSync } from 'node:child_process';

/** 常時稼働 dev サーバー。E2E の throwaway サーバーはここを絶対に bind しない。 */
export const ALWAYS_ON_DEV_PORT = 8787;

const MIN_TCP_PORT = 1;
const MAX_TCP_PORT = 65_535;
const ALLOCATE_TIMEOUT_MS = 10_000;

const ALLOCATE_PORT_SCRIPT = `
const net = require('node:net');
const server = net.createServer();
server.listen(0, '127.0.0.1', () => {
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    process.exit(1);
  }
  process.stdout.write(String(addr.port));
  server.close(() => process.exit(0));
});
server.on('error', () => process.exit(1));
`;

function parsePortNumber(raw: string, source: string): number {
  const trimmed = raw.trim();
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || String(parsed) !== trimmed) {
    throw new Error(
      `resolveE2EPort: ${source} returned non-numeric output: ${JSON.stringify(raw)}`,
    );
  }
  if (parsed < MIN_TCP_PORT || parsed > MAX_TCP_PORT) {
    throw new Error(
      `resolveE2EPort: port ${parsed} from ${source} is outside valid range ${MIN_TCP_PORT}-${MAX_TCP_PORT}`,
    );
  }
  return parsed;
}

function allocateEphemeralPortOnce(): number {
  let stdout: string;
  try {
    // NODE_OPTIONS=--input-type=module が効いている環境でも require が使えるよう CJS を明示
    stdout = execFileSync(
      process.execPath,
      ['--input-type=commonjs', '-e', ALLOCATE_PORT_SCRIPT],
      {
        encoding: 'utf8',
        timeout: ALLOCATE_TIMEOUT_MS,
      },
    );
  } catch (err) {
    throw new Error(
      `resolveE2EPort: failed to allocate ephemeral port via child process: ${String(err)}`,
    );
  }
  return parsePortNumber(stdout, 'OS port allocation');
}

function allocateEphemeralPort(): number {
  const port = allocateEphemeralPortOnce();
  // ephemeral 範囲 (macOS/Windows 49152–65535, Linux 32768–60999) に 8787 は含まれないので
  // 実際には発火しない。実効的な 8787 防御は env 分岐側 (resolveE2EPort) にある。
  // ここは前提が崩れたときに黙って通さないための保険。
  if (port === ALWAYS_ON_DEV_PORT) {
    throw new Error(
      `resolveE2EPort: OS allocated port ${ALWAYS_ON_DEV_PORT} (always-on dev server)`,
    );
  }
  return port;
}

/**
 * E2E throwaway サーバーが bind する TCP ポート番号を文字列で返す。
 * playwright.config.ts (同期) から呼ぶ単一の正本。global-setup.ts は env 経由で同じ値を読む。
 */
export function resolveE2EPort(): string {
  const fromEnv = process.env.BDBOARD_E2E_PORT;
  if (fromEnv !== undefined && fromEnv !== '') {
    const parsed = parsePortNumber(fromEnv, 'BDBOARD_E2E_PORT');
    if (parsed === ALWAYS_ON_DEV_PORT) {
      throw new Error(
        `resolveE2EPort: BDBOARD_E2E_PORT=${ALWAYS_ON_DEV_PORT} is the always-on dev server port; running e2e against it would execute tests against live developer data`,
      );
    }
    return String(parsed);
  }
  return String(allocateEphemeralPort());
}
