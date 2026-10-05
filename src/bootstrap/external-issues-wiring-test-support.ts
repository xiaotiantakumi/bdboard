/**
 * bdboard-4y8q.9.4: 届いた issue の配線のテスト用の、偽の gh / bd と一時のメンテナ checkout。
 * *-test-support.ts なので本番コードからの import は src/test-support-import-guard.test.ts が止める。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import type { CommandResult, CommandRunner } from '../application/ports/command-runner.js';

/** `.git` (写しの置き場を data/ にする) と `.beads` (メンテナ環境の印) を持つ一時ディレクトリ。 */
export async function createTempMaintainerRoot(): Promise<{ readonly root: string; readonly remove: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'external-issues-wire-'));
  await fs.mkdir(path.join(root, '.git'));
  await fs.mkdir(path.join(root, '.beads'));
  return { root, remove: () => fs.rm(root, { recursive: true, force: true }) };
}

function issueLine(number: number): string {
  return JSON.stringify({
    number,
    title: `issue ${number}`,
    body: 'b',
    bodyLength: 1,
    updatedAt: '2026-10-05T00:00:00Z',
    author: 'someone',
    authorAssociation: 'NONE',
    pullRequest: false,
  });
}

export interface FakeGhAndBd {
  readonly runner: CommandRunner;
  readonly run: ReturnType<typeof vi.fn<CommandRunner['run']>>;
  /** gh が open issue をこの件数だけ持っているように答える (100 件で 1 ページ。既定 1 件)。 */
  setIssueCount(count: number): void;
  /** 渡すと、gh はページの代わりにこの結果を返す。undefined で元に戻す。 */
  setGhResult(result: CommandResult | undefined): void;
  ghCalls(): readonly (readonly [string, readonly string[]])[];
  bdCalls(): readonly (readonly [string, readonly string[]])[];
}

const isBd = (command: string): boolean => command === 'bd' || command.endsWith('/bd');

/** gh は `page=N` を見て 100 件ずつのページを返し、bd は紐付けのない `[]` を返す。 */
export function createFakeGhAndBd(): FakeGhAndBd {
  let issueCount = 1;
  let ghResult: CommandResult | undefined;
  const run = vi.fn<CommandRunner['run']>((command, args) => {
    if (isBd(command)) return Promise.resolve({ stdout: '[]', stderr: '', exitCode: 0 });
    if (ghResult !== undefined) return Promise.resolve(ghResult);
    const repoArg = args.find((arg) => arg.startsWith('repos/')) ?? '';
    const page = Number(/&page=(\d+)/.exec(repoArg)?.[1] ?? '1');
    const first = (page - 1) * 100 + 1;
    const last = Math.min(page * 100, issueCount);
    const lines = Array.from({ length: Math.max(0, last - first + 1) }, (_, index) => issueLine(first + index));
    return Promise.resolve({ stdout: lines.length === 0 ? '' : `${lines.join('\n')}\n`, stderr: '', exitCode: 0 });
  });
  const callsOf = (match: (command: string) => boolean) =>
    run.mock.calls.filter(([command]) => match(command)).map(([command, args]) => [command, args ?? []] as const);
  return {
    runner: { run },
    run,
    setIssueCount(count) {
      issueCount = count;
    },
    setGhResult(result) {
      ghResult = result;
    },
    ghCalls: () => callsOf((command) => !isBd(command)),
    bdCalls: () => callsOf(isBd),
  };
}

/** 1 時間のうち gh が起動された回数の最大 (どの 1 時間の窓でも)。起動の時刻 (ミリ秒) の列から数える。 */
export function maxCallsInAnyWindow(timesMs: readonly number[], windowMs: number): number {
  const sorted = [...timesMs].sort((a, b) => a - b);
  let max = 0;
  let left = 0;
  for (let right = 0; right < sorted.length; right += 1) {
    while ((sorted[right] ?? 0) - (sorted[left] ?? 0) >= windowMs) left += 1;
    max = Math.max(max, right - left + 1);
  }
  return max;
}
