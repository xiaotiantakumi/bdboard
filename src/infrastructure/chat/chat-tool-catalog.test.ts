import { describe, expect, it } from 'vitest';
import { BD_TOOL_DEFINITIONS } from './bd-tool-catalog.js';
import { CHAT_TOOL_DEFINITIONS, buildChatToolCommand } from './chat-tool-catalog.js';
import { REPO_TOOL_DEFINITIONS } from './repo-tool-catalog.js';
import { DEPLOY_STATUS_TOOL_DEFINITION } from './deploy-status-tool.js';

const PROJECT_ROOT = '/tmp/bdboard-chat-tool-test';

describe('CHAT_TOOL_DEFINITIONS', () => {
  it('is exactly the bd tools, then the repo tools, then deploy_status, with no duplicates', () => {
    expect(CHAT_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
      ...BD_TOOL_DEFINITIONS.map((tool) => tool.name),
      ...REPO_TOOL_DEFINITIONS.map((tool) => tool.name),
      DEPLOY_STATUS_TOOL_DEFINITION.name,
    ]);

    const names = CHAT_TOOL_DEFINITIONS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('lists deploy_status as readonly (bdboard-3tw.159.5)', () => {
    expect(DEPLOY_STATUS_TOOL_DEFINITION.writes).toBe(false);
  });
});

describe('buildChatToolCommand', () => {
  it('routes bd tools to bd', () => {
    const result = buildChatToolCommand('bd_show', { id: 'bdboard-3tw.13' }, PROJECT_ROOT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.executable).toBe('bd');
    expect(result.args).toContain('show');
    expect(result.outputFilter).toBeUndefined();
  });

  it('carries stdin through for bd tools that use it', () => {
    const result = buildChatToolCommand(
      'bd_comment',
      { id: 'bdboard-3tw.13', text: 'hello' },
      PROJECT_ROOT,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stdin).toBe('hello');
  });

  it('routes repo tools to git and carries the path filter', () => {
    const result = buildChatToolCommand(
      'repo_path_exists',
      { pattern: 'sync-health' },
      PROJECT_ROOT,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.executable).toBe('git');
    expect(result.args).toContain('ls-tree');
    expect(result.outputFilter).toEqual({
      kind: 'paths',
      needle: 'sync-health',
      maxMatches: 200,
    });
    expect(result.stdin).toBeUndefined();
  });

  it('rejects unknown tools', () => {
    const result = buildChatToolCommand('git_push', {}, PROJECT_ROOT);
    expect(result).toEqual({ ok: false, error: 'unknown tool: git_push' });
  });

  it('does not route deploy_status (bdboard-3tw.159.5 runs it via bd-mcp-server.ts instead)', () => {
    // deploy_status is listed in CHAT_TOOL_DEFINITIONS for tools/list, but its
    // execution needs an fs read plus multiple git calls, so it deliberately
    // does not fit this single-command router. bd-mcp-server.ts special-cases
    // it via isDeployStatusToolName before ever calling buildChatToolCommand.
    const result = buildChatToolCommand('deploy_status', {}, PROJECT_ROOT);
    expect(result.ok).toBe(false);
  });

  it('never lets a bd tool name produce a git command, or vice versa', () => {
    // 分岐はツール名の allowlist だけで決まる、という不変条件の固定。
    for (const tool of BD_TOOL_DEFINITIONS) {
      const result = buildChatToolCommand(tool.name, {}, PROJECT_ROOT);
      if (result.ok) {
        expect(result.executable, `${tool.name} must run bd`).toBe('bd');
      }
    }
    for (const tool of REPO_TOOL_DEFINITIONS) {
      const result = buildChatToolCommand(tool.name, {}, PROJECT_ROOT);
      if (result.ok) {
        expect(result.executable, `${tool.name} must run git`).toBe('git');
      }
    }
  });

  it('can only ever build readonly git subcommands', () => {
    // 「チャットから git の書き込み操作は一切できない」を構造として固定する。
    // git 側へ回るのは REPO_TOOL_DEFINITIONS の名前だけで、その3番目の要素
    // (= サブコマンド)は log と ls-tree しか取り得ない。
    const gitSubcommands = new Set<string>();
    for (const tool of CHAT_TOOL_DEFINITIONS) {
      const rawArgs =
        tool.name === 'repo_ticket_landed'
          ? { ticketId: 'bdboard-3tw.151' }
          : tool.name === 'repo_path_exists'
            ? { pattern: 'src' }
            : {};
      const result = buildChatToolCommand(tool.name, rawArgs, PROJECT_ROOT);
      if (result.ok && result.executable === 'git') {
        gitSubcommands.add(result.args[3] ?? '');
      }
    }

    expect([...gitSubcommands].sort()).toEqual(['log', 'ls-tree']);
  });

  it('rejects git write subcommands smuggled in as tool names', () => {
    for (const name of [
      'repo_commit',
      'repo_push',
      'repo_reset',
      'git',
      'git log',
      'bd_show; git push',
    ]) {
      const result = buildChatToolCommand(name, {}, PROJECT_ROOT);
      expect(result.ok, `should reject ${name}`).toBe(false);
    }
  });
});
