import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatTurnRequest } from '../../../application/ports/chat-agent.js';
import type { CommandRunner } from '../../../application/ports/command-runner.js';
import { createCliChatAgent, type CliTurnContext } from '../cli-chat-agent.js';
import { createCodexSpec } from './codex-spec.js';

const root = '/tmp/demo';
const context: CliTurnContext = {
  systemPrompt: 'prompt',
  mcpServers: [{ name: 'bd', command: '/usr/bin/node', args: ['server.ts', '--project-root', root] }],
  toolNames: ['bd_ready'],
  scratchDir: '/tmp/bdboard-scratch',
};
const request = (overrides: Partial<ChatTurnRequest> = {}): ChatTurnRequest => ({ projectRootPath: root, projectName: 'demo', message: 'hello', ...overrides });
const scratchDirs: string[] = [];

afterEach(() => {
  for (const scratchDir of scratchDirs.splice(0)) {
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

describe('createCodexSpec buildTurn', () => {
  it('builds a safe new-turn command with injected MCP and output artifact', () => {
    const spec = createCodexSpec({ codexPath: 'codex', model: 'gpt-5', timeoutMs: 1000 });
    const plan = spec.buildTurn(request(), context);
    expect(plan.args).toEqual(expect.arrayContaining(['exec', '--approve-for-me', '--ignore-user-config', '--ignore-rules', '--strict-config', '--skip-git-repo-check', '--json']));
    for (const flag of ['-s', '--sandbox', '--yolo', '--force', '--approve-mcps', '--trust', '--allow-all']) expect(plan.args).not.toContain(flag);
    expect(plan.args).toContain('mcp_servers.bd.command="/usr/bin/node"');
    expect(plan.args).toContain('mcp_servers.bd.args=["server.ts", "--project-root", "/tmp/demo"]');
    expect(plan.args).toContain('-m');
    expect(plan.args[plan.args.indexOf('-m') + 1]).toBe('gpt-5');
    expect(plan.args).toContain('-o');
    expect(plan.lastMessageFile).toBe(plan.args[plan.args.indexOf('-o') + 1]);
    expect(plan.lastMessageFile?.startsWith(context.scratchDir)).toBe(true);
    expect(plan.stdin).toBe('prompt\n\n---\n\nhello');
    expect(spec.descriptor).toMatchObject({ id: 'codex', capability: 'unrestricted', experimental: true, supportsImages: true });
  });

  it('prefixes the system prompt on resume turns too', () => {
    const spec = createCodexSpec({ codexPath: 'codex', model: '', timeoutMs: 1000 });
    const plan = spec.buildTurn(request({ resumeSessionId: 'session-1' }), context);
    expect(plan.stdin).toBe('prompt\n\n---\n\nhello');
  });

  it('uses request model and omits -m when both models are empty', () => {
    const spec = createCodexSpec({ codexPath: 'codex', model: '', timeoutMs: 1000 });
    const plan = spec.buildTurn(request({ model: 'requested' }), context);
    expect(plan.args[plan.args.indexOf('-m') + 1]).toBe('requested');
    const empty = spec.buildTurn(request(), context);
    expect(empty.args).not.toContain('-m');
  });

  it('builds resume without approve-for-me', () => {
    const spec = createCodexSpec({ codexPath: 'codex', model: '', timeoutMs: 1000 });
    const plan = spec.buildTurn(request({ resumeSessionId: 'session-1' }), context);
    expect(plan.args.slice(0, 3)).toEqual(['exec', 'resume', 'session-1']);
    expect(plan.args).not.toContain('--approve-for-me');
  });

  it('escapes backslash/quote but rejects raw newlines and control characters in MCP server command/args (bdboard-l1t.4)', () => {
    const spec = createCodexSpec({ codexPath: 'codex', model: '', timeoutMs: 1000 });

    // 通常のバックスラッシュ/ダブルクォートは -c の TOML 文字列としてそのままエスケープされる。
    const quotableContext: CliTurnContext = {
      ...context,
      mcpServers: [{ name: 'bd', command: 'quote"quote back\\slash', args: ['plain', 'back\\slash', 'quote"quote'] }],
    };
    const plan = spec.buildTurn(request(), quotableContext);
    const commandArg = plan.args.find((arg) => arg.startsWith('mcp_servers.bd.command='));
    expect(commandArg).toBe('mcp_servers.bd.command="quote\\"quote back\\\\slash"');
    const argsArg = plan.args.find((arg) => arg.startsWith('mcp_servers.bd.args='));
    expect(argsArg).toBe('mcp_servers.bd.args=["plain", "back\\\\slash", "quote\\"quote"]');

    // 生の改行や NUL 等の制御文字が混ざった場合は、壊れた/意図しない -c TOML を黙って
    // 生成するのではなく例外で拒否する(bdboard-l1t.4 デルタレビュー nit8: escape でなく reject)。
    const newlineInCommand: CliTurnContext = {
      ...context,
      mcpServers: [{ name: 'bd', command: '/usr/bin/node\n[malicious]\ninjected="yes"', args: [] }],
    };
    expect(() => spec.buildTurn(request(), newlineInCommand)).toThrow(/control character/);

    const nullByteInArgs: CliTurnContext = {
      ...context,
      mcpServers: [{ name: 'bd', command: '/usr/bin/node', args: ['null\x00byte'] }],
    };
    expect(() => spec.buildTurn(request(), nullByteInArgs)).toThrow(/control character/);

    const tabInArgs: CliTurnContext = {
      ...context,
      mcpServers: [{ name: 'bd', command: '/usr/bin/node', args: ['tab\ttab'] }],
    };
    expect(() => spec.buildTurn(request(), tabInArgs)).toThrow(/control character/);
  });
});

describe('createCodexSpec image artifacts', () => {
  it.each([
    ['new turn', undefined],
    ['resume turn', 'resume-thread'],
  ])('passes repeated -i paths on a %s and cleans mode-0600 files', async (_label, resumeSessionId) => {
    const scratchDir = mkdtempSync(path.join(os.tmpdir(), 'bdboard-codex-image-test-'));
    scratchDirs.push(scratchDir);
    const capturedArgs: string[][] = [];
    let capturedImagePaths: string[] = [];
    const runner: CommandRunner = {
      async run(_command, args) {
        capturedArgs.push([...args]);
        capturedImagePaths = args.flatMap((arg, index) => arg === '-i' ? [args[index + 1]!] : []);
        expect(capturedImagePaths).toHaveLength(2);
        expect(capturedImagePaths.map((imagePath) => path.extname(imagePath))).toEqual(['.png', '.jpg']);
        for (const imagePath of capturedImagePaths) {
          expect(existsSync(imagePath)).toBe(true);
          expect(statSync(imagePath).mode & 0o777).toBe(0o600);
        }
        expect([...readFileSync(capturedImagePaths[0]!)]).toEqual([0x89, 0x50]);
        expect([...readFileSync(capturedImagePaths[1]!)]).toEqual([0xff, 0xd8]);
        const outputPath = args[args.indexOf('-o') + 1]!;
        writeFileSync(outputPath, 'reply', 'utf8');
        return {
          stdout: JSON.stringify({
            type: 'thread.started',
            thread_id: resumeSessionId ?? 'new-thread',
          }),
          stderr: '',
          exitCode: 0,
        };
      },
    };
    const spec = createCodexSpec({ codexPath: 'codex', model: '', timeoutMs: 1000 });
    const agent = createCliChatAgent(runner, spec, {
      buildContext: () => ({ ...context, scratchDir }),
    });

    await agent.sendMessage(request({
      ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
      images: [
        { mimeType: 'image/png', data: Uint8Array.from([0x89, 0x50]) },
        { mimeType: 'image/jpeg', data: Uint8Array.from([0xff, 0xd8]) },
      ],
    }));

    if (resumeSessionId === undefined) {
      expect(capturedArgs[0]?.[0]).toBe('exec');
      expect(capturedArgs[0]).toContain('--approve-for-me');
    } else {
      expect(capturedArgs[0]?.slice(0, 3)).toEqual(['exec', 'resume', resumeSessionId]);
    }
    expect(capturedImagePaths.every((imagePath) => !existsSync(imagePath))).toBe(true);
  });

  it.each([
    ['CLI exit non-zero', { stdout: '', stderr: 'failed', exitCode: 1 }],
    ['parse error', { stdout: '{}', stderr: '', exitCode: 0 }],
  ])('cleans image artifacts on %s', async (_label, commandResult) => {
    const scratchDir = mkdtempSync(path.join(os.tmpdir(), 'bdboard-codex-image-failure-test-'));
    scratchDirs.push(scratchDir);
    let imagePath = '';
    const runner: CommandRunner = {
      async run(_command, args) {
        imagePath = args[args.indexOf('-i') + 1]!;
        expect(existsSync(imagePath)).toBe(true);
        const outputPath = args[args.indexOf('-o') + 1]!;
        writeFileSync(outputPath, 'partial', 'utf8');
        return commandResult;
      },
    };
    const agent = createCliChatAgent(
      runner,
      createCodexSpec({ codexPath: 'codex', model: '', timeoutMs: 1000 }),
      { buildContext: () => ({ ...context, scratchDir }) },
    );

    await expect(agent.sendMessage(request({
      images: [{ mimeType: 'image/webp', data: Uint8Array.from([1, 2, 3]) }],
    }))).rejects.toBeDefined();
    expect(existsSync(imagePath)).toBe(false);
  });
});

describe('createCodexSpec parseTurn and authProbe', () => {
  const spec = createCodexSpec({ codexPath: 'codex', model: '', timeoutMs: 1000 });
  it('parses session, reply artifact, and failed MCP tools from JSONL', () => {
    const stdout = [JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }), JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', status: 'failed', tool: 'bd_ready' } })].join('\n');
    expect(spec.parseTurn({ stdout, stderr: '', exitCode: 0 }, () => 'reply')).toEqual({ reply: 'reply', sessionId: 'thread-1', failedTools: ['bd_ready'] });
  });
  it('rejects missing artifact or thread event', () => {
    expect(() => spec.parseTurn({ stdout: '{"type":"thread.started","thread_id":"x"}', stderr: '', exitCode: 0 }, () => undefined)).toThrow(expect.objectContaining({ code: 'agent-bad-output' }));
    expect(() => spec.parseTurn({ stdout: '', stderr: '', exitCode: 0 }, () => 'reply')).toThrow(expect.objectContaining({ code: 'agent-unexpected-output' }));
    expect(spec.authProbe?.args).toEqual(['login', 'status']);
  });
  it('interprets login status conservatively', () => {
    expect(spec.authProbe!.interpret({ stdout: 'Logged in using ChatGPT', stderr: '', exitCode: 0 })).toBe('available');
    expect(spec.authProbe!.interpret({ stdout: '', stderr: '', exitCode: 1, failureKind: 'timeout' })).toBe('unknown');
    expect(spec.authProbe!.interpret({ stdout: 'maybe', stderr: '', exitCode: 1 })).toBe('unknown');
  });
});
