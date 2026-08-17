import { describe, expect, it } from 'vitest';
import { isValidChatSessionId } from '../../../domain/chat.js';
import type { ChatTurnRequest } from '../../../application/ports/chat-agent.js';
import type { CliTurnContext } from '../cli-chat-agent.js';
import { createAgySpec } from './agy-spec.js';

const context: CliTurnContext = { systemPrompt: 'system', mcpServers: [], toolNames: [], scratchDir: '/tmp' };
const request = (overrides: Partial<ChatTurnRequest> = {}): ChatTurnRequest => ({ projectRootPath: '/tmp/demo', projectName: 'demo', message: 'hello', ...overrides });
const success = (response = 'PONG\n') => JSON.stringify({ conversation_id: 'd876c288-12df-4038-bcf2-21b9fbd1ade5', status: 'SUCCESS', response, duration_seconds: 1.9, num_turns: 1, usage: {} });

describe('createAgySpec (bdboard-l1t.6)', () => {
  it('passes the combined prompt as one print token and puts the command timeout first', () => {
    const spec = createAgySpec({ agyPath: 'agy', model: 'gemini', timeoutMs: 180_000 });
    const plan = spec.buildTurn(request(), context);
    expect(plan.args[0]).toContain('--print=system\n\n---\n\nhello');
    expect(plan.args).toContain('--output-format');
    expect(plan.args).toContain('240000ms');
    expect(Number.parseInt(plan.args[plan.args.indexOf('--print-timeout') + 1] ?? '', 10)).toBeGreaterThan(180_000);
    expect(plan.stdin).toBeUndefined();
  });

  it('supports model override and conversation resume', () => {
    const spec = createAgySpec({ agyPath: 'agy', model: '', timeoutMs: 1000 });
    const plan = spec.buildTurn(request({ resumeSessionId: 'session-1', model: 'requested' }), context);
    expect(plan.args).toContain('--model');
    expect(plan.args).toContain('requested');
    expect(plan.args).toContain('--conversation');
    expect(plan.args).toContain('session-1');
  });

  it('omits --model entirely when neither a default nor a per-request model is set', () => {
    // Opus レビュー SF6: 省略経路そのものの検証。request.model を渡すと省略経路を
    // 通らないため、既定モデルも request.model も無い状態で --model が付かないことを見る。
    const spec = createAgySpec({ agyPath: 'agy', model: '', timeoutMs: 1000 });
    const plan = spec.buildTurn(request(), context);
    expect(plan.args).not.toContain('--model');
  });

  it('clamps a non-positive timeoutMs so the internal print-timeout cannot fire first', () => {
    // Opus レビュー SF4: BDBOARD_CHAT_TIMEOUT_MS=0 のような設定でも、CommandRunner 側の
    // kill (spec.timeoutMs) が --print-timeout より先に発火する先後関係を維持する。
    const spec = createAgySpec({ agyPath: 'agy', model: '', timeoutMs: 0 });
    expect(spec.timeoutMs).toBe(1000);
    const plan = spec.buildTurn(request(), context);
    expect(plan.args[plan.args.indexOf('--print-timeout') + 1]).toBe('61000ms');
  });

  it('parses the measured response and validates its session id', () => {
    const spec = createAgySpec({ agyPath: 'agy', model: '', timeoutMs: 1000 });
    const result = spec.parseTurn({ stdout: success(), stderr: '', exitCode: 0 }, () => undefined);
    expect(result).toEqual({ reply: 'PONG\n', sessionId: 'd876c288-12df-4038-bcf2-21b9fbd1ade5', failedTools: [] });
    expect(isValidChatSessionId(result.sessionId)).toBe(true);
  });

  it('classifies headless denial (empty reply + marker), status errors, and empty replies', () => {
    const spec = createAgySpec({ agyPath: 'agy', model: '', timeoutMs: 1000 });
    expect(() => spec.parseTurn({ stdout: success(''), stderr: 'required the headless mode cannot prompt for approval', exitCode: 0 }, () => undefined)).toThrow(expect.objectContaining({ code: 'agent-headless-denied' }));
    // stdout が結果 JSON として壊れている場合もマーカーがあれば denial を優先する。
    expect(() => spec.parseTurn({ stdout: 'noise', stderr: 'required the headless mode cannot prompt for approval', exitCode: 0 }, () => undefined)).toThrow(expect.objectContaining({ code: 'agent-headless-denied' }));
    expect(() => spec.parseTurn({ stdout: JSON.stringify({ conversation_id: 'id', status: 'ERROR', response: 'x' }), stderr: '', exitCode: 0 }, () => undefined)).toThrow(expect.objectContaining({ code: 'agent-reported-error' }));
    // status が SUCCESS 以外でも、拒否マーカーがあれば根本原因である denial を優先する (delta レビュー N-b)。
    expect(() => spec.parseTurn({ stdout: JSON.stringify({ conversation_id: 'id', status: 'ERROR', response: 'x' }), stderr: 'required the headless mode cannot prompt for approval', exitCode: 0 }, () => undefined)).toThrow(expect.objectContaining({ code: 'agent-headless-denied' }));
    expect(() => spec.parseTurn({ stdout: success(''), stderr: '', exitCode: 0 }, () => undefined)).toThrow(expect.objectContaining({ code: 'agent-unexpected-output' }));
    expect(() => spec.parseTurn({ stdout: 'noise', stderr: '', exitCode: 0 }, () => undefined)).toThrow(expect.objectContaining({ code: 'agent-bad-output' }));
  });

  it('returns the reply when the deny marker appears but the turn still produced a response (MF1)', () => {
    // Opus レビュー MF1: マーカーはツール単位の soft-denial 通知。応答が非空なら
    // ターンは成功として扱い、返信を捨てない。
    const spec = createAgySpec({ agyPath: 'agy', model: '', timeoutMs: 1000 });
    const result = spec.parseTurn({ stdout: success('partial answer\n'), stderr: 'required the "command" permission that headless mode cannot prompt for, so it was auto-denied.', exitCode: 0 }, () => undefined);
    expect(result.reply).toBe('partial answer\n');
    expect(result.sessionId).toBe('d876c288-12df-4038-bcf2-21b9fbd1ade5');
  });

  it('classifyFailure maps the deny marker on non-zero exits and defers otherwise (SF3)', () => {
    const spec = createAgySpec({ agyPath: 'agy', model: '', timeoutMs: 1000 });
    expect(spec.classifyFailure?.({ stdout: '', stderr: 'required the headless mode cannot prompt for approval', exitCode: 1 })).toBe('agent-headless-denied');
    // failureKind が立っている場合は stderr の残骸より agent-not-found / agent-timeout を優先させる。
    expect(spec.classifyFailure?.({ stdout: '', stderr: 'headless mode cannot prompt', exitCode: 1, failureKind: 'timeout' })).toBeUndefined();
    expect(spec.classifyFailure?.({ stdout: '', stderr: 'other failure', exitCode: 1 })).toBeUndefined();
  });

  it('uses line and brace-slice JSON fallbacks and probes auth', () => {
    const spec = createAgySpec({ agyPath: 'agy', model: '', timeoutMs: 1000 });
    expect(spec.parseTurn({ stdout: `noise\n${success()}`, stderr: '', exitCode: 0 }, () => undefined).reply).toBe('PONG\n');
    expect(spec.parseTurn({ stdout: `noise\n${JSON.stringify(JSON.parse(success()), null, 2)}\nnoise`, stderr: '', exitCode: 0 }, () => undefined).reply).toBe('PONG\n');
    expect(spec.authProbe?.args).toEqual(['models']);
    expect(spec.authProbe!.interpret({ stdout: 'model\tversion', stderr: '', exitCode: 0 })).toBe('available');
    expect(spec.authProbe!.interpret({ stdout: '', stderr: 'Please sign in to view available models.', exitCode: 1 })).toBe('unavailable');
    expect(spec.authProbe!.interpret({ stdout: '', stderr: '', exitCode: 1, failureKind: 'timeout' })).toBe('unknown');
  });
});
