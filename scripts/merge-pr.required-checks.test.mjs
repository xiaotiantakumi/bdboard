// bdboard-bsc3: prepare の必須チェック判定は gh pr checks の終了コードだけでなく、行ごとの bucket を見る。
//
// 2026-10-06 PR #921: ruleset で必須の e2e が GitHub 側で runner を取れず CANCELLED になったまま、
// prepare が「必須チェック=pass」と出して着地予定ツリーの verify (828 秒) まで進み、gate の後の
// gh pr merge が base branch policy で拒否された。gh (cli/cli v2.86.0 pkg/cmd/pr/checks) は check の
// 結論を bucket (pass / fail / pending / skipping / cancel) に分け、終了コードを「fail があれば 1、
// 無ければ pending があれば 8」で決める。cancel はどちらにも数えないので、必須が cancel だけのとき exit 0 になる。
// さらに --json のときは終了コードに触れる前に JSON を書いて返るので、fail / pending でも常に 0。
//
// 偽の gh (scripts/merge-pr/fake-tools.mjs) は checksRows で行を差し替えられ、その形で上の挙動を再現する。
// 一時リポジトリと偽の gh / bd / npm の harness は merge-pr.test-support.mjs と共有する。
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { judgeCheckRows } from './merge-pr/github.mjs';
import { cancelledChecksSteps } from './merge-pr/messages.mjs';
import { calls, PR, registerTempRepoHooks, run, setup, stateFile, writeFake } from './merge-pr.test-support.mjs';

const JOB = (runId, jobId) => `https://github.com/example/demo/actions/runs/${runId}/job/${jobId}`;
const row = (name, bucket, state, link = JOB(1001, 2001)) => ({ name, state, bucket, link });
const PASS = (name) => row(name, 'pass', 'SUCCESS');
const CANCELLED_E2E = row('e2e', 'cancel', 'CANCELLED', JOB(4242, 9));

describe('judgeCheckRows: gh pr checks --required --json の行を判定する (純粋)', () => {
  it('all pass / skipping rows are pass', () => {
    const judged = judgeCheckRows(JSON.stringify([PASS('verify'), row('e2e', 'skipping', 'SKIPPED'), row('commit-parse', 'skipping', 'NEUTRAL')]));
    expect(judged.verdict).toBe('pass');
    expect(judged.cancelled).toEqual([]);
  });

  it('a cancel row alone is fail (the PR #921 shape: gh exits 0 for it), and is reported as cancelled', () => {
    const judged = judgeCheckRows(JSON.stringify([PASS('verify'), CANCELLED_E2E, PASS('commit-parse')]));
    expect(judged.verdict).toBe('fail');
    expect(judged.cancelled).toEqual([{ name: 'e2e', link: JOB(4242, 9) }]);
    expect(judged.output).toContain('e2e\tcancel\tCANCELLED');
  });

  it('pending rows are pending; fail and cancel win over pending', () => {
    expect(judgeCheckRows(JSON.stringify([PASS('verify'), row('e2e', 'pending', 'QUEUED')])).verdict).toBe('pending');
    expect(judgeCheckRows(JSON.stringify([row('e2e', 'pending', 'QUEUED'), row('verify', 'fail', 'FAILURE')])).verdict).toBe('fail');
    expect(judgeCheckRows(JSON.stringify([row('e2e', 'pending', 'QUEUED'), CANCELLED_E2E])).verdict).toBe('fail');
  });

  it('a row with an unknown or missing bucket is fail, never pass', () => {
    expect(judgeCheckRows(JSON.stringify([PASS('verify'), { name: 'e2e', state: 'WEIRD', bucket: 'mystery' }])).verdict).toBe('fail');
    expect(judgeCheckRows(JSON.stringify([PASS('verify'), { name: 'e2e', state: 'SUCCESS' }])).verdict).toBe('fail');
    expect(judgeCheckRows(JSON.stringify([PASS('verify'), 'not-an-object'])).verdict).toBe('fail');
  });

  it('no rows or output that is not a JSON array cannot be judged', () => {
    expect(judgeCheckRows('[]').verdict).toBe('fail');
    expect(judgeCheckRows('not json').verdict).toBe('unknown');
    expect(judgeCheckRows('{"name":"verify"}').verdict).toBe('unknown');
    expect(judgeCheckRows('').verdict).toBe('unknown');
  });
});

describe('cancelledChecksSteps', () => {
  it('names the cancelled checks and the gh run rerun line per distinct run id', () => {
    const lines = cancelledChecksSteps([
      { name: 'e2e', link: JOB(4242, 9) },
      { name: 'verify', link: JOB(4242, 10) },
      { name: 'commit-parse', link: JOB(77, 11) },
    ]).join('\n');
    expect(lines).toContain('e2e / verify / commit-parse');
    expect(lines).toContain('gh run rerun 4242 --failed');
    expect(lines).toContain('gh run rerun 77 --failed');
    expect(lines.match(/gh run rerun 4242 --failed/g)).toHaveLength(1);
    expect(lines).toContain('runner を取れず');
  });

  it('falls back to a general sentence when no run id can be read from the link', () => {
    const lines = cancelledChecksSteps([{ name: 'e2e', link: '' }, { name: 'verify' }]).join('\n');
    expect(lines).toContain('gh run rerun <run> --failed');
    expect(lines).not.toMatch(/gh run rerun \d/);
  });

  it('says nothing when nothing was cancelled', () => {
    expect(cancelledChecksSteps([])).toEqual([]);
  });
});

// 1 テストで node / git を十数回起こす。verify の並列実行中でも既定 5 秒で落ちないよう余裕を取る。
describe.skipIf(process.platform === 'win32')('prepare: required checks are judged per check, not by the gh exit code (bdboard-bsc3)', { timeout: 30_000 }, () => {
  registerTempRepoHooks();

  it('a required e2e that is CANCELLED while gh exits 0 stops prepare (exit 2) with rerun guidance and no state file', () => {
    setup();
    writeFake({ checksRows: { [PR]: [PASS('verify'), CANCELLED_E2E, PASS('commit-parse')] } });
    const prepared = run(['prepare', String(PR)]);
    expect(prepared.status).toBe(2);
    expect(prepared.stderr).toContain('必須チェック=fail');
    expect(prepared.stderr).toContain('必須チェックが green ではありません');
    expect(prepared.stderr).toContain('e2e\tcancel\tCANCELLED');
    expect(prepared.stderr).toContain('GitHub 側で runner を取れず取り消された可能性');
    expect(prepared.stderr).toContain('gh run rerun 4242 --failed');
    expect(existsSync(stateFile())).toBe(false);
    // 着地予定ツリーの verify (数分〜十数分) には進まない。
    expect(run(['prepare', String(PR), '--dry-run']).status).toBe(2);
  });

  it('asks gh for the rows (--json) with --required', () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    const [call] = calls('gh', 'checks');
    expect(call).toEqual(expect.arrayContaining(['pr', 'checks', String(PR), '--required', '--json']));
  });

  it('a cancelled check without a readable run id still gets the general rerun sentence', () => {
    setup();
    writeFake({ checksRows: { [PR]: [PASS('verify'), row('e2e', 'cancel', 'CANCELLED', '')] } });
    const prepared = run(['prepare', String(PR)]);
    expect(prepared.status).toBe(2);
    expect(prepared.stderr).toContain('gh run rerun <run> --failed');
  });

  it('a fail row that is not a cancel gets no rerun guidance', () => {
    setup();
    writeFake({ checksRows: { [PR]: [row('verify', 'fail', 'FAILURE'), PASS('e2e')] } });
    const prepared = run(['prepare', String(PR)]);
    expect(prepared.status).toBe(2);
    expect(prepared.stderr).toContain('必須チェックが green ではありません');
    expect(prepared.stderr).not.toContain('gh run rerun');
  });

  it('a pending row is a retry (75) even though gh --json exits 0', () => {
    setup();
    writeFake({ checksRows: { [PR]: [PASS('verify'), row('e2e', 'pending', 'QUEUED')] } });
    const prepared = run(['prepare', String(PR)]);
    expect(prepared.status).toBe(75);
    expect(prepared.stderr).toContain('まだ終わっていません');
    expect(existsSync(stateFile())).toBe(false);
  });

  it('skipping rows (SKIPPED / NEUTRAL) are green', () => {
    setup();
    writeFake({ checksRows: { [PR]: [PASS('verify'), row('e2e', 'skipping', 'SKIPPED')] } });
    const prepared = run(['prepare', String(PR)]);
    expect(prepared.status).toBe(0);
    expect(prepared.stderr).toContain('必須チェック=pass');
  });

  it('a GitHub API error from gh pr checks --json is still a retry (75), not red CI', () => {
    setup();
    writeFake({ checksError: { [PR]: 'GraphQL: API rate limit exceeded for user ID 1.' } });
    const prepared = run(['prepare', String(PR)]);
    expect(prepared.status).toBe(75);
    expect(prepared.stderr).toContain('取得できませんでした');
  });

  describe('a gh without gh pr checks --json falls back to the exit code', () => {
    it('exit 0 is pass but says that cancelled checks cannot be told apart', () => {
      setup();
      writeFake({ checksJsonUnsupported: true, checksRows: { [PR]: [PASS('verify'), CANCELLED_E2E] } });
      const prepared = run(['prepare', String(PR)]);
      expect(prepared.status).toBe(0);
      expect(prepared.stderr).toContain('必須チェック=pass');
      expect(prepared.stderr).toContain('--json');
      expect(prepared.stderr).toContain('cancelled');
      expect(calls('gh', 'checks').map((call) => call.includes('--json'))).toEqual([true, false]);
    });

    it('fail (exit 1) and pending (exit 8) keep their old meaning', () => {
      setup();
      writeFake({ checksJsonUnsupported: true, checksRows: { [PR]: [row('verify', 'fail', 'FAILURE')] } });
      expect(run(['prepare', String(PR)]).status).toBe(2);
      writeFake({ checksJsonUnsupported: true, checksRows: { [PR]: [row('verify', 'pending', 'QUEUED')] } });
      expect(run(['prepare', String(PR)]).status).toBe(75);
    });
  });
});
