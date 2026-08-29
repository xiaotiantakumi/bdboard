import { describe, expect, it } from 'vitest';
import {
  BD_TOOL_DEFINITIONS,
  buildBdToolArgs,
} from './bd-tool-catalog.js';

const PROJECT_ROOT = '/tmp/bdboard-test-project';

describe('BD_TOOL_DEFINITIONS', () => {
  it('exposes exactly 19 tools', () => {
    expect(BD_TOOL_DEFINITIONS).toHaveLength(19);
    expect(BD_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
      'bd_list',
      'bd_ready',
      'bd_blocked',
      'bd_show',
      'bd_update_status',
      'bd_update_title',
      'bd_update_description',
      'bd_append_notes',
      'bd_claim',
      'bd_close',
      'bd_comment',
      'bd_defer',
      'bd_priority',
      'bd_label_add',
      'bd_label_remove',
      'bd_create',
      'bd_search',
      'bd_dep_add',
      'bd_dep_remove',
    ]);
  });
});

describe('buildBdToolArgs', () => {
  it('builds bd_list argv with defaults', () => {
    const result = buildBdToolArgs('bd_list', {}, PROJECT_ROOT);
    expect(result).toEqual({
      ok: true,
      args: [
        '--readonly',
        '-C',
        PROJECT_ROOT,
        'list',
        '--json',
        '--no-pager',
        '-n',
        '50',
      ],
    });
  });

  it('builds bd_list argv with status and limit', () => {
    const result = buildBdToolArgs(
      'bd_list',
      { status: 'open,in_progress', limit: 10 },
      PROJECT_ROOT,
    );
    expect(result).toEqual({
      ok: true,
      args: [
        '--readonly',
        '-C',
        PROJECT_ROOT,
        'list',
        '--json',
        '--no-pager',
        '-n',
        '10',
        '-s',
        'open,in_progress',
      ],
    });
  });

  it('builds bd_ready argv with defaults', () => {
    const result = buildBdToolArgs('bd_ready', {}, PROJECT_ROOT);
    expect(result).toEqual({
      ok: true,
      args: ['--readonly', '-C', PROJECT_ROOT, 'ready', '--json', '-n', '20'],
    });
  });

  it('builds bd_ready argv with limit', () => {
    const result = buildBdToolArgs('bd_ready', { limit: 5 }, PROJECT_ROOT);
    expect(result).toEqual({
      ok: true,
      args: ['--readonly', '-C', PROJECT_ROOT, 'ready', '--json', '-n', '5'],
    });
  });

  it('builds bd_blocked argv', () => {
    const result = buildBdToolArgs('bd_blocked', {}, PROJECT_ROOT);
    expect(result).toEqual({
      ok: true,
      args: ['--readonly', '-C', PROJECT_ROOT, 'blocked', '--json'],
    });
  });

  it('builds bd_show argv', () => {
    const result = buildBdToolArgs('bd_show', { id: 'bdboard-3tw.13' }, PROJECT_ROOT);
    expect(result).toEqual({
      ok: true,
      args: [
        '--readonly',
        '-C',
        PROJECT_ROOT,
        'show',
        '--json',
        '--include-comments',
        '--id=bdboard-3tw.13',
      ],
    });
  });

  it('builds bd_update_status argv', () => {
    const result = buildBdToolArgs(
      'bd_update_status',
      { id: 'bdboard-3tw.13', status: 'in_progress' },
      PROJECT_ROOT,
    );
    expect(result).toEqual({
      ok: true,
      args: ['-C', PROJECT_ROOT, 'update', 'bdboard-3tw.13', '-s', 'in_progress'],
    });
  });

  it('builds bd_update_title argv', () => {
    const result = buildBdToolArgs(
      'bd_update_title',
      { id: 'bdboard-3tw.13', title: 'Revised title' },
      PROJECT_ROOT,
    );
    expect(result).toEqual({
      ok: true,
      args: [
        '-C',
        PROJECT_ROOT,
        'update',
        'bdboard-3tw.13',
        '--title',
        'Revised title',
      ],
    });
  });

  it('builds bd_update_description argv with stdin', () => {
    const result = buildBdToolArgs(
      'bd_update_description',
      { id: 'bdboard-3tw.13', description: 'line1\nline2' },
      PROJECT_ROOT,
    );
    expect(result).toEqual({
      ok: true,
      args: ['-C', PROJECT_ROOT, 'update', 'bdboard-3tw.13', '--stdin'],
      stdin: 'line1\nline2',
    });
  });

  it('builds bd_append_notes argv with direct notes argument', () => {
    const result = buildBdToolArgs(
      'bd_append_notes',
      { id: 'bdboard-3tw.13', notes: 'memo line1\nmemo line2' },
      PROJECT_ROOT,
    );
    expect(result).toEqual({
      ok: true,
      args: [
        '-C',
        PROJECT_ROOT,
        'update',
        'bdboard-3tw.13',
        '--append-notes',
        'memo line1\nmemo line2',
      ],
    });
  });

  it('builds bd_claim argv', () => {
    const result = buildBdToolArgs('bd_claim', { id: 'bdboard-3tw.13' }, PROJECT_ROOT);
    expect(result).toEqual({
      ok: true,
      args: ['-C', PROJECT_ROOT, 'update', 'bdboard-3tw.13', '--claim'],
    });
  });

  it('builds bd_close argv without reason', () => {
    const result = buildBdToolArgs('bd_close', { id: 'bdboard-3tw.13' }, PROJECT_ROOT);
    expect(result).toEqual({
      ok: true,
      args: ['-C', PROJECT_ROOT, 'close', 'bdboard-3tw.13'],
    });
  });

  it('builds bd_close argv with reason', () => {
    const result = buildBdToolArgs(
      'bd_close',
      { id: 'bdboard-3tw.13', reason: 'done' },
      PROJECT_ROOT,
    );
    expect(result).toEqual({
      ok: true,
      args: ['-C', PROJECT_ROOT, 'close', 'bdboard-3tw.13', '-r', 'done'],
    });
  });

  it('builds bd_comment argv with stdin text', () => {
    const result = buildBdToolArgs(
      'bd_comment',
      { id: 'bdboard-3tw.13', text: 'progress update' },
      PROJECT_ROOT,
    );
    expect(result).toEqual({
      ok: true,
      args: ['-C', PROJECT_ROOT, 'comment', 'bdboard-3tw.13', '--stdin'],
      stdin: 'progress update',
    });
  });

  it('builds bd_defer argv', () => {
    const result = buildBdToolArgs(
      'bd_defer',
      { id: 'bdboard-3tw.13', untilDate: '2026-08-22' },
      PROJECT_ROOT,
    );
    expect(result).toEqual({
      ok: true,
      args: [
        '-C',
        PROJECT_ROOT,
        'update',
        'bdboard-3tw.13',
        '--defer',
        '2026-08-22',
      ],
    });
  });

  it('builds bd_priority argv', () => {
    const result = buildBdToolArgs(
      'bd_priority',
      { id: 'bdboard-3tw.13', priority: 2 },
      PROJECT_ROOT,
    );
    expect(result).toEqual({
      ok: true,
      args: ['-C', PROJECT_ROOT, 'update', 'bdboard-3tw.13', '-p', '2'],
    });
  });

  it('builds bd_create argv with all fields', () => {
    const result = buildBdToolArgs(
      'bd_create',
      {
        title: 'New feature',
        description: 'Detailed description',
        type: 'feature',
        priority: 1,
        parent: 'bdboard-3tw.10',
      },
      PROJECT_ROOT,
    );
    expect(result).toEqual({
      ok: true,
      args: [
        '-C',
        PROJECT_ROOT,
        'create',
        '--title',
        'New feature',
        '--type',
        'feature',
        '--priority',
        '1',
        '--parent',
        'bdboard-3tw.10',
        '--stdin',
      ],
      stdin: 'Detailed description',
    });
  });

  it('builds bd_create argv with title only and defaults', () => {
    const result = buildBdToolArgs(
      'bd_create',
      { title: 'Simple task' },
      PROJECT_ROOT,
    );
    expect(result).toEqual({
      ok: true,
      args: [
        '-C',
        PROJECT_ROOT,
        'create',
        '--title',
        'Simple task',
        '--type',
        'task',
        '--priority',
        '2',
      ],
    });
  });

  it('builds bd_create argv with description via stdin', () => {
    const result = buildBdToolArgs(
      'bd_create',
      { title: 'With body', description: 'line1\nline2' },
      PROJECT_ROOT,
    );
    expect(result).toEqual({
      ok: true,
      args: [
        '-C',
        PROJECT_ROOT,
        'create',
        '--title',
        'With body',
        '--type',
        'task',
        '--priority',
        '2',
        '--stdin',
      ],
      stdin: 'line1\nline2',
    });
  });

  it('builds bd_search argv', () => {
    const result = buildBdToolArgs(
      'bd_search',
      { query: 'drag drop' },
      PROJECT_ROOT,
    );
    expect(result).toEqual({
      ok: true,
      args: ['--readonly', '-C', PROJECT_ROOT, 'search', 'drag drop', '--json'],
    });
  });

  it('builds bd_dep_add argv', () => {
    const result = buildBdToolArgs(
      'bd_dep_add',
      { id: 'bdboard-3tw.42', dependsOnId: 'bdboard-3tw.41' },
      PROJECT_ROOT,
    );
    expect(result).toEqual({
      ok: true,
      args: ['-C', PROJECT_ROOT, 'dep', 'add', 'bdboard-3tw.42', 'bdboard-3tw.41'],
    });
  });

  it('builds bd_dep_remove argv', () => {
    const result = buildBdToolArgs(
      'bd_dep_remove',
      { id: 'bdboard-3tw.42', dependsOnId: 'bdboard-3tw.41' },
      PROJECT_ROOT,
    );
    expect(result).toEqual({
      ok: true,
      args: ['-C', PROJECT_ROOT, 'dep', 'remove', 'bdboard-3tw.42', 'bdboard-3tw.41'],
    });
  });

  it('builds bd_label_add argv', () => {
    const result = buildBdToolArgs(
      'bd_label_add',
      { id: 'bdboard-3tw.42', label: 'human' },
      PROJECT_ROOT,
    );
    expect(result).toEqual({
      ok: true,
      args: ['-C', PROJECT_ROOT, 'label', 'add', 'bdboard-3tw.42', 'human'],
    });
  });

  it('builds bd_label_remove argv', () => {
    const result = buildBdToolArgs(
      'bd_label_remove',
      { id: 'bdboard-3tw.42', label: 'gt:slot' },
      PROJECT_ROOT,
    );
    expect(result).toEqual({
      ok: true,
      args: ['-C', PROJECT_ROOT, 'label', 'remove', 'bdboard-3tw.42', 'gt:slot'],
    });
  });

  it('injects projectRootPath immediately after -C for every tool', () => {
    const cases: Array<{ tool: string; rawArgs: unknown }> = [
      { tool: 'bd_list', rawArgs: {} },
      { tool: 'bd_ready', rawArgs: {} },
      { tool: 'bd_blocked', rawArgs: {} },
      { tool: 'bd_show', rawArgs: { id: 'bdboard-3tw.13' } },
      { tool: 'bd_update_status', rawArgs: { id: 'bdboard-3tw.13', status: 'open' } },
      {
        tool: 'bd_update_title',
        rawArgs: { id: 'bdboard-3tw.13', title: 'New title' },
      },
      {
        tool: 'bd_update_description',
        rawArgs: { id: 'bdboard-3tw.13', description: 'new body' },
      },
      {
        tool: 'bd_append_notes',
        rawArgs: { id: 'bdboard-3tw.13', notes: 'extra note' },
      },
      { tool: 'bd_claim', rawArgs: { id: 'bdboard-3tw.13' } },
      { tool: 'bd_close', rawArgs: { id: 'bdboard-3tw.13' } },
      { tool: 'bd_comment', rawArgs: { id: 'bdboard-3tw.13', text: 'ok' } },
      { tool: 'bd_defer', rawArgs: { id: 'bdboard-3tw.13', untilDate: '2026-08-22' } },
      { tool: 'bd_priority', rawArgs: { id: 'bdboard-3tw.13', priority: 1 } },
      {
        tool: 'bd_label_add',
        rawArgs: { id: 'bdboard-3tw.42', label: 'human' },
      },
      {
        tool: 'bd_label_remove',
        rawArgs: { id: 'bdboard-3tw.42', label: 'gt:slot' },
      },
      { tool: 'bd_create', rawArgs: { title: 'New task' } },
      { tool: 'bd_search', rawArgs: { query: 'keyword' } },
      {
        tool: 'bd_dep_add',
        rawArgs: { id: 'bdboard-3tw.42', dependsOnId: 'bdboard-3tw.41' },
      },
      {
        tool: 'bd_dep_remove',
        rawArgs: { id: 'bdboard-3tw.42', dependsOnId: 'bdboard-3tw.41' },
      },
    ];

    for (const { tool, rawArgs } of cases) {
      const result = buildBdToolArgs(tool, rawArgs, PROJECT_ROOT);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        continue;
      }

      const cIndex = result.args.indexOf('-C');
      expect(cIndex).toBeGreaterThanOrEqual(0);
      expect(result.args[cIndex + 1]).toBe(PROJECT_ROOT);
    }
  });

  it('adds --readonly only to read-only tools', () => {
    const readOnlyTools = ['bd_list', 'bd_ready', 'bd_blocked', 'bd_show', 'bd_search'] as const;
    const writeTools = [
      'bd_update_status',
      'bd_update_title',
      'bd_update_description',
      'bd_append_notes',
      'bd_claim',
      'bd_close',
      'bd_comment',
      'bd_defer',
      'bd_priority',
      'bd_label_add',
      'bd_label_remove',
      'bd_create',
      'bd_dep_add',
      'bd_dep_remove',
    ] as const;

    for (const tool of readOnlyTools) {
      const rawArgs =
        tool === 'bd_show'
          ? { id: 'bdboard-3tw.13' }
          : tool === 'bd_search'
            ? { query: 'keyword' }
            : tool === 'bd_list' || tool === 'bd_ready' || tool === 'bd_blocked'
              ? {}
              : {};
      const result = buildBdToolArgs(tool, rawArgs, PROJECT_ROOT);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.args).toContain('--readonly');
      }
    }

    for (const tool of writeTools) {
      const rawArgs =
        tool === 'bd_update_status'
          ? { id: 'bdboard-3tw.13', status: 'open' }
          : tool === 'bd_update_title'
            ? { id: 'bdboard-3tw.13', title: 'New title' }
            : tool === 'bd_update_description'
              ? { id: 'bdboard-3tw.13', description: 'new body' }
              : tool === 'bd_append_notes'
                ? { id: 'bdboard-3tw.13', notes: 'extra note' }
                : tool === 'bd_comment'
            ? { id: 'bdboard-3tw.13', text: 'ok' }
            : tool === 'bd_defer'
              ? { id: 'bdboard-3tw.13', untilDate: '2026-08-22' }
              : tool === 'bd_priority'
                ? { id: 'bdboard-3tw.13', priority: 1 }
                : tool === 'bd_label_add' || tool === 'bd_label_remove'
                  ? { id: 'bdboard-3tw.42', label: 'human' }
                  : tool === 'bd_create'
                    ? { title: 'New task' }
                    : tool === 'bd_dep_add' || tool === 'bd_dep_remove'
                      ? { id: 'bdboard-3tw.42', dependsOnId: 'bdboard-3tw.41' }
                      : { id: 'bdboard-3tw.13' };
      const result = buildBdToolArgs(tool, rawArgs, PROJECT_ROOT);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.args).not.toContain('--readonly');
      }
    }
  });

  it('rejects unknown tool names', () => {
    for (const toolName of ['bash', 'bd_exec', 'BD_LIST', 'bd_list; rm -rf /']) {
      const result = buildBdToolArgs(toolName, {}, PROJECT_ROOT);
      expect(result).toEqual({ ok: false, error: `unknown tool: ${toolName}` });
    }
  });

  it('rejects unsafe or invalid ids', () => {
    const cases = [
      { tool: 'bd_show', rawArgs: { id: '-rf' } },
      { tool: 'bd_show', rawArgs: { id: '../other/project' } },
      { tool: 'bd_show', rawArgs: { id: 'a b' } },
      { tool: 'bd_claim', rawArgs: { id: '-rf' } },
      { tool: 'bd_close', rawArgs: { id: '-rf' } },
      { tool: 'bd_comment', rawArgs: { id: '-rf', text: 'ok' } },
    ] as const;

    for (const { tool, rawArgs } of cases) {
      const result = buildBdToolArgs(tool, rawArgs, PROJECT_ROOT);
      expect(result.ok).toBe(false);
    }
  });

  it('rejects invalid status values', () => {
    const listResult = buildBdToolArgs(
      'bd_list',
      { status: 'open,bogus' },
      PROJECT_ROOT,
    );
    expect(listResult.ok).toBe(false);

    const updateResult = buildBdToolArgs(
      'bd_update_status',
      { id: 'bdboard-3tw.13', status: 'closed; rm -rf /' },
      PROJECT_ROOT,
    );
    expect(updateResult.ok).toBe(false);
  });

  it('rejects empty or overlong comment text', () => {
    const emptyResult = buildBdToolArgs(
      'bd_comment',
      { id: 'bdboard-3tw.13', text: '' },
      PROJECT_ROOT,
    );
    expect(emptyResult.ok).toBe(false);

    const longText = 'x'.repeat(2001);
    const longResult = buildBdToolArgs(
      'bd_comment',
      { id: 'bdboard-3tw.13', text: longText },
      PROJECT_ROOT,
    );
    expect(longResult.ok).toBe(false);
  });

  it('clamps limit values instead of rejecting', () => {
    const listResult = buildBdToolArgs('bd_list', { limit: 99999 }, PROJECT_ROOT);
    expect(listResult).toEqual({
      ok: true,
      args: [
        '--readonly',
        '-C',
        PROJECT_ROOT,
        'list',
        '--json',
        '--no-pager',
        '-n',
        '200',
      ],
    });

    const readyResult = buildBdToolArgs('bd_ready', { limit: 99999 }, PROJECT_ROOT);
    expect(readyResult).toEqual({
      ok: true,
      args: ['--readonly', '-C', PROJECT_ROOT, 'ready', '--json', '-n', '100'],
    });
  });

  it('rejects non-object rawArgs', () => {
    for (const rawArgs of [null, [], 'string', 42]) {
      const result = buildBdToolArgs('bd_list', rawArgs, PROJECT_ROOT);
      expect(result.ok).toBe(false);
    }
  });

  it('ignores additional properties in rawArgs', () => {
    const result = buildBdToolArgs(
      'bd_show',
      { id: 'bdboard-3tw.13', extra: 'rm -rf /' },
      PROJECT_ROOT,
    );
    expect(result.ok).toBe(false);
  });

  it('rejects invalid defer dates and priorities', () => {
    const badDate = buildBdToolArgs(
      'bd_defer',
      { id: 'bdboard-3tw.13', untilDate: '08-22-2026' },
      PROJECT_ROOT,
    );
    expect(badDate.ok).toBe(false);

    const badPriority = buildBdToolArgs(
      'bd_priority',
      { id: 'bdboard-3tw.13', priority: 9 },
      PROJECT_ROOT,
    );
    expect(badPriority.ok).toBe(false);
  });

  it('does not leak additional properties into argv when validation fails early', () => {
    const result = buildBdToolArgs(
      'bd_show',
      { id: '-rf', injected: 'value' },
      PROJECT_ROOT,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain('injected');
    }
  });

  it('rejects invalid bd_update_title arguments', () => {
    const emptyTitle = buildBdToolArgs(
      'bd_update_title',
      { id: 'bdboard-3tw.13', title: '' },
      PROJECT_ROOT,
    );
    expect(emptyTitle.ok).toBe(false);

    const dashTitle = buildBdToolArgs(
      'bd_update_title',
      { id: 'bdboard-3tw.13', title: '-rf' },
      PROJECT_ROOT,
    );
    expect(dashTitle.ok).toBe(false);

    const badId = buildBdToolArgs(
      'bd_update_title',
      { id: '-rf', title: 'ok' },
      PROJECT_ROOT,
    );
    expect(badId.ok).toBe(false);
  });

  it('rejects invalid bd_update_description arguments', () => {
    const emptyDescription = buildBdToolArgs(
      'bd_update_description',
      { id: 'bdboard-3tw.13', description: '' },
      PROJECT_ROOT,
    );
    expect(emptyDescription.ok).toBe(false);

    const longDescription = buildBdToolArgs(
      'bd_update_description',
      { id: 'bdboard-3tw.13', description: 'x'.repeat(4001) },
      PROJECT_ROOT,
    );
    expect(longDescription.ok).toBe(false);

    const badId = buildBdToolArgs(
      'bd_update_description',
      { id: '-rf', description: 'ok' },
      PROJECT_ROOT,
    );
    expect(badId.ok).toBe(false);
  });

  it('rejects invalid bd_append_notes arguments', () => {
    const emptyNotes = buildBdToolArgs(
      'bd_append_notes',
      { id: 'bdboard-3tw.13', notes: '' },
      PROJECT_ROOT,
    );
    expect(emptyNotes.ok).toBe(false);

    const longNotes = buildBdToolArgs(
      'bd_append_notes',
      { id: 'bdboard-3tw.13', notes: 'x'.repeat(4001) },
      PROJECT_ROOT,
    );
    expect(longNotes.ok).toBe(false);

    const badId = buildBdToolArgs(
      'bd_append_notes',
      { id: '-rf', notes: 'ok' },
      PROJECT_ROOT,
    );
    expect(badId.ok).toBe(false);
  });

  it('rejects invalid bd_create arguments', () => {
    const emptyTitle = buildBdToolArgs('bd_create', { title: '' }, PROJECT_ROOT);
    expect(emptyTitle.ok).toBe(false);

    const dashTitle = buildBdToolArgs('bd_create', { title: '-rf' }, PROJECT_ROOT);
    expect(dashTitle.ok).toBe(false);

    const newlineTitle = buildBdToolArgs(
      'bd_create',
      { title: 'bad\nline' },
      PROJECT_ROOT,
    );
    expect(newlineTitle.ok).toBe(false);

    const controlTitle = buildBdToolArgs(
      'bd_create',
      { title: 'bad\x00title' },
      PROJECT_ROOT,
    );
    expect(controlTitle.ok).toBe(false);

    const badType = buildBdToolArgs(
      'bd_create',
      { title: 'ok', type: 'chore' },
      PROJECT_ROOT,
    );
    expect(badType.ok).toBe(false);

    const badPriority = buildBdToolArgs(
      'bd_create',
      { title: 'ok', priority: 9 },
      PROJECT_ROOT,
    );
    expect(badPriority.ok).toBe(false);

    const badParent = buildBdToolArgs(
      'bd_create',
      { title: 'ok', parent: '-rf' },
      PROJECT_ROOT,
    );
    expect(badParent.ok).toBe(false);
  });

  it('rejects invalid bd_search arguments', () => {
    const emptyQuery = buildBdToolArgs('bd_search', { query: '' }, PROJECT_ROOT);
    expect(emptyQuery.ok).toBe(false);

    const dashQuery = buildBdToolArgs('bd_search', { query: '-rf' }, PROJECT_ROOT);
    expect(dashQuery.ok).toBe(false);

    const controlQuery = buildBdToolArgs(
      'bd_search',
      { query: 'bad\x00query' },
      PROJECT_ROOT,
    );
    expect(controlQuery.ok).toBe(false);
  });

  it('rejects invalid bd_dep_add arguments', () => {
    const badId = buildBdToolArgs(
      'bd_dep_add',
      { id: '-rf', dependsOnId: 'bdboard-3tw.41' },
      PROJECT_ROOT,
    );
    expect(badId.ok).toBe(false);

    const badDependsOnId = buildBdToolArgs(
      'bd_dep_add',
      { id: 'bdboard-3tw.42', dependsOnId: '-rf' },
      PROJECT_ROOT,
    );
    expect(badDependsOnId.ok).toBe(false);
  });

  it('rejects invalid bd_dep_remove arguments', () => {
    const badId = buildBdToolArgs(
      'bd_dep_remove',
      { id: '-rf', dependsOnId: 'bdboard-3tw.41' },
      PROJECT_ROOT,
    );
    expect(badId.ok).toBe(false);

    const badDependsOnId = buildBdToolArgs(
      'bd_dep_remove',
      { id: 'bdboard-3tw.42', dependsOnId: '-rf' },
      PROJECT_ROOT,
    );
    expect(badDependsOnId.ok).toBe(false);
  });

  it('rejects invalid bd_label_add arguments', () => {
    const badId = buildBdToolArgs(
      'bd_label_add',
      { id: '-rf', label: 'human' },
      PROJECT_ROOT,
    );
    expect(badId.ok).toBe(false);

    const badLabel = buildBdToolArgs(
      'bd_label_add',
      { id: 'bdboard-3tw.42', label: '-rf' },
      PROJECT_ROOT,
    );
    expect(badLabel.ok).toBe(false);
  });

  it('rejects invalid bd_label_remove arguments', () => {
    const badLabel = buildBdToolArgs(
      'bd_label_remove',
      { id: 'bdboard-3tw.42', label: '-rf' },
      PROJECT_ROOT,
    );
    expect(badLabel.ok).toBe(false);
  });
});
