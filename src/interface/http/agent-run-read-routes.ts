import { Hono } from 'hono';
import type { BoardCache } from '../../application/ports/board-cache.js';
import type { RunStore, RunStoreRecord } from '../../application/runner/run-store.js';
import type { ProjectHarnessStatus } from '../../domain/harness-pack.js';
import { evaluateRunPreflight } from '../../domain/harness-run-preflight.js';
import { isLocalBasicAuthRequest } from './local-request.js';
import { parseClampedIntQueryParam } from './parse-clamped-int-query-param.js';
import { findTicket, toRunSummaryDto } from './agent-run-shared.js';

/**
 * agent-run-routes.ts (旧672行) の分割 (bdboard-sso1.27) で GET /api/runs
 * (一覧) と GET /api/runs/:runId (詳細・ログ tail) をここへ切り出した (move
 * only, 挙動変更ゼロ)。両ルートとも RunStore の読み取りのみで書き込み状態を
 * 持たないため、この2ルートだけをまとめている。
 */

const DEFAULT_TAIL_BYTES = 64 * 1024;
const MAX_TAIL_BYTES = 1024 * 1024;

export interface AgentRunReadRoutesDeps {
  readonly cache: BoardCache;
  readonly runStore: RunStore;
  readonly getHarnessStatus: (repoRootPath: string) => Promise<ProjectHarnessStatus>;
}

function tailLogByBytes(log: string, tailBytes: number): string {
  if (utf8ByteLength(log) <= tailBytes) {
    return log;
  }

  const bytes = new TextEncoder().encode(log);
  const tail = bytes.slice(bytes.length - tailBytes);

  for (let offset = 0; offset < tail.length; offset += 1) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(tail.slice(offset));
    } catch {
      // skip a broken leading byte from slicing mid-codepoint
    }
  }

  return '';
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * run 完了後に人が回す検証コマンドの提示 (bdboard-pkr6.11 仕様4)。
 *
 * 出すのは `succeeded` のときだけ。実行中は意味が無く (毎回のポーリングで
 * `.claude/` を読み直す理由も無い)、`failed` / `cancelled` で「次に実行:
 * npm run verify」を出すのは、編集が中断・破棄されているかもしれない状態で
 * 検証を促す誤った導線になる。ハーネス状態が読めない/前提を満たさなく
 * なっている場合も黙って省く: ここは導線であって、ログ表示を巻き添えに
 * 失敗させる価値は無い。
 */
async function resolveRunNextStep(
  deps: AgentRunReadRoutesDeps,
  record: RunStoreRecord,
): Promise<{ verify: string; worktreePath: string } | undefined> {
  if (record.status !== 'succeeded' || record.cwd === '') {
    return undefined;
  }

  const resolved = findTicket(deps.cache, record.ticketId);
  if (resolved === undefined) {
    return undefined;
  }

  try {
    const preflight = evaluateRunPreflight(
      await deps.getHarnessStatus(resolved.project.rootPath),
    );
    if (!preflight.ok) {
      return undefined;
    }
    return { verify: preflight.verify, worktreePath: record.cwd };
  } catch {
    return undefined;
  }
}

export function createAgentRunReadRoutes(deps: AgentRunReadRoutesDeps): Hono {
  const app = new Hono();

  app.get('/api/runs', (c) => {
    const ticketId = c.req.query('ticketId');
    const records = deps.runStore.list(
      ticketId !== undefined && ticketId !== '' ? { ticketId } : undefined,
    );

    const runs = [...records]
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .map(toRunSummaryDto);

    return c.json({ runs });
  });

  app.get('/api/runs/:runId', async (c) => {
    const runId = c.req.param('runId');
    const record = deps.runStore.get(runId);
    if (record === undefined) {
      return c.json({ error: 'run not found' }, 404);
    }

    const tailBytes = parseClampedIntQueryParam(c.req.query('tailBytes'), {
      min: 1,
      max: MAX_TAIL_BYTES,
      defaultValue: DEFAULT_TAIL_BYTES,
    });

    // Read/Glob/Grep はログに任意ファイルの内容を載せうる。ログをリモートへ返すと
    // それが exfiltration チャネルになるので、ログ本文と cwd はローカルアクセス限定にする
    // (bdboard-54be.1 M-1)。リモートからは状態 (running/succeeded/failed) は見える。
    const local = isLocalBasicAuthRequest(c);
    // nextStep は worktree の絶対パスを含むので、cwd と同じくローカル限定にする。
    const nextStep = local ? await resolveRunNextStep(deps, record) : undefined;
    return c.json({
      ...toRunSummaryDto(record),
      cwd: local ? record.cwd : undefined,
      log: local ? tailLogByBytes(record.log, tailBytes) : '',
      logRestricted: local ? undefined : true,
      nextStep,
    });
  });

  return app;
}
