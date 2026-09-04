import { describe, expect, it } from 'vitest';
import type { ChatTurnRequest } from '../../../application/ports/chat-agent.js';
import type { CliTurnContext } from '../cli-chat-agent.js';
import { createCursorSpec } from './cursor-spec.js';

const root = '/tmp/demo';
const context: CliTurnContext = {
  systemPrompt: 'prompt',
  // cursor アダプタは MCP サーバーを一切注入しないため、ctx.mcpServers/toolNames が
  // 埋まっていても buildTurn の出力には現れないことをテストで確認する(下記)。
  mcpServers: [{ name: 'bd', command: '/usr/bin/node', args: ['server.ts', '--project-root', root] }],
  toolNames: ['bd_ready'],
  scratchDir: '/tmp/bdboard-scratch',
};
const request = (overrides: Partial<ChatTurnRequest> = {}): ChatTurnRequest => ({ projectRootPath: root, projectName: 'demo', message: 'hello', ...overrides });

describe('createCursorSpec buildTurn', () => {
  it('builds a safe new-turn command and ignores MCP context entirely', () => {
    const spec = createCursorSpec({ cursorPath: 'cursor-agent', model: 'gpt-5', timeoutMs: 1000 });
    const plan = spec.buildTurn(request(), context);
    // bdboard-l1t.5 Opus review MF1: --sandbox enabled is required (restrictive direction,
    // not in FORBIDDEN_CHAT_TOKENS — see the guard test just below for the forbidden set).
    expect(plan.args).toEqual(['--print', '--output-format', 'json', '--sandbox', 'enabled', '--model', 'gpt-5']);
    for (const flag of ['--yolo', '--force', '-f', '--approve-mcps', '--trust', '--allow-all']) {
      expect(plan.args).not.toContain(flag);
    }
    // MCP サーバー/ツール名は一切引数化されない(cursor-agent に per-invocation の
    // MCP 注入手段が無いため)。bdboard-l1t.5 Opus 再レビュー DF8: この
    // not.toContain('bd') は「MCP context 由来の 'bd' サーバー名が args に漏れて
    // いないこと」を確認する趣旨で、MF2 で bdPath が stdin(システムプロンプト)
    // 側に乗るようになった後も args には一切現れないので有効なまま復活させる。
    expect(plan.args.join(' ')).not.toContain('bd');
    expect(plan.args.join(' ')).not.toContain('mcp');
    expect(plan.lastMessageFile).toBeUndefined();
    expect(plan.stdin).toBe('prompt\n\n---\n\nhello');
    expect(spec.descriptor).toMatchObject({ id: 'cursor', capability: 'unrestricted', experimental: true, model: 'gpt-5' });
  });

  it('omits --model when both request and default models are empty', () => {
    const spec = createCursorSpec({ cursorPath: 'cursor-agent', model: '', timeoutMs: 1000 });
    const plan = spec.buildTurn(request(), context);
    expect(plan.args).not.toContain('--model');
    expect(spec.descriptor.model).toBeUndefined();
  });

  it('uses request model over the default model', () => {
    const spec = createCursorSpec({ cursorPath: 'cursor-agent', model: 'default-model', timeoutMs: 1000 });
    const plan = spec.buildTurn(request({ model: 'requested-model' }), context);
    expect(plan.args[plan.args.indexOf('--model') + 1]).toBe('requested-model');
  });

  it('appends --resume with the session id on resume turns, without a separate resume subcommand', () => {
    const spec = createCursorSpec({ cursorPath: 'cursor-agent', model: '', timeoutMs: 1000 });
    const plan = spec.buildTurn(request({ resumeSessionId: 'session-1' }), context);
    expect(plan.args).toEqual(['--print', '--output-format', 'json', '--sandbox', 'enabled', '--resume', 'session-1']);
  });

  it('prefixes the system prompt on resume turns too', () => {
    const spec = createCursorSpec({ cursorPath: 'cursor-agent', model: '', timeoutMs: 1000 });
    const plan = spec.buildTurn(request({ resumeSessionId: 'session-1' }), context);
    expect(plan.stdin).toBe('prompt\n\n---\n\nhello');
  });
});

describe('createCursorSpec parseTurn and authProbe', () => {
  const spec = createCursorSpec({ cursorPath: 'cursor-agent', model: '', timeoutMs: 1000 });

  it('parses reply and session id from the single JSON result object, with no failed tools', () => {
    const stdout = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'hi there', session_id: 'chat-1' });
    expect(spec.parseTurn({ stdout, stderr: '', exitCode: 0 }, () => undefined)).toEqual({ reply: 'hi there', sessionId: 'chat-1', failedTools: [] });
  });

  it('rejects invalid JSON or a payload missing required fields', () => {
    expect(() => spec.parseTurn({ stdout: 'not json', stderr: '', exitCode: 0 }, () => undefined)).toThrow(expect.objectContaining({ code: 'agent-bad-output' }));
    expect(() => spec.parseTurn({ stdout: JSON.stringify({ type: 'result' }), stderr: '', exitCode: 0 }, () => undefined)).toThrow(expect.objectContaining({ code: 'agent-unexpected-output' }));
  });

  it('interprets auth status from status --format json', () => {
    // 2026-09-05 実測 (cursor-agent 2026.09.02-c22c1a3, bdboard-6ids)。ログイン済み・未ログインとも
    // stdout に pretty-print JSON、stderr は空。未ログインでも exitCode は 0 で、codex や
    // claude と違い終了コードでは認証状態を区別できない。そのため判定は isAuthenticated
    // (boolean) だけを見る必要がある。未ログイン状態は HOME を空の一時ディレクトリに向けて
    // 再現した (ログアウトはしていない)。
    expect(spec.authProbe?.args).toEqual(['status', '--format', 'json']);
    expect(spec.authProbe!.interpret({ stdout: JSON.stringify({ isAuthenticated: true }), stderr: '', exitCode: 0 })).toBe('available');
    expect(spec.authProbe!.interpret({ stdout: JSON.stringify({ isAuthenticated: false }), stderr: '', exitCode: 0 })).toBe('unavailable');
    expect(spec.authProbe!.interpret({ stdout: 'not json', stderr: '', exitCode: 1 })).toBe('unknown');
    expect(spec.authProbe!.interpret({ stdout: '', stderr: '', exitCode: 1, failureKind: 'timeout' })).toBe('unknown');
    // 実測形 (ログイン済み)
    expect(spec.authProbe!.interpret({
      stdout: JSON.stringify({ status: 'authenticated', isAuthenticated: true, hasAccessToken: true, hasRefreshToken: true, userInfo: { email: 'example-user@example.com' } }, null, 2),
      stderr: '',
      exitCode: 0,
    })).toBe('available');
    // 実測形 (未ログイン)。exitCode が 0 である点が肝。
    expect(spec.authProbe!.interpret({
      stdout: JSON.stringify({ status: 'unauthenticated', isAuthenticated: false, hasAccessToken: false, hasRefreshToken: false, message: 'Not logged in' }, null, 2),
      stderr: '',
      exitCode: 0,
    })).toBe('unavailable');
  });

  // bdboard-l1t.5 Opus 再レビュー DF6: shape 自体は正常(session_id/result とも
  // 揃っている)なので、shape 異常を意味する 'agent-unexpected-output' ではなく
  // 専用の 'agent-reported-error' に倒す。
  it('treats is_error: true as a failed turn with a dedicated code, not agent-unexpected-output (bdboard-l1t.5 Opus review SF4/DF6)', () => {
    const stdout = JSON.stringify({ type: 'result', is_error: true, result: 'something went wrong internally', session_id: 'chat-1' });
    expect(() => spec.parseTurn({ stdout, stderr: '', exitCode: 0 }, () => undefined)).toThrow(
      expect.objectContaining({ code: 'agent-reported-error' }),
    );
  });

  it('falls back to scanning stdout lines from the end for the last valid JSON result (bdboard-l1t.5 Opus review SF5)', () => {
    const validLine = JSON.stringify({ type: 'result', is_error: false, result: 'ok after noise', session_id: 'chat-2' });
    const stdout = `some stray diagnostic line\nnot json either\n${validLine}`;
    expect(spec.parseTurn({ stdout, stderr: '', exitCode: 0 }, () => undefined)).toEqual({
      reply: 'ok after noise',
      sessionId: 'chat-2',
      failedTools: [],
    });
  });

  // bdboard-l1t.5 Opus 再レビュー DF5: 行単位フォールバックでは復元できない、
  // pretty-print された複数行 JSON がノイズに前後を挟まれているケース
  // (改行を含む1個の JSON なので行単位スキャンだと1行が丸ごと valid にはならない)。
  it('falls back to a first-{ / last-} slice when line-by-line scanning cannot recover a pretty-printed JSON object (DF5)', () => {
    const prettyPrinted = JSON.stringify(
      { type: 'result', is_error: false, result: 'ok from pretty json', session_id: 'chat-3' },
      null,
      2,
    );
    const stdout = `leading noise that is not json\n${prettyPrinted}\ntrailing noise`;
    expect(spec.parseTurn({ stdout, stderr: '', exitCode: 0 }, () => undefined)).toEqual({
      reply: 'ok from pretty json',
      sessionId: 'chat-3',
      failedTools: [],
    });
  });

  it('rejects stdout where neither fallback recovers a valid result (SF5/DF5)', () => {
    const stdout = 'totally not json\nstill not json';
    expect(() => spec.parseTurn({ stdout, stderr: '', exitCode: 0 }, () => undefined)).toThrow(
      expect.objectContaining({ code: 'agent-bad-output' }),
    );
  });
});

describe('createCursorSpec classifyFailure (bdboard-l1t.5 Opus review SF1, re-review DF3)', () => {
  const spec = createCursorSpec({ cursorPath: 'cursor-agent', model: '', timeoutMs: 1000 });

  it('classifies the empirically-confirmed workspace-trust stderr marker', () => {
    expect(
      spec.classifyFailure?.({ stdout: '', stderr: 'Error: Workspace Trust Required\nSome details...', exitCode: 1 }),
    ).toBe('agent-workspace-untrusted');
  });

  it('returns undefined for unrelated failures so the generic classifier takes over', () => {
    expect(spec.classifyFailure?.({ stdout: '', stderr: 'some other error', exitCode: 1 })).toBeUndefined();
  });

  // DF3: failureKind が立っている(spawn-failed/timeout)場合は、stderr にたまたま
  // 同じマーカー文字列が残っていても、cli-chat-agent.ts 側の classifyCommandFailure
  // (failureKind 起点の agent-not-found / agent-timeout 分類)を必ず優先させる。
  it('defers to the generic failureKind classifier when the process never started or timed out, even if stderr happens to contain the trust marker (DF3)', () => {
    expect(
      spec.classifyFailure?.({
        stdout: '',
        stderr: 'Workspace Trust Required (stale leftover text)',
        exitCode: -1,
        failureKind: 'spawn-failed',
      }),
    ).toBeUndefined();
    expect(
      spec.classifyFailure?.({
        stdout: '',
        stderr: 'Workspace Trust Required (stale leftover text)',
        exitCode: -1,
        failureKind: 'timeout',
      }),
    ).toBeUndefined();
  });
});
