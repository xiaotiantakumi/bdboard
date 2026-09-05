import { describe, expect, it } from 'vitest';
import {
  CLAUDE_PROJECT_DIR_PLACEHOLDER,
  evaluateHooksState,
  harnessHookCommand,
  harnessHookMarker,
  mergeHarnessHooks,
  type HarnessHookPack,
} from './harness-hooks.js';

const PACK: HarnessHookPack = {
  name: 'bdboard-harness',
  hooks: [
    { event: 'PreToolUse', matcher: 'Bash', script: 'hooks/pre-bash-guard.sh', timeout: 10 },
    {
      event: 'PreToolUse',
      matcher: 'Edit|Write|MultiEdit|NotebookEdit',
      script: 'hooks/pre-edit-guard.sh',
      timeout: 10,
    },
    { event: 'Stop', matcher: '', script: 'hooks/stop-ticket-gate.sh', timeout: 20 },
  ],
};

const NO_HOOKS_PACK: HarnessHookPack = { name: 'plain-pack', hooks: [] };

const BASH_COMMAND =
  `bash -c '[ -f "$0" ] || exit 0; exec bash "$0"' "$CLAUDE_PROJECT_DIR/.claude/skills/bdboard-harness/hooks/pre-bash-guard.sh"`;
const EDIT_COMMAND =
  `bash -c '[ -f "$0" ] || exit 0; exec bash "$0"' "$CLAUDE_PROJECT_DIR/.claude/skills/bdboard-harness/hooks/pre-edit-guard.sh"`;
const STOP_COMMAND =
  `bash -c '[ -f "$0" ] || exit 0; exec bash "$0"' "$CLAUDE_PROJECT_DIR/.claude/skills/bdboard-harness/hooks/stop-ticket-gate.sh"`;

/** 実際の bdboard の settings.json と同じ形 (キー順も含む)。 */
const EXISTING_SESSION_START = `${JSON.stringify(
  {
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              command: 'node "${CLAUDE_PROJECT_DIR:-.}/scripts/bd-prime-guard.mjs"',
              type: 'command',
            },
          ],
          matcher: '',
        },
      ],
    },
  },
  null,
  2,
)}\n`;

function mergedObject(settingsJson: string | null, pack: HarnessHookPack = PACK): any {
  const result = mergeHarnessHooks(settingsJson, pack);
  if (!result.ok) {
    throw new Error(`merge failed: ${result.error}`);
  }
  return JSON.parse(result.settingsJson);
}

describe('harnessHookCommand', () => {
  it('writes $CLAUDE_PROJECT_DIR instead of an absolute path', () => {
    expect(harnessHookCommand('bdboard-harness', 'hooks/pre-bash-guard.sh')).toBe(
      BASH_COMMAND,
    );
    expect(BASH_COMMAND).toContain(harnessHookMarker('bdboard-harness'));
    expect(CLAUDE_PROJECT_DIR_PLACEHOLDER).toBe('$CLAUDE_PROJECT_DIR');
  });

  it('rejects a script outside hooks/ (unremovable on re-injection)', () => {
    expect(harnessHookCommand('bdboard-harness', 'SKILL.md')).toBeNull();
    expect(harnessHookCommand('bdboard-harness', '../escape/x.sh')).toBeNull();
    expect(harnessHookCommand('../evil', 'hooks/x.sh')).toBeNull();
  });
});

describe('mergeHarnessHooks', () => {
  it('creates all declared entries from an empty settings file', () => {
    const merged = mergedObject(null);

    expect(merged.hooks.PreToolUse).toEqual([
      {
        matcher: 'Bash',
        hooks: [{ type: 'command', command: BASH_COMMAND, timeout: 10 }],
      },
      {
        matcher: 'Edit|Write|MultiEdit|NotebookEdit',
        hooks: [{ type: 'command', command: EDIT_COMMAND, timeout: 10 }],
      },
    ]);
    expect(merged.hooks.Stop).toEqual([
      { hooks: [{ type: 'command', command: STOP_COMMAND, timeout: 20 }] },
    ]);
  });

  it('omits the matcher key for a declaration with an empty matcher', () => {
    // Claude Code は Stop の matcher を無視する。書けば差分が増えるだけ。
    expect(Object.keys(mergedObject(null).hooks.Stop[0])).toEqual(['hooks']);
  });

  it('always writes an explicit timeout', () => {
    const merged = mergedObject(null);
    const timeouts = [
      ...merged.hooks.PreToolUse.flatMap((group: any) => group.hooks),
      ...merged.hooks.Stop.flatMap((group: any) => group.hooks),
    ].map((entry: any) => entry.timeout);

    expect(timeouts).toEqual([10, 10, 20]);
  });

  it('emits 2-space JSON with a trailing newline', () => {
    const result = mergeHarnessHooks(null, PACK);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.settingsJson.endsWith('}\n')).toBe(true);
    expect(result.settingsJson).toContain('\n  "hooks": {');
  });

  it('returns the registered commands in declaration order', () => {
    const result = mergeHarnessHooks(null, PACK);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.registered).toEqual([BASH_COMMAND, EDIT_COMMAND, STOP_COMMAND]);
  });

  it('keeps an existing SessionStart hook untouched', () => {
    const merged = mergedObject(EXISTING_SESSION_START);

    expect(merged.hooks.SessionStart).toEqual([
      {
        hooks: [
          {
            command: 'node "${CLAUDE_PROJECT_DIR:-.}/scripts/bd-prime-guard.mjs"',
            type: 'command',
          },
        ],
        matcher: '',
      },
    ]);
    expect(Object.keys(merged.hooks)).toEqual(['SessionStart', 'PreToolUse', 'Stop']);
  });

  it('preserves unrelated top-level keys and their order', () => {
    const existing = JSON.stringify(
      { permissions: { allow: ['Bash(npm run verify)'] }, model: 'opus' },
      null,
      2,
    );
    const result = mergeHarnessHooks(existing, PACK);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const merged = JSON.parse(result.settingsJson);
    expect(Object.keys(merged)).toEqual(['permissions', 'model', 'hooks']);
    expect(merged.permissions).toEqual({ allow: ['Bash(npm run verify)'] });
  });

  it('adds a separate group instead of joining a foreign group with the same matcher', () => {
    const existing = JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [{ type: 'command', command: 'echo other', note: 'keep me' }],
            },
          ],
        },
      },
      null,
      2,
    );

    const merged = mergedObject(existing);
    expect(merged.hooks.PreToolUse).toHaveLength(3);
    // 他人の group は順序も内容も未知キーも変えない。
    expect(merged.hooks.PreToolUse[0]).toEqual({
      matcher: 'Bash',
      hooks: [{ type: 'command', command: 'echo other', note: 'keep me' }],
    });
    expect(merged.hooks.PreToolUse[1].hooks[0].command).toBe(BASH_COMMAND);
  });

  it('is idempotent: re-merging its own output changes nothing', () => {
    const first = mergeHarnessHooks(EXISTING_SESSION_START, PACK);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = mergeHarnessHooks(first.settingsJson, PACK);
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.settingsJson).toBe(first.settingsJson);
    expect(second.registered).toEqual(first.registered);
  });

  /**
   * bdboard-5umd の再現テスト。
   *
   * PR#389 (bdboard-ekj3) が `scripts/commit-message-guard.mjs` という
   * (どの pack にも属さない) foreign hook を、手作業で我々の `Bash` matcher
   * group にそのまま追記した。この形は `mergeHarnessHooks` 自身が生成する形
   * ではない — 生成物は常に「foreign group」と「own group」を分ける
   * (上記コメント 160-163 行)。そのため実際にコミットされている
   * `.claude/settings.json` はこの「混在 group」形のまま固定されており、
   * 常時稼働サーバーが再注入するたびに「foreign hook だけの group」+
   * 「own hook だけの group」の2つへ強制的に分割し直す。
   *
   * ここで検証したいのは「これが `mergeHarnessHooks` の非冪等バグかどうか」。
   * 実測 (このテスト) の結論: **非冪等バグではない**。1 回目の適用で
   * 混在形 → 分割形へ移行するのは意図した変化 (これは `first !== 入力`
   * であって当然) だが、2 回目以降は分割形が不動点になり出力は変化しない
   * (`second === first`)。つまり `mergeHarnessHooks(mergeHarnessHooks(x))
   * === mergeHarnessHooks(x)` は実物の混在形に対しても既に成立している。
   *
   * したがって `git diff -- .claude/settings.json` が消えないのは
   * マージロジックの不具合ではなく、コミット済みの settings.json が
   * このマージ関数が実際に出力する「分割形」を反映していない (git 側が
   * 非正規形のまま) ことが原因 — bdboard-5umd の判断は (b) git 側追従。
   */
  it(
    'is a fixed point (not merely idempotent-from-its-own-output) for the real ' +
      'committed mixed-matcher shape: a foreign hook hand-added into our Bash group ' +
      '(bdboard-5umd)',
    () => {
      const foreignCommitGuardCommand =
        `bash -c '[ -f "$0" ] || exit 0; exec node "$0"' "$CLAUDE_PROJECT_DIR/scripts/commit-message-guard.mjs"`;

      // 実際に git へコミットされている .claude/settings.json の PreToolUse.Bash の
      // 形そのもの: 我々の own hook (BASH_COMMAND) と foreign hook が同一 group に
      // 同居している。
      const mixedMatcherSettings = JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [
                { type: 'command', command: BASH_COMMAND, timeout: 10 },
                { type: 'command', command: foreignCommitGuardCommand, timeout: 10 },
              ],
            },
          ],
        },
      });

      const first = mergeHarnessHooks(mixedMatcherSettings, PACK);
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      // 1回目は混在形→分割形への移行そのものなので、入力とは異なる
      // (これ自体は非冪等の証拠ではない)。
      expect(JSON.parse(first.settingsJson)).not.toEqual(JSON.parse(mixedMatcherSettings));

      const second = mergeHarnessHooks(first.settingsJson, PACK);
      expect(second.ok).toBe(true);
      if (!second.ok) return;

      // 2回目以降は不動点: これが本チケットの本題 (F(F(x)) === F(x))。
      expect(second.settingsJson).toBe(first.settingsJson);
      expect(second.registered).toEqual(first.registered);

      // 分割後の正規形を明示的に固定する: foreign hook は独立 group として残り、
      // 我々の hook は別の独立 group として末尾に追加される。
      const merged = JSON.parse(first.settingsJson);
      expect(merged.hooks.PreToolUse).toEqual([
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: foreignCommitGuardCommand, timeout: 10 }],
        },
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: BASH_COMMAND, timeout: 10 }],
        },
        {
          matcher: 'Edit|Write|MultiEdit|NotebookEdit',
          hooks: [{ type: 'command', command: EDIT_COMMAND, timeout: 10 }],
        },
      ]);
    },
  );

  it('removes only our entries when a declaration disappears', () => {
    const injected = mergeHarnessHooks(EXISTING_SESSION_START, PACK);
    expect(injected.ok).toBe(true);
    if (!injected.ok) return;

    const shrunk = mergeHarnessHooks(injected.settingsJson, {
      name: PACK.name,
      hooks: [PACK.hooks[0]!],
    });
    expect(shrunk.ok).toBe(true);
    if (!shrunk.ok) return;

    const merged = JSON.parse(shrunk.settingsJson);
    expect(merged.hooks.Stop).toBeUndefined();
    expect(merged.hooks.PreToolUse).toHaveLength(1);
    expect(merged.hooks.PreToolUse[0].hooks[0].command).toBe(BASH_COMMAND);
    expect(merged.hooks.SessionStart).toHaveLength(1);
  });

  it('keeps a foreign entry that shares a group with one of ours', () => {
    const existing = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              { type: 'command', command: BASH_COMMAND, timeout: 600 },
              { type: 'command', command: 'echo foreign' },
            ],
          },
        ],
      },
    });

    const merged = mergedObject(existing);
    expect(merged.hooks.PreToolUse[0]).toEqual({
      matcher: 'Bash',
      hooks: [{ type: 'command', command: 'echo foreign' }],
    });
    expect(merged.hooks.PreToolUse).toHaveLength(3);
  });

  it('leaves an unrelated event array that was already empty', () => {
    const merged = mergedObject(JSON.stringify({ hooks: { Notification: [] } }));
    expect(merged.hooks.Notification).toEqual([]);
  });

  it('writes nothing but keeps the file valid for a pack without hooks', () => {
    const result = mergeHarnessHooks(null, NO_HOOKS_PACK);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.registered).toEqual([]);
    expect(JSON.parse(result.settingsJson)).toEqual({});
  });

  it('fails on broken JSON instead of overwriting it', () => {
    const result = mergeHarnessHooks('{ "hooks": ', PACK);
    expect(result).toEqual({
      ok: false,
      settingsJson: null,
      error: expect.stringContaining('JSON として解釈できません'),
    });
  });

  it('fails when the top level is not an object', () => {
    const result = mergeHarnessHooks('[]', PACK);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.settingsJson).toBeNull();
  });

  it('fails when hooks is not an object', () => {
    const result = mergeHarnessHooks(JSON.stringify({ hooks: [] }), PACK);
    expect(result.ok).toBe(false);
  });

  it('fails when a declared event is not an array', () => {
    const result = mergeHarnessHooks(
      JSON.stringify({ hooks: { PreToolUse: 'nope' } }),
      PACK,
    );
    expect(result.ok).toBe(false);
  });

  it('treats an empty file as absent', () => {
    const result = mergeHarnessHooks('   \n', PACK);
    expect(result.ok).toBe(true);
  });
});

describe('evaluateHooksState', () => {
  it('reports none-declared for a pack without hooks', () => {
    expect(evaluateHooksState(null, NO_HOOKS_PACK)).toEqual({
      state: 'none-declared',
      missingHooks: [],
    });
  });

  it('reports missing when settings.json does not exist', () => {
    expect(evaluateHooksState(null, PACK)).toEqual({
      state: 'missing',
      missingHooks: [BASH_COMMAND, EDIT_COMMAND, STOP_COMMAND],
    });
  });

  it('reports missing when settings.json is broken', () => {
    expect(evaluateHooksState('{ oops', PACK).state).toBe('missing');
  });

  it('reports ok right after a merge', () => {
    const result = mergeHarnessHooks(EXISTING_SESSION_START, PACK);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(evaluateHooksState(result.settingsJson, PACK)).toEqual({
      state: 'ok',
      missingHooks: [],
    });
  });

  it('reports partial when one declaration was removed by hand', () => {
    const result = mergeHarnessHooks(null, PACK);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const parsed = JSON.parse(result.settingsJson);
    delete parsed.hooks.Stop;

    expect(evaluateHooksState(JSON.stringify(parsed), PACK)).toEqual({
      state: 'partial',
      missingHooks: [STOP_COMMAND],
    });
  });

  it('does not count a registration under the wrong event', () => {
    const settings = JSON.stringify({
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: BASH_COMMAND, timeout: 10 }] },
          { hooks: [{ type: 'command', command: STOP_COMMAND, timeout: 20 }] },
        ],
      },
    });

    expect(evaluateHooksState(settings, PACK)).toEqual({
      state: 'partial',
      missingHooks: [BASH_COMMAND, EDIT_COMMAND],
    });
  });

  it('ignores matcher and timeout drift', () => {
    const settings = JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: '*', hooks: [{ type: 'command', command: BASH_COMMAND, timeout: 600 }] },
          { matcher: 'Edit', hooks: [{ type: 'command', command: EDIT_COMMAND }] },
        ],
        Stop: [{ hooks: [{ type: 'command', command: STOP_COMMAND, timeout: 1 }] }],
      },
    });

    expect(evaluateHooksState(settings, PACK).state).toBe('ok');
  });
});
