import { describe, expect, it } from 'vitest';
import type { RunRequest } from '../ports/agent-runner.js';
import { buildClaudeCommand, MissingSessionIdError } from './build-claude-args.js';

function makeRequest(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    ticketId: 'bd-1',
    projectId: 'proj-1',
    cwd: '/tmp/project',
    mode: 'spawn',
    ...overrides,
  };
}

describe('buildClaudeCommand', () => {
  it('spawn without prompt', () => {
    expect(buildClaudeCommand(makeRequest({ mode: 'spawn' }))).toEqual({
      command: 'claude',
      args: [],
    });
  });

  it('spawn with prompt', () => {
    expect(
      buildClaudeCommand(makeRequest({ mode: 'spawn', prompt: 'do the thing' })),
    ).toEqual({
      command: 'claude',
      args: ['-p', '--', 'do the thing'],
    });
  });

  it('resume without prompt', () => {
    expect(
      buildClaudeCommand(
        makeRequest({ mode: 'resume', sessionId: 'sess-1' }),
      ),
    ).toEqual({
      command: 'claude',
      args: ['--resume', 'sess-1'],
    });
  });

  it('resume with prompt', () => {
    expect(
      buildClaudeCommand(
        makeRequest({
          mode: 'resume',
          sessionId: 'sess-1',
          prompt: 'do the thing',
        }),
      ),
    ).toEqual({
      command: 'claude',
      args: ['--resume', 'sess-1', '--', 'do the thing'],
    });
  });

  it('uses claudePath when provided', () => {
    expect(
      buildClaudeCommand(makeRequest(), {
        claudePath: '/opt/wrappers/claude',
      }),
    ).toEqual({
      command: '/opt/wrappers/claude',
      args: [],
    });
  });

  it('does not escape special characters in prompt', () => {
    const prompt = 'fix "it"; now';
    expect(
      buildClaudeCommand(makeRequest({ mode: 'spawn', prompt })),
    ).toEqual({
      command: 'claude',
      args: ['-p', '--', prompt],
    });
  });

  it('adds permission-mode after -p when configured', () => {
    expect(
      buildClaudeCommand(makeRequest({ mode: 'spawn', prompt: 'go' }), {
        permissionMode: 'acceptEdits',
      }),
    ).toEqual({
      command: 'claude',
      args: ['-p', '--permission-mode', 'acceptEdits', '--', 'go'],
    });
  });

  it('adds setting-sources before allowedTools as a single argv value', () => {
    const result = buildClaudeCommand(
      makeRequest({ mode: 'spawn', prompt: 'go' }),
      {
        permissionMode: 'default',
        settingSources: 'project,local',
        allowedTools: ['Read'],
        disallowedTools: ['WebFetch'],
      },
    );

    expect(result).toEqual({
      command: 'claude',
      args: [
        '-p',
        '--permission-mode',
        'default',
        '--setting-sources',
        // 1 argv トークンのまま渡す。カンマ区切りは CLI 側が解釈する。
        'project,local',
        '--allowedTools',
        'Read',
        '--disallowedTools',
        'WebFetch',
        '--',
        'go',
      ],
    });
  });

  it('omits setting-sources when not requested', () => {
    const result = buildClaudeCommand(
      makeRequest({ mode: 'spawn', prompt: 'go' }),
      { allowedTools: ['Read'] },
    );

    expect(result.args).not.toContain('--setting-sources');
  });

  it('omits setting-sources when the value is empty', () => {
    // 空文字は「全ソース除外」を意味する別の設定なので、うっかり '' を渡したときに
    // それを CLI へ流さない。落とすなら明示的にそう書くこと。
    const result = buildClaudeCommand(
      makeRequest({ mode: 'spawn', prompt: 'go' }),
      { settingSources: '', allowedTools: ['Read'] },
    );

    expect(result.args).not.toContain('--setting-sources');
  });

  it('adds disallowedTools immediately after allowedTools', () => {
    const result = buildClaudeCommand(
      makeRequest({ mode: 'spawn', prompt: 'go' }),
      {
        allowedTools: ['Read'],
        disallowedTools: ['WebFetch', 'Bash(npm:*)'],
      },
    );

    expect(result).toEqual({
      command: 'claude',
      args: [
        '-p',
        '--allowedTools',
        'Read',
        '--disallowedTools',
        'WebFetch',
        'Bash(npm:*)',
        '--',
        'go',
      ],
    });
  });

  it('adds disallowedTools even when allowedTools is omitted', () => {
    const result = buildClaudeCommand(
      makeRequest({ mode: 'spawn', prompt: 'go' }),
      {
        disallowedTools: ['WebFetch'],
      },
    );

    expect(result.args).toEqual([
      '-p',
      '--disallowedTools',
      'WebFetch',
      '--',
      'go',
    ]);
  });

  it('adds allowedTools before prompt with each tool as its own argv element', () => {
    const result = buildClaudeCommand(
      makeRequest({ mode: 'spawn', prompt: 'go' }),
      {
        permissionMode: 'acceptEdits',
        allowedTools: ['Read', 'Bash(bd:*)'],
      },
    );

    expect(result).toEqual({
      command: 'claude',
      args: [
        '-p',
        '--permission-mode',
        'acceptEdits',
        '--allowedTools',
        'Read',
        'Bash(bd:*)',
        '--',
        'go',
      ],
    });

    const promptIndex = result.args.indexOf('go');
    const allowedToolsIndex = result.args.indexOf('--allowedTools');
    expect(allowedToolsIndex).toBeGreaterThanOrEqual(0);
    expect(allowedToolsIndex).toBeLessThan(promptIndex);

    // `--allowedTools <tools...>` is variadic in the Claude CLI, so the prompt
    // must be shielded by a `--` terminator; without it the CLI absorbs the
    // prompt as one more tool name and exits 1 with "Input must be provided...".
    expect(result.args[promptIndex - 1]).toBe('--');
  });

  it('emits the `--` terminator immediately before the prompt for every option combination', () => {
    const cases: Array<Parameters<typeof buildClaudeCommand>[1]> = [
      undefined,
      { permissionMode: 'acceptEdits' },
      { allowedTools: ['Read'] },
      { permissionMode: 'acceptEdits', allowedTools: ['Read', 'Bash(npm:*)'] },
    ];

    for (const options of cases) {
      const { args } = buildClaudeCommand(
        makeRequest({ mode: 'spawn', prompt: 'the prompt' }),
        options,
      );
      expect(args.at(-1)).toBe('the prompt');
      expect(args.at(-2)).toBe('--');
    }
  });

  it('omits the `--` terminator when there is no prompt to shield', () => {
    const { args } = buildClaudeCommand(makeRequest({ mode: 'spawn' }), {
      allowedTools: ['Read'],
    });
    expect(args).not.toContain('--');
  });

  it('omits allowedTools when the list is empty', () => {
    expect(
      buildClaudeCommand(makeRequest({ mode: 'spawn', prompt: 'go' }), {
        allowedTools: [],
      }),
    ).toEqual({
      command: 'claude',
      args: ['-p', '--', 'go'],
    });
  });

  it('does not add -p for resume mode even when prompt is present', () => {
    expect(
      buildClaudeCommand(
        makeRequest({
          mode: 'resume',
          sessionId: 'sess-1',
          prompt: 'continue',
        }),
        { permissionMode: 'acceptEdits' },
      ),
    ).toEqual({
      command: 'claude',
      args: [
        '--resume',
        'sess-1',
        '--permission-mode',
        'acceptEdits',
        '--',
        'continue',
      ],
    });
  });

  it('throws instead of silently building a spawn command when resume has no sessionId', () => {
    // Dropping --resume here would produce the exact argv of a fresh spawn, so a
    // resume request would quietly start a new agent session once dispatch is real.
    expect(() => buildClaudeCommand(makeRequest({ mode: 'resume' }))).toThrow(
      MissingSessionIdError,
    );
    expect(() =>
      buildClaudeCommand(makeRequest({ mode: 'resume', sessionId: '   ' })),
    ).toThrow(MissingSessionIdError);
  });
});
