import { describe, expect, it } from 'vitest';
import type { CommandResult, CommandRunner } from '../../application/ports/command-runner.js';
import { createNodeAiQuotaSource, parseAiQuotaOutput } from './ai-quota-source.js';

function createFakeRunner(
  handler: (command: string, args: readonly string[]) => Promise<CommandResult> | CommandResult,
): { runner: CommandRunner; calls: Array<{ command: string; args: readonly string[] }> } {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const runner: CommandRunner = {
    async run(command, args) {
      calls.push({ command, args });
      return handler(command, args);
    },
  };
  return { runner, calls };
}

const SAMPLE_STDOUT = [
  '=== AI quota / usage — live ===',
  '',
  '## agy — Antigravity (Gemini sub) (Google)',
  '  Account: example-user@gmail.com  [Google AI Pro]',
  '  GEMINI MODELS',
  '  Models within this group: Gemini Flash, Gemini Pro',
  '  Weekly Limit Remaining',
  '  92% remaining · Refreshes in 88h 21m',
  '  Five Hour Limit Remaining',
  '  99% remaining · Refreshes in 4h 42m',
  '  CLAUDE AND GPT MODELS',
  '  Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
  '  Weekly Limit Remaining',
  '  Quota available',
  '  Five Hour Limit Remaining',
  '  Quota available',
  '',
  'ほかの連携AI（確認方法）:',
  '  - codex (Codex (ChatGPT sub)): codex 起動 → `/status`。',
  '  - claude (Claude Code (claude.ai sub)): claude セッション内で `/usage`。',
  '',
  '個別: `ai-quota <name>` / 全部: `ai-quota all` / 一覧: `ai-quota --list`',
].join('\n');

const ALL_MODE_STDOUT = [
  '=== AI quota / usage — live ===',
  '',
  '## agy — Antigravity (Gemini sub) (Google)',
  '  Weekly Limit Remaining',
  '  92% remaining · Refreshes in 88h 21m',
  '',
  '## codex — Codex (ChatGPT sub) (OpenAI)',
  '  Usage limit: codex',
  '  │ 5h limit: 81% left (resets 4:42 PM) │',
  '  │ Weekly limit: 64% left (resets 8:00 AM on Aug 22) │',
  '  Credits: 25 credits',
  '  codex-other limit:',
  '  │ 5h limit: [███░] 40% left (resets 6:15 PM) │',
  '  300 of 1000 credits used',
  '',
  '## claude — Claude Code (claude.ai sub) (Anthropic)',
  '  確認方法: claude セッション内で `/usage`（プラン使用量・5h/週次）。',
  '',
  '## cursor — Cursor (cursor-agent) (Anysphere)',
  '  確認方法: CLI に残量コマンド無し。https://cursor.com/dashboard で確認。',
  '',
  '## gemini — Gemini CLI (Google)',
  '  (ライブ取得できず) 確認方法: AI Studio / Cloud Console で確認。',
  '',
].join('\n');

describe('parseAiQuotaOutput', () => {
  it('parses percent+reset metrics and drops PII, keeping only the plan', () => {
    const fetchedAt = new Date('2026-08-15T00:00:00.000Z');
    const providers = parseAiQuotaOutput(SAMPLE_STDOUT, fetchedAt);

    expect(providers).toHaveLength(1);
    const agy = providers[0];
    expect(agy.id).toBe('agy');
    expect(agy.label).toBe('Antigravity (Gemini sub)');
    expect(agy.vendor).toBe('Google');
    expect(agy.plan).toBe('Google AI Pro');
    expect(agy.availability).toBe('live');
    expect(agy.detail).toBeUndefined();

    expect(agy.metrics).toHaveLength(4);
    const weekly = agy.metrics.find((m) => m.label === 'GEMINI MODELS Weekly Limit Remaining');
    expect(weekly?.percentRemaining).toBe(92);
    expect(weekly?.resetInText).toBe('88h 21m');
    expect(weekly?.resetAt?.toISOString()).toBe(
      new Date(fetchedAt.getTime() + 88 * 3_600_000 + 21 * 60_000).toISOString(),
    );

    const fiveHour = agy.metrics.find(
      (m) => m.label === 'GEMINI MODELS Five Hour Limit Remaining',
    );
    expect(fiveHour?.percentRemaining).toBe(99);

    const claudeWeekly = agy.metrics.find(
      (m) => m.label === 'CLAUDE AND GPT MODELS Weekly Limit Remaining',
    );
    expect(claudeWeekly?.status).toBe('available');
    expect(claudeWeekly?.percentRemaining).toBeUndefined();
  });

  it('keeps all providers, including manual and unavailable entries, and parses Codex metrics', () => {
    const fetchedAt = new Date('2026-08-15T00:00:00.000Z');
    const providers = parseAiQuotaOutput(ALL_MODE_STDOUT, fetchedAt);
    expect(providers.map((provider) => provider.id)).toEqual([
      'agy',
      'codex',
      'claude',
      'cursor',
      'gemini',
    ]);

    const codex = providers[1];
    expect(codex.availability).toBe('live');
    expect(codex.metrics).toEqual([
      {
        label: 'codex 5h limit',
        percentRemaining: 81,
        resetInText: '4:42 PM',
        resetAt: expect.any(Date),
      },
      {
        label: 'codex Weekly limit',
        percentRemaining: 64,
        resetInText: '8:00 AM on Aug 22',
        resetAt: expect.any(Date),
      },
      {
        label: 'codex Credits',
        valueText: '25 credits',
      },
      {
        label: 'codex-other 5h limit',
        percentRemaining: 40,
        resetInText: '6:15 PM',
        resetAt: expect.any(Date),
      },
      {
        label: 'codex-other Credits',
        valueText: '300 of 1000 credits used',
      },
    ]);
    for (const metric of codex.metrics.filter((item) => item.resetAt !== undefined)) {
      expect(metric.resetAt!.getTime()).toBeGreaterThan(fetchedAt.getTime());
    }

    expect(providers[2]).toMatchObject({
      id: 'claude',
      availability: 'manual',
      metrics: [],
      detail: expect.stringContaining('/usage'),
    });
    expect(providers[3]).toMatchObject({
      id: 'cursor',
      availability: 'manual',
      metrics: [],
      detail: expect.stringContaining('cursor.com/dashboard'),
    });
    expect(providers[4]).toMatchObject({
      id: 'gemini',
      availability: 'unavailable',
      metrics: [],
      detail: expect.stringContaining('ライブ取得できず'),
    });
  });

  it('does not expose auto-probe exception details', () => {
    const stdout = [
      '## codex — Codex (ChatGPT sub) (OpenAI)',
      '  (自動取得に失敗: /Users/private-account/.codex denied)',
      '  (ライブ取得できず) 確認方法: codex 起動 → `/status`。',
    ].join('\n');
    const [provider] = parseAiQuotaOutput(stdout, new Date());

    expect(provider.availability).toBe('unavailable');
    expect(provider.detail).toContain('/status');
    expect(JSON.stringify(provider)).not.toContain('private-account');
  });

  it('marks an unrecognized metric format as unavailable instead of manual-only', () => {
    const stdout = [
      '## codex — Codex (ChatGPT sub) (OpenAI)',
      '  Rate limit information changed to an unknown format',
    ].join('\n');
    const [provider] = parseAiQuotaOutput(stdout, new Date());

    expect(provider).toMatchObject({
      id: 'codex',
      availability: 'unavailable',
      metrics: [],
      detail: expect.stringContaining('数値メトリクスを取得できません'),
    });
  });

  it('returns an empty list when the output has no provider blocks', () => {
    const providers = parseAiQuotaOutput('some unrelated banner text\n', new Date());
    expect(providers).toEqual([]);
  });
});

describe('createNodeAiQuotaSource', () => {
  it('runs the configured command in all mode by default and parses stdout', async () => {
    const { runner, calls } = createFakeRunner(() => ({
      stdout: SAMPLE_STDOUT,
      stderr: '',
      exitCode: 0,
    }));
    const source = createNodeAiQuotaSource(runner);

    const result = await source.fetch();

    expect(calls).toEqual([{ command: 'ai-quota', args: ['all'] }]);
    expect(result.providers).toHaveLength(1);
    expect(result.providers[0].id).toBe('agy');
    expect(result.fetchedAt).toBeInstanceOf(Date);
  });

  it('honors a custom command/args/timeout', async () => {
    const { runner, calls } = createFakeRunner(() => ({
      stdout: SAMPLE_STDOUT,
      stderr: '',
      exitCode: 0,
    }));
    const source = createNodeAiQuotaSource(runner, {
      command: '/opt/custom/ai-quota',
      args: ['all'],
      timeoutMs: 5_000,
    });

    await source.fetch();

    expect(calls).toEqual([{ command: '/opt/custom/ai-quota', args: ['all'] }]);
  });

  it('throws when the command exits non-zero without leaking tool output', async () => {
    const { runner } = createFakeRunner(() => ({
      stdout: '',
      stderr: 'failure for private-account@example.com',
      exitCode: 127,
    }));
    const source = createNodeAiQuotaSource(runner);

    await expect(source.fetch()).rejects.toThrow(/^ai-quota exited with code 127$/);
  });

  it('throws a safe error when the command succeeds without provider blocks', async () => {
    const { runner } = createFakeRunner(() => ({
      stdout: 'unexpected output',
      stderr: '',
      exitCode: 0,
    }));
    const source = createNodeAiQuotaSource(runner);

    await expect(source.fetch()).rejects.toThrow(/^ai-quota returned no provider data$/);
  });
});
