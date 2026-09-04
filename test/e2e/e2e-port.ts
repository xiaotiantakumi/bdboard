// bdboard-2ob0: E2E 用 TCP ポートの決定。per-ticket worktree で複数セッションが並列に
// 走るのが常態なのに、playwright.config.ts / global-setup.ts が固定 8799 を bind すると、
// 2 本目以降のプロセスがポートを掴めずテスト側だけ ERR_CONNECTION_REFUSED になる。
// 再実行すると通るため「フレーク」と誤診されやすい (実測 2026-09-05: 38 件中 6 件)。
//
// fullyParallel:false / workers:1 は同一 Playwright プロセス内の直列化にすぎず、別 worktree
// の別プロセス同士の同時実行は防がない。verify には machine-local な FIFO スロット
// (scripts/verify-slot.mjs) があるが e2e は verify に含まれない。
//
// BDBOARD_E2E_PORT が非空で設定されていればその値をそのまま返す (CI と既存の明示指定運用)。
// 未設定時は OS に ephemeral ポート (listen 127.0.0.1:0) を払い出させる。port 0 払い出しと
// 実際の bind の間に TOCTOU 窓は残るが、固定 8799 より桁違いに衝突しにくいので許容する。
//
// 8787 は常時稼働の開発サーバー (CLAUDE.md "Always-On Local Hosting") のポート。
// 自動採番結果が 8787 になった場合は再試行し、それでも 8787 しか出ないなら例外で落とす。
// 黙って 8787 を使うのが最悪の失敗なので、固定値へのフォールバックも禁止。
//
// playwright.config.ts は同期的に評価されるため、listen(0) 自体は子プロセス
// (execFileSync + node -e) に任せて同期 API を保つ。

import { execFileSync } from 'node:child_process';

/** 常時稼働 dev サーバー。E2E の throwaway サーバーはここを絶対に bind しない。 */
export const ALWAYS_ON_DEV_PORT = 8787;

const MIN_TCP_PORT = 1;
const MAX_TCP_PORT = 65_535;
const MAX_ALLOCATION_ATTEMPTS = 5;
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

function parsePortNumber(raw: string): number {
  const trimmed = raw.trim();
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || String(parsed) !== trimmed) {
    throw new Error(
      `resolveE2EPort: OS port allocation returned non-numeric output: ${JSON.stringify(raw)}`,
    );
  }
  if (parsed < MIN_TCP_PORT || parsed > MAX_TCP_PORT) {
    throw new Error(
      `resolveE2EPort: allocated port ${parsed} is outside valid range ${MIN_TCP_PORT}-${MAX_TCP_PORT}`,
    );
  }
  return parsed;
}

function allocateEphemeralPortOnce(): number {
  let stdout: string;
  try {
    stdout = execFileSync(process.execPath, ['-e', ALLOCATE_PORT_SCRIPT], {
      encoding: 'utf8',
      timeout: ALLOCATE_TIMEOUT_MS,
    });
  } catch (err) {
    throw new Error(
      `resolveE2EPort: failed to allocate ephemeral port via child process: ${String(err)}`,
    );
  }
  return parsePortNumber(stdout);
}

function allocateEphemeralPort(): number {
  for (let attempt = 1; attempt <= MAX_ALLOCATION_ATTEMPTS; attempt += 1) {
    const port = allocateEphemeralPortOnce();
    if (port !== ALWAYS_ON_DEV_PORT) {
      return port;
    }
  }
  throw new Error(
    `resolveE2EPort: OS kept allocating port ${ALWAYS_ON_DEV_PORT} (always-on dev server) after ${MAX_ALLOCATION_ATTEMPTS} attempts`,
  );
}

/**
 * E2E throwaway サーバーが bind する TCP ポート番号を文字列で返す。
 * playwright.config.ts (同期) と global-setup.ts の両方から呼ぶ単一の正本。
 */
export function resolveE2EPort(): string {
  const fromEnv = process.env.BDBOARD_E2E_PORT;
  if (fromEnv !== undefined && fromEnv !== '') {
    return fromEnv;
  }
  return String(allocateEphemeralPort());
}
