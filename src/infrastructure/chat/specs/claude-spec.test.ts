import { describe, expect, it } from 'vitest';
import {
  CHAT_FAILURE_MESSAGES,
  type ChatTurnRequest,
} from '../../../application/ports/chat-agent.js';
import { MINIMUM_CLAUDE_VERSION } from '../../../domain/claude-version-check.js';
import { BD_TOOL_DEFINITIONS } from '../bd-tool-catalog.js';
import { buildBdSystemPrompt } from '../bd-system-prompt.js';
import type { CliTurnContext } from '../cli-chat-agent.js';
import {
  CLAUDE_ENV_ALLOWLIST,
  CLAUDE_CHAT_MODELS,
  createClaudeSpec,
} from './claude-spec.js';

const PROJECT_ROOT = '/tmp/bdboard-chat-agent';
const PROJECT_NAME = 'bdboard-test';
const MCP_ENTRY = '/abs/bd-mcp-server-main.ts';
const NODE_EXEC = '/usr/bin/node';
const NODE_EXEC_ARGV = ['--import', 'file:///abs/tsx/loader.mjs'] as const;
const BD_PATH = 'bd-custom';
const MODEL = 'sonnet';
const CLAUDE_PATH = '/opt/claude';

const SYSTEM_PROMPT = buildBdSystemPrompt({
  projectName: PROJECT_NAME,
  projectRootPath: PROJECT_ROOT,
  capability: 'bd-only',
});

const MCP_CONFIG_JSON = JSON.stringify({
  mcpServers: {
    bd: {
      command: NODE_EXEC,
      args: [
        ...NODE_EXEC_ARGV,
        MCP_ENTRY,
        '--project-root',
        PROJECT_ROOT,
        '--bd-path',
        BD_PATH,
      ],
    },
  },
});

const ALLOWED_TOOLS = BD_TOOL_DEFINITIONS.map((tool) => `mcp__bd__${tool.name}`).join(',');

const NEW_TURN_ARGS = [
  '-p',
  '--output-format',
  'json',
  '--model',
  MODEL,
  '--system-prompt',
  SYSTEM_PROMPT,
  '--tools',
  '',
  '--strict-mcp-config',
  '--mcp-config',
  MCP_CONFIG_JSON,
  '--allowedTools',
  ALLOWED_TOOLS,
  '--setting-sources',
  '',
] as const;

function makeContext(): CliTurnContext {
  return {
    systemPrompt: SYSTEM_PROMPT,
    mcpServers: [
      {
        name: 'bd',
        command: NODE_EXEC,
        args: [
          ...NODE_EXEC_ARGV,
          MCP_ENTRY,
          '--project-root',
          PROJECT_ROOT,
          '--bd-path',
          BD_PATH,
        ],
      },
    ],
    toolNames: BD_TOOL_DEFINITIONS.map((tool) => tool.name),
    scratchDir: '/tmp',
  };
}

function makeRequest(
  overrides: Partial<ChatTurnRequest> = {},
): ChatTurnRequest {
  return {
    projectRootPath: PROJECT_ROOT,
    projectName: PROJECT_NAME,
    message: '着手可能なチケットを教えて',
    ...overrides,
  };
}

describe('createClaudeSpec', () => {
  const spec = createClaudeSpec({
    claudePath: CLAUDE_PATH,
    model: MODEL,
    timeoutMs: 180_000,
  });

  it('buildTurn argv for a new turn matches the golden argv list', () => {
    const plan = spec.buildTurn(makeRequest(), makeContext());
    expect(plan.args).toEqual([...NEW_TURN_ARGS]);
    expect(plan.stdin).toBe('着手可能なチケットを教えて');
  });

  it('buildTurn argv for resume places --resume at the end', () => {
    const plan = spec.buildTurn(
      makeRequest({ resumeSessionId: 'session-abc' }),
      makeContext(),
    );
    expect(plan.args).toEqual([...NEW_TURN_ARGS, '--resume', 'session-abc']);
  });

  it('buildTurn mcp-config JSON matches the golden string', () => {
    const plan = spec.buildTurn(makeRequest(), makeContext());
    const mcpConfigIndex = plan.args.indexOf('--mcp-config');
    expect(plan.args[mcpConfigIndex + 1]).toBe(MCP_CONFIG_JSON);
  });

  it('envAllowlist has exactly twelve keys', () => {
    expect(CLAUDE_ENV_ALLOWLIST).toHaveLength(12);
    expect(spec.envAllowlist).toEqual(CLAUDE_ENV_ALLOWLIST);
  });

  it('descriptor identifies claude as a non-experimental bd-only agent', () => {
    expect(spec.descriptor).toEqual({
      id: 'claude',
      label: 'Claude Code',
      model: MODEL,
      models: [...CLAUDE_CHAT_MODELS],
      experimental: false,
      capability: 'bd-only',
      supportsStreaming: true,
    });
  });

  it('buildTurn uses request.model for --model when specified', () => {
    const plan = spec.buildTurn(makeRequest({ model: 'opus' }), makeContext());
    const modelIndex = plan.args.indexOf('--model');
    expect(plan.args[modelIndex + 1]).toBe('opus');
  });

  // 「セッション継続中にモデルだけ変えられる」が設計の要なので、resume と併用したときに
  // --model と --resume が両方 argv に載ることを固定しておく。
  it('buildTurn keeps a per-turn model when resuming a session', () => {
    const plan = spec.buildTurn(
      makeRequest({ model: 'opus', resumeSessionId: 'session-abc' }),
      makeContext(),
    );
    const modelIndex = plan.args.indexOf('--model');
    expect(plan.args[modelIndex + 1]).toBe('opus');
    expect(plan.args.slice(-2)).toEqual(['--resume', 'session-abc']);
  });

  it('buildTurn uses the default model for --model when request.model is omitted', () => {
    const plan = spec.buildTurn(makeRequest(), makeContext());
    const modelIndex = plan.args.indexOf('--model');
    expect(plan.args[modelIndex + 1]).toBe(MODEL);
  });

  it('prepends options.model to descriptor.models when it is missing from the configured list', () => {
    const customSpec = createClaudeSpec({
      claudePath: CLAUDE_PATH,
      model: 'custom-model',
      timeoutMs: 180_000,
    });

    expect(customSpec.descriptor.models).toEqual([
      { id: 'custom-model', label: 'custom-model', weight: 1 },
      ...CLAUDE_CHAT_MODELS,
    ]);
  });

  // bdboard-3tw.104.11 Opus レビュー MF1 の回帰テスト。修正前は normalizeModelList が
  // prepend するエントリに weight を付けておらず、一覧外の opus 系カスタム ID を既定モデルに
  // 設定した運用者のリクエストが宣言なし(→ chat-routes.ts の default フォールバック)に落ちて
  // 5 のはずが 1 で数えられていた。値をリテラルで固定しているので、DEFAULT_CLAUDE_MODEL_WEIGHTS
  // を書き換えたらこのテストも追随して落ちる。
  it('weights an unlisted opus-like custom model id at the opus weight (bdboard-3tw.104.11 MF1)', () => {
    const customSpec = createClaudeSpec({
      claudePath: CLAUDE_PATH,
      model: 'my-opus-4-custom',
      timeoutMs: 180_000,
    });

    expect(customSpec.descriptor.models?.[0]).toEqual({
      id: 'my-opus-4-custom',
      label: 'my-opus-4-custom',
      weight: 5,
    });
  });

  it('weights an unlisted haiku-like custom model id at the (overridden) haiku weight (bdboard-3tw.104.11 MF1)', () => {
    const customSpec = createClaudeSpec({
      claudePath: CLAUDE_PATH,
      model: 'my-HAIKU-mini',
      timeoutMs: 180_000,
      modelWeights: { haiku: 3 },
    });

    expect(customSpec.descriptor.models?.[0]).toEqual({
      id: 'my-HAIKU-mini',
      label: 'my-HAIKU-mini',
      weight: 3,
    });
  });

  it('weights an unlisted model id that matches no claude alias at the sonnet weight', () => {
    const customSpec = createClaudeSpec({
      claudePath: CLAUDE_PATH,
      model: 'my-custom-model',
      timeoutMs: 180_000,
      modelWeights: { sonnet: 2 },
    });

    expect(customSpec.descriptor.models?.[0]).toEqual({
      id: 'my-custom-model',
      label: 'my-custom-model',
      weight: 2,
    });
  });

  it('applies modelWeights overrides to the standard CLAUDE_CHAT_MODELS entries', () => {
    const customSpec = createClaudeSpec({
      claudePath: CLAUDE_PATH,
      model: MODEL,
      timeoutMs: 180_000,
      modelWeights: { opus: 9 },
    });

    expect(customSpec.descriptor.models?.find((entry) => entry.id === 'opus')?.weight).toBe(9);
    expect(customSpec.descriptor.models?.find((entry) => entry.id === 'sonnet')?.weight).toBe(1);
    expect(customSpec.descriptor.models?.find((entry) => entry.id === 'haiku')?.weight).toBe(1);
  });

  it('uses only the configured models list without prepending defaults', () => {
    const customSpec = createClaudeSpec({
      claudePath: CLAUDE_PATH,
      model: 'opus',
      timeoutMs: 180_000,
      models: ['opus', 'haiku'],
    });

    expect(customSpec.descriptor.models).toEqual([
      { id: 'opus', label: 'Opus', weight: 5 },
      { id: 'haiku', label: 'Haiku', weight: 1 },
    ]);
  });

  it('includes unlisted custom model ids from the configured models list', () => {
    const customSpec = createClaudeSpec({
      claudePath: CLAUDE_PATH,
      model: 'sonnet',
      timeoutMs: 180_000,
      models: ['sonnet', 'my-custom-model'],
    });

    expect(customSpec.descriptor.models).toContainEqual({
      id: 'my-custom-model',
      label: 'my-custom-model',
      weight: 1,
    });
  });

  it('keeps the default CLAUDE_CHAT_MODELS when models is omitted', () => {
    const customSpec = createClaudeSpec({
      claudePath: CLAUDE_PATH,
      model: MODEL,
      timeoutMs: 180_000,
    });

    expect(customSpec.descriptor.models).toEqual([...CLAUDE_CHAT_MODELS]);
  });

  it('parseTurn throws agent-bad-output on invalid JSON', () => {
    expect(() =>
      spec.parseTurn({ stdout: 'not-json', stderr: '', exitCode: 0 }, () => undefined),
    ).toThrow(
      expect.objectContaining({
        code: 'agent-bad-output',
        detail: CHAT_FAILURE_MESSAGES['agent-bad-output'],
      }),
    );
  });

  it('parseTurn throws agent-unexpected-output on schema mismatch', () => {
    expect(() =>
      spec.parseTurn(
        { stdout: JSON.stringify({ foo: 'bar' }), stderr: '', exitCode: 0 },
        () => undefined,
      ),
    ).toThrow(
      expect.objectContaining({
        code: 'agent-unexpected-output',
        detail: CHAT_FAILURE_MESSAGES['agent-unexpected-output'],
      }),
    );
  });

  it('parseTurn uses the canonical model with the highest modelUsage cost', () => {
    const result = spec.parseTurn(
      {
        stdout: JSON.stringify({
          result: 'ok',
          session_id: 'session-sonnet',
          modelUsage: {
            'claude-haiku-4-5-20251001': {
              costUSD: 0.000581,
              canonicalModel: 'claude-haiku-4-5',
            },
            'claude-sonnet-5': {
              costUSD: 0.304164,
              canonicalModel: 'claude-sonnet-5',
            },
          },
        }),
        stderr: '',
        exitCode: 0,
      },
      () => undefined,
    );

    expect(result.model).toBe('claude-sonnet-5');
  });

  it('parseTurn falls back to the modelUsage key without canonicalModel', () => {
    const result = spec.parseTurn(
      {
        stdout: JSON.stringify({
          result: 'reply-with-renamed-cost-field',
          session_id: 'session-key',
          modelUsage: { 'claude-sonnet-5': { cost_usd: 1 } },
        }),
        stderr: '',
        exitCode: 0,
      },
      () => undefined,
    );

    expect(result.model).toBe('claude-sonnet-5');
    expect(result.reply).toBe('reply-with-renamed-cost-field');
  });

  it.each([
    ['null', null],
    ['an array', []],
  ])('keeps the reply and omits model when modelUsage is %s', (_label, modelUsage) => {
    const result = spec.parseTurn(
      {
        stdout: JSON.stringify({
          result: 'reply-preserved',
          session_id: 'session-invalid-usage',
          modelUsage,
        }),
        stderr: '',
        exitCode: 0,
      },
      () => undefined,
    );

    expect(result.reply).toBe('reply-preserved');
    expect(result).not.toHaveProperty('model');
  });

  it('keeps the reply and omits model when modelUsage is empty', () => {
    const result = spec.parseTurn(
      {
        stdout: JSON.stringify({
          result: 'reply-preserved',
          session_id: 'session-empty-usage',
          modelUsage: {},
        }),
        stderr: '',
        exitCode: 0,
      },
      () => undefined,
    );

    expect(result.reply).toBe('reply-preserved');
    expect(result).not.toHaveProperty('model');
  });

  it('keeps the reply and omits model when multiple zero-cost entries tie', () => {
    const result = spec.parseTurn(
      {
        stdout: JSON.stringify({
          result: 'reply-preserved',
          session_id: 'session-zero-usage',
          modelUsage: {
            'claude-haiku-4-5': { costUSD: 0 },
            'claude-sonnet-5': { costUSD: 0 },
          },
        }),
        stderr: '',
        exitCode: 0,
      },
      () => undefined,
    );

    expect(result.reply).toBe('reply-preserved');
    expect(result).not.toHaveProperty('model');
  });

  it('keeps the reply and adopts a single zero-cost entry', () => {
    const result = spec.parseTurn(
      {
        stdout: JSON.stringify({
          result: 'reply-preserved',
          session_id: 'session-single-zero-usage',
          modelUsage: {
            'claude-sonnet-5': { costUSD: 0, canonicalModel: 'claude-sonnet-5-canonical' },
          },
        }),
        stderr: '',
        exitCode: 0,
      },
      () => undefined,
    );

    expect(result.reply).toBe('reply-preserved');
    expect(result.model).toBe('claude-sonnet-5-canonical');
  });

  it('parseTurn omits model when modelUsage is absent', () => {
    const result = spec.parseTurn(
      {
        stdout: JSON.stringify({ result: 'ok', session_id: 'session-no-model' }),
        stderr: '',
        exitCode: 0,
      },
      () => undefined,
    );

    expect(result).not.toHaveProperty('model');
  });

  it('buildStreamingTurn uses stream-json partial-message flags and supports resume', () => {
    const plan = spec.buildStreamingTurn!(makeRequest(), makeContext());
    const outputFormatIndex = plan.args.indexOf('--output-format');

    expect(plan.args[outputFormatIndex + 1]).toBe('stream-json');
    expect(plan.args).toContain('--include-partial-messages');
    expect(plan.args).toContain('--verbose');
    expect(plan.args[outputFormatIndex + 1]).not.toBe('json');

    const resumedPlan = spec.buildStreamingTurn!(
      makeRequest({ resumeSessionId: 'session-abc' }),
      makeContext(),
    );
    expect(resumedPlan.args.slice(-2)).toEqual(['--resume', 'session-abc']);
  });

  describe('parseStreamChunk', () => {
    it('returns only text_delta content', () => {
      expect(
        spec.parseStreamChunk!(
          '{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"hi"}}}',
        ),
      ).toEqual({ delta: 'hi' });
    });

    it('does not expose thinking_delta content', () => {
      expect(
        spec.parseStreamChunk!(
          '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"secret reasoning","estimated_tokens":null}}}',
        ),
      ).toBeUndefined();
    });

    it.each([
      '{"type":"system","subtype":"init","session_id":"session"}',
      '{"type":"stream_event","event":{"type":"message_start","message":{}}}',
      '',
      'not json at all',
    ])('ignores non-text or malformed line %j', (line) => {
      expect(spec.parseStreamChunk!(line)).toBeUndefined();
    });
  });

  it('parseStreamResult parses the final result line exactly like parseTurn', () => {
    const resultLine = JSON.stringify({
      type: 'result',
      result: 'final reply',
      session_id: 'session-result',
      permission_denials: [{ tool_name: 'Bash' }],
      modelUsage: {
        'claude-haiku-4-5-20251001': {
          costUSD: 0.01,
          canonicalModel: 'claude-haiku-4-5',
        },
        'claude-sonnet-5': {
          costUSD: 0.3,
          canonicalModel: 'claude-sonnet-5',
        },
      },
    });
    const fullStdout = [
      '{"type":"system","subtype":"init"}',
      '{"type":"stream_event","event":{"type":"message_start"}}',
      resultLine,
      '',
      '  ',
    ].join('\n');

    const expected = spec.parseTurn(
      { stdout: resultLine, stderr: '', exitCode: 0 },
      () => undefined,
    );
    expect(spec.parseStreamResult!(fullStdout, () => undefined)).toEqual(expected);
  });
});

describe('createClaudeSpec authProbe (bdboard-15v)', () => {
  // 2026-09-05 実測 (claude-code 2026.09.02-c22c1a3, bdboard-6ids) でフィクスチャが実態と
  // 一致していることを確認済み。ログイン済み = exit 0 / 未ログイン = exit 1、どちらも stdout
  // に JSON を書き stderr は空 (codex が stderr に書くのと対照的)。未ログインの実物は
  // {"loggedIn": false, "authMethod": "none", "apiProvider": "firstParty"} でフィクスチャと
  // 同一。実物は pretty-print (複数行) だが JSON.parse(result.stdout) はそのまま解析できるので
  // 影響なし。未ログイン状態は空の一時ディレクトリを CLAUDE_CONFIG_DIR に指定して再現した
  // (ログアウトはしていない)。
  const spec = createClaudeSpec({
    claudePath: CLAUDE_PATH,
    model: MODEL,
    timeoutMs: 180_000,
  });

  it("authProbe uses 'claude auth status --json' and never sends a prompt", () => {
    expect(spec.authProbe?.args).toEqual(['auth', 'status', '--json']);
    expect(spec.authProbe?.args).not.toContain('-p');
    expect(spec.authProbe?.args).not.toContain('--print');
  });

  it("authProbe reports 'unavailable' when the CLI is not logged in", () => {
    const result = spec.authProbe!.interpret({
      stdout: JSON.stringify({
        loggedIn: false,
        authMethod: 'none',
        apiProvider: 'firstParty',
      }),
      stderr: '',
      exitCode: 1,
    });
    expect(result).toBe('unavailable');
  });

  it("authProbe reports 'available' when the CLI is logged in", () => {
    const result = spec.authProbe!.interpret({
      stdout: JSON.stringify({
        loggedIn: true,
        authMethod: 'claude.ai',
        apiProvider: 'firstParty',
      }),
      stderr: '',
      exitCode: 0,
    });
    expect(result).toBe('available');
  });

  it("authProbe reports 'unknown' when the output is not JSON", () => {
    const result = spec.authProbe!.interpret({
      stdout: '',
      stderr: "error: unknown command 'auth'",
      exitCode: 1,
    });
    expect(result).toBe('unknown');
  });

  it("authProbe reports 'unknown' when the JSON lacks loggedIn", () => {
    const result = spec.authProbe!.interpret({
      stdout: '{"foo":1}',
      stderr: '',
      exitCode: 0,
    });
    expect(result).toBe('unknown');
  });

  it("authProbe reports 'unknown' on timeout", () => {
    const result = spec.authProbe!.interpret({
      stdout: '',
      stderr: 'timed out',
      exitCode: -1,
      failureKind: 'timeout',
    });
    expect(result).toBe('unknown');
  });
});

describe('createClaudeSpec classifyFailure (bdboard-ndky)', () => {
  const spec = createClaudeSpec({
    claudePath: CLAUDE_PATH,
    model: MODEL,
    timeoutMs: 180_000,
  });

  it('classifies stderr when an old CLI rejects --setting-sources (empty value)', () => {
    expect(
      spec.classifyFailure?.({
        stdout: '',
        stderr: "error: unknown option '--setting-sources'",
        exitCode: 1,
      }),
    ).toBe('agent-claude-cli-too-old');
  });

  it('returns undefined for unrelated stderr so the generic classifier takes over', () => {
    expect(
      spec.classifyFailure?.({ stdout: '', stderr: 'some other error', exitCode: 1 }),
    ).toBeUndefined();
  });

  it('defers to the generic failureKind classifier when the process never started or timed out', () => {
    expect(
      spec.classifyFailure?.({
        stdout: '',
        stderr: "error: unknown option '--setting-sources'",
        exitCode: -1,
        failureKind: 'spawn-failed',
      }),
    ).toBeUndefined();
    expect(
      spec.classifyFailure?.({
        stdout: '',
        stderr: "error: unknown option '--setting-sources'",
        exitCode: -1,
        failureKind: 'timeout',
      }),
    ).toBeUndefined();
  });

  it('maps the classified code to a user-facing message that names the minimum version', () => {
    expect(CHAT_FAILURE_MESSAGES['agent-claude-cli-too-old']).toContain(MINIMUM_CLAUDE_VERSION);
    expect(CHAT_FAILURE_MESSAGES['agent-claude-cli-too-old']).toContain('--setting-sources');
  });
});
