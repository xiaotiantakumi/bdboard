// bdboard-myla: scripts/merge-pr.test-support.mjs の一時リポジトリが git の自動の保守を起こさないことの確認。
// git は commit / fetch / receive-pack のたびに `git maintenance run --auto --quiet --detach` を起こし、
// これは親の git が終わった後もバックグラウンドで .git に触りうる。テスト末尾の rmSync と競って
// .git が ENOTEMPTY になり、無関係の PR の CI verify が落ちた。止めたことを、設定と実際に起きる子プロセスの両方で確かめる。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { git, mainCheckout, registerTempRepoHooks, setup, tmp, work } from './merge-pr.test-support.mjs';

describe('merge-pr test repos do not start git auto-maintenance (bdboard-myla)', () => {
  registerTempRepoHooks();

  it('turns maintenance.auto / gc.auto / receive.autogc off in origin, the main checkout and the PR worktree', () => {
    setup();
    for (const repo of [path.join(tmp, 'origin.git'), mainCheckout, work]) {
      expect(git(repo, ['config', '--get', 'maintenance.auto']), repo).toBe('false');
      expect(git(repo, ['config', '--get', 'gc.auto']), repo).toBe('0');
      expect(git(repo, ['config', '--get', 'receive.autogc']), repo).toBe('false');
    }
  });

  it('spawns no `git maintenance` / `git gc` while committing, pushing and fetching', () => {
    setup();
    const traceFile = path.join(tmp, 'trace2.jsonl');
    const trace = { GIT_TRACE2_EVENT: traceFile };
    git(work, ['commit', '-q', '--allow-empty', '-m', 'chore: empty'], trace);
    git(work, ['push', '-q', 'origin', 'bd/demo-1'], trace);
    git(mainCheckout, ['fetch', '-q', 'origin', 'bd/demo-1'], trace);
    const names = readFileSync(traceFile, 'utf8')
      .split('\n')
      .filter((line) => line.includes('"event":"cmd_name"'))
      .map((line) => JSON.parse(line).name);
    expect(names).toEqual(expect.arrayContaining(['commit', 'push', 'receive-pack', 'fetch'])); // 計測自体が働いている
    expect(names.filter((name) => name === 'maintenance' || name === 'gc')).toEqual([]);
  });
});
