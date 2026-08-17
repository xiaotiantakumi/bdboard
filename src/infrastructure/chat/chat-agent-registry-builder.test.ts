import { describe, expect, it } from 'vitest';
import type { CommandResult, CommandRunner } from '../../application/ports/command-runner.js';
import { buildChatAgentRegistry } from './chat-agent-registry-builder.js';

function fakeCommandRunner(): CommandRunner {
  return {
    async run(): Promise<CommandResult> {
      throw new Error('buildChatAgentRegistry must not run commands at build time');
    },
  };
}

describe('buildChatAgentRegistry (bdboard-l1t.4 SF6)', () => {
  it('registers only claude when BDBOARD_CHAT_AGENTS is unset', () => {
    const { registry, codexEnabled, cursorEnabled } = buildChatAgentRegistry({}, fakeCommandRunner());

    const ids = registry.list().map((agent) => agent.descriptor.id);
    expect(ids).toEqual(['claude']);
    expect(registry.get('codex')).toBeUndefined();
    expect(registry.get('cursor')).toBeUndefined();
    expect(codexEnabled).toBe(false);
    expect(cursorEnabled).toBe(false);
  });

  it('registers codex in addition to claude when BDBOARD_CHAT_AGENTS opts it in', () => {
    const { registry, codexEnabled, cursorEnabled } = buildChatAgentRegistry(
      { BDBOARD_CHAT_AGENTS: 'codex' },
      fakeCommandRunner(),
    );

    const ids = registry.list().map((agent) => agent.descriptor.id).sort();
    expect(ids).toEqual(['claude', 'codex']);
    expect(registry.get('codex')).toBeDefined();
    expect(codexEnabled).toBe(true);
    expect(cursorEnabled).toBe(false);
  });

  it('registers cursor in addition to claude when BDBOARD_CHAT_AGENTS opts it in (bdboard-l1t.5)', () => {
    const { registry, codexEnabled, cursorEnabled } = buildChatAgentRegistry(
      { BDBOARD_CHAT_AGENTS: 'cursor' },
      fakeCommandRunner(),
    );

    const ids = registry.list().map((agent) => agent.descriptor.id).sort();
    expect(ids).toEqual(['claude', 'cursor']);
    expect(registry.get('cursor')).toBeDefined();
    expect(codexEnabled).toBe(false);
    expect(cursorEnabled).toBe(true);
  });

  it('registers both codex and cursor when both are opted in', () => {
    const { registry, codexEnabled, cursorEnabled } = buildChatAgentRegistry(
      { BDBOARD_CHAT_AGENTS: 'codex,cursor' },
      fakeCommandRunner(),
    );

    const ids = registry.list().map((agent) => agent.descriptor.id).sort();
    expect(ids).toEqual(['claude', 'codex', 'cursor']);
    expect(codexEnabled).toBe(true);
    expect(cursorEnabled).toBe(true);
  });

  it('registers agy only when explicitly opted in (bdboard-l1t.6)', () => {
    const disabled = buildChatAgentRegistry({}, fakeCommandRunner());
    expect(disabled.registry.get('agy')).toBeUndefined();
    expect(disabled.agyEnabled).toBe(false);
    const enabled = buildChatAgentRegistry({ BDBOARD_CHAT_AGENTS: 'agy' }, fakeCommandRunner());
    expect(enabled.registry.get('agy')).toBeDefined();
    expect(enabled.agyEnabled).toBe(true);
  });

  it('is case-insensitive and ignores unrelated opt-in entries', () => {
    const { registry, codexEnabled, cursorEnabled } = buildChatAgentRegistry(
      { BDBOARD_CHAT_AGENTS: 'CODEX, CURSOR, some-other-tool' },
      fakeCommandRunner(),
    );

    expect(registry.get('codex')).toBeDefined();
    expect(registry.get('cursor')).toBeDefined();
    expect(codexEnabled).toBe(true);
    expect(cursorEnabled).toBe(true);
  });

  it('does not register codex/cursor for an unrelated opt-in value', () => {
    const { registry, codexEnabled, cursorEnabled } = buildChatAgentRegistry(
      { BDBOARD_CHAT_AGENTS: 'some-other-tool' },
      fakeCommandRunner(),
    );

    expect(registry.get('codex')).toBeUndefined();
    expect(registry.get('cursor')).toBeUndefined();
    expect(codexEnabled).toBe(false);
    expect(cursorEnabled).toBe(false);
  });

  it('honors env overrides for claude/codex CLI paths and model without touching process.env', () => {
    const { registry } = buildChatAgentRegistry(
      {
        BDBOARD_CHAT_AGENTS: 'codex',
        BDBOARD_CLAUDE_PATH: '/opt/claude',
        BDBOARD_CHAT_MODEL: 'opus',
        BDBOARD_CODEX_PATH: '/opt/codex',
        BDBOARD_CODEX_MODEL: 'gpt-5',
      },
      fakeCommandRunner(),
    );

    expect(registry.get('claude')?.descriptor.model).toBe('opus');
    expect(registry.get('codex')?.descriptor.model).toBe('gpt-5');
  });

  it('honors env overrides for cursor CLI path and model without touching process.env (bdboard-l1t.5)', () => {
    const { registry } = buildChatAgentRegistry(
      {
        BDBOARD_CHAT_AGENTS: 'cursor',
        BDBOARD_CURSOR_PATH: '/opt/cursor-agent',
        BDBOARD_CURSOR_MODEL: 'gpt-5.6-luna',
      },
      fakeCommandRunner(),
    );

    expect(registry.get('cursor')?.descriptor.model).toBe('gpt-5.6-luna');
  });

  it('honors env overrides for agy model (bdboard-l1t.6)', () => {
    const { registry } = buildChatAgentRegistry({ BDBOARD_CHAT_AGENTS: 'agy', BDBOARD_AGY_PATH: '/opt/agy', BDBOARD_AGY_MODEL: 'claude-sonnet-4-6' }, fakeCommandRunner());
    expect(registry.get('agy')?.descriptor.model).toBe('claude-sonnet-4-6');
  });

  // bdboard-3tw.104.11 Opus レビュー SF3(a): BDBOARD_CHAT_RATE_WEIGHT_OPUS が実際に claude
  // spec の opus エントリの weight まで届くこと(env → chat-agent-registry-builder.ts →
  // claude-spec.ts の結線の生存確認)。SONNET/HAIKU を明示指定していないので既定値のまま
  // 残ることも合わせて確認する。
  it('threads BDBOARD_CHAT_RATE_WEIGHT_OPUS into the claude descriptor opus model weight', () => {
    const { registry } = buildChatAgentRegistry(
      { BDBOARD_CHAT_RATE_WEIGHT_OPUS: '9' },
      fakeCommandRunner(),
    );

    const models = registry.get('claude')?.descriptor.models;
    expect(models?.find((entry) => entry.id === 'opus')?.weight).toBe(9);
    expect(models?.find((entry) => entry.id === 'sonnet')?.weight).toBe(1);
    expect(models?.find((entry) => entry.id === 'haiku')?.weight).toBe(1);
  });

  // bdboard-3tw.104.11 Opus レビュー N4: 負値/0 の env は受理せず既定値(5)にフォールバック
  // すること。
  it('ignores a non-positive BDBOARD_CHAT_RATE_WEIGHT_OPUS and falls back to the default', () => {
    const { registry } = buildChatAgentRegistry(
      { BDBOARD_CHAT_RATE_WEIGHT_OPUS: '-1' },
      fakeCommandRunner(),
    );

    const models = registry.get('claude')?.descriptor.models;
    expect(models?.find((entry) => entry.id === 'opus')?.weight).toBe(5);
  });

  it('threads BDBOARD_BD_PATH into the cursor adapter system prompt (bdboard-l1t.5 Opus review MF2)', async () => {
    let capturedInput: string | undefined;
    const capturingRunner: CommandRunner = {
      async run(_command, _args, options): Promise<CommandResult> {
        capturedInput = options?.input;
        return {
          stdout: JSON.stringify({ type: 'result', is_error: false, result: 'ok', session_id: 's1' }),
          stderr: '',
          exitCode: 0,
        };
      },
    };

    const { registry } = buildChatAgentRegistry(
      { BDBOARD_CHAT_AGENTS: 'cursor', BDBOARD_BD_PATH: '/opt/homebrew/bin/bd' },
      capturingRunner,
    );

    const cursor = registry.get('cursor');
    expect(cursor).toBeDefined();
    await cursor!.sendMessage({ projectRootPath: '/tmp/demo-project', projectName: 'demo', message: 'hi' });

    // bdboard-l1t.5 Opus 再レビュー DF9: パスにスペースが入っても壊れないよう
    // シェル向けに二重引用符で囲むようになった(bd-system-prompt.ts)。
    expect(capturedInput).toContain('"/opt/homebrew/bin/bd" -C "/tmp/demo-project"');
  });
});
