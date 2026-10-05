// bdboard-07q8: merge-pr prepare / gate が PR タイトル (= gate が作る squash の件名) を conventional commit の規則
// (npm run check:commits と同じ) にかけるテスト。
//
// 事故 (2026-10-06): `gh pr create --fill` が複数コミットのブランチでブランチ名 (bd/bdboard 4y8q.6.4) をタイトルにし、
// prepare は 9 分の着地予定ツリーの verify を通し、gate は --subject 'bd/bdboard 4y8q.6.4 (#920)' を印字した。
// 一時リポジトリ + 偽の gh / bd / npm の harness は merge-pr.test-support.mjs と共有する (merge-pr.test.mjs は大きいので別ファイル)。
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isConventionalSubject } from './check-commit-parse.mjs';
import { EXIT, MergePrError } from './merge-pr/context.mjs';
import { mergeCommand } from './merge-pr/gate.mjs';
import { assertConventionalTitle, loadTitleRules, squashSubject, subjectProblem } from './merge-pr/pr-title.mjs';
import {
  advanceMain,
  auditText,
  calls,
  fakeState,
  git,
  head,
  PR,
  readFake,
  readState,
  registerTempRepoHooks,
  run,
  setup,
  stateFile,
  verified,
  work,
} from './merge-pr.test-support.mjs';
import { RM_OPTIONS } from './test-support/quiet-git.mjs';

// 事故のタイトル (ブランチ名そのまま)。parser も形も落ちる。
const BRANCH_TITLE = 'bd/bdboard 4y8q.6.4';
const FIXED_TITLE = 'fix(demo-1): corrected title';

describe('merge-pr PR title helpers (bdboard-07q8)', () => {
  it('squashSubject collapses newlines and runs of whitespace, trims, appends (#N), and is exactly what mergeCommand prints', () => {
    const title = '  feat(demo-1): add\n\t a  thing  ';
    expect(squashSubject(12, title)).toBe('feat(demo-1): add a thing (#12)');
    expect(mergeCommand(12, 'abc', title)).toBe(
      "gh pr merge 12 --squash --delete-branch --match-head-commit abc --subject 'feat(demo-1): add a thing (#12)'",
    );
  });

  it('isConventionalSubject: type(scope)!: followed by a space, nothing else', () => {
    for (const subject of ['feat: x', 'feat(a b): x', 'feat!: x', 'feat(x)!: x', 'chore(x): 日本語']) {
      expect(isConventionalSubject(subject), subject).toBe(true);
    }
    for (const subject of ['wip', 'feat(x):x', 'feat:x', BRANCH_TITLE, 'Revert "feat: x"', '']) {
      expect(isConventionalSubject(subject), subject).toBe(false);
    }
  });

  it('subjectProblem accepts what check:commits accepts and rejects the incident title, wip, Revert, and an unclosed scope', async () => {
    const rules = await loadTitleRules();
    const accepted = [
      'feat(bdboard-07q8): add a thing (#1)',
      'fix!: x (#1)',
      'chore(x): 日本語 (#1)',
      'feat(a b): x (#1)',
      'chore(main): release 0.3.0 (#1)', // release-please のリリース PR のタイトルも通る
    ];
    for (const subject of accepted) {
      expect(subjectProblem(subject, rules), subject).toBeNull();
    }
    const rejected = [`${BRANCH_TITLE} (#920)`, 'wip (#1)', 'Revert "feat: x" (#1)', 'feat(x: y (#1)', 'feat(x):x (#1)', 'feat(x) y: z (#1)'];
    // 説明の無いタイトル (`feat(x):` / `feat:` / `feat(x)!:`): 件名の末尾の (#N) が説明に見えてはいけない。
    for (const subject of ['feat(x): (#1)', 'feat: (#1)', 'feat(x)!: (#1)']) {
      rejected.push(subject);
      expect(subjectProblem(subject, rules)?.join('\n'), subject).toContain('形ではありません');
    }
    expect(subjectProblem('feat(x): (#12) (#1)', rules)).toBeNull(); // (#12) が本当の説明なら通る
    for (const subject of rejected) {
      expect(subjectProblem(subject, rules), subject).not.toBeNull();
    }
    expect(subjectProblem('feat(x):x (#1)', rules).join('\n')).toContain('形ではありません');
    expect(subjectProblem('feat(x: y (#1)', rules).join('\n')).toContain('パーサが解析できません');
    // 事故のタイトルは両方の理由が出る。
    expect(subjectProblem(`${BRANCH_TITLE} (#920)`, rules)).toHaveLength(2);
  });

  describe('assertConventionalTitle in process', () => {
    let auditDir;
    afterEach(() => {
      vi.unstubAllEnvs();
      if (auditDir !== undefined) {
        rmSync(auditDir, RM_OPTIONS);
        auditDir = undefined;
      }
    });
    // audit は本物の監査ログ ($TMPDIR/bdboard-merge-audit.log) に追記するので、一時ファイルに向ける。
    function stubAuditLog() {
      auditDir = mkdtempSync(path.join(tmpdir(), 'bdboard-pr-title-audit-'));
      vi.stubEnv('BDBOARD_MERGE_AUDIT_LOG', path.join(auditDir, 'audit.log'));
    }

    it('fails closed with exit 1 and an npm install hint when the rules cannot be loaded, and passes a good title', async () => {
      stubAuditLog();
      const failing = assertConventionalTitle(
        { title: FIXED_TITLE, headRef: 'bd/demo-1' },
        PR,
        {
          phase: 'prepare',
          loadRules: async () => {
            throw new Error('Cannot find package');
          },
        },
      );
      await expect(failing).rejects.toBeInstanceOf(MergePrError);
      await expect(failing).rejects.toMatchObject({ code: EXIT.USAGE, message: expect.stringContaining('npm install') });
      await expect(assertConventionalTitle({ title: FIXED_TITLE, headRef: 'bd/demo-1' }, PR, { phase: 'prepare' })).resolves.toBeUndefined();
    });

    it('a rejected title is exit 2 and the fix line names the ticket id from bd/<id>, or <ticket-id> for any other branch', async () => {
      stubAuditLog();
      const lines = async (headRef, phase) => {
        try {
          await assertConventionalTitle({ title: BRANCH_TITLE, headRef }, PR, { phase });
        } catch (error) {
          expect(error.code).toBe(EXIT.PRECONDITION);
          return error.lines.join('\n');
        }
        throw new Error('expected a refusal');
      };
      expect(await lines('bd/demo-1', 'prepare')).toContain('gh pr edit 7 --title "<type>(demo-1): <英語の要約>"');
      expect(await lines('feature/x', 'prepare')).toContain('gh pr edit 7 --title "<type>(<ticket-id>): <英語の要約>"');
      const gateLines = await lines('bd/demo-1', 'gate');
      expect(gateLines).toContain('枠はまだ取っていません');
      expect(gateLines).toContain('merge-pr -- gate 7');
      expect(gateLines).not.toContain('merge-pr -- prepare');
    });
  });
});

describe('merge-pr PR title checks, end to end (bdboard-07q8)', () => {
  registerTempRepoHooks();

  function setPullTitle(title) {
    const fake = readFake();
    fake.pulls[String(PR)] = { ...fake.pulls[String(PR)], title };
    writeFileSync(fakeState, JSON.stringify(fake));
  }

  it('prepare refuses the branch-name title before the review record, the required checks and any state, and works again once the title is fixed', () => {
    setup();
    setPullTitle(BRANCH_TITLE);
    const refused = run(['prepare', String(PR)]);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain(`${BRANCH_TITLE} (#7)`);
    expect(refused.stderr).toContain('gh pr edit 7 --title "<type>(demo-1): <英語の要約>"');
    expect(refused.stderr).toContain('npm run merge-pr -- prepare 7');
    expect(existsSync(stateFile())).toBe(false);
    expect(calls('gh', 'checks')).toEqual([]); // 必須チェックを見る前に止まる
    expect(calls('bd', 'show')).toEqual([]); // レビュー記録 (bd) を読む前に止まる
    expect(auditText()).toContain('prepare-title-refused');
    expect(auditText()).not.toContain('\tprepare\t');

    setPullTitle(FIXED_TITLE);
    const prepared = run(['prepare', String(PR)]);
    expect(prepared.status).toBe(0);
    expect(readState()).toMatchObject({ pr: PR, id: 'demo-1', head, class: 'N' });
  });

  it('prepare --dry-run and an S0 prepare refuse a bad title too', () => {
    setup();
    setPullTitle(BRANCH_TITLE);
    const dry = run(['prepare', String(PR), '--dry-run']);
    expect(dry.status).toBe(2);
    expect(dry.stderr).toContain('gh pr edit 7 --title');

    setup({ merge: { mode: 'S0' } });
    setPullTitle(BRANCH_TITLE);
    expect(run(['prepare', String(PR)]).status).toBe(2);
    expect(existsSync(stateFile())).toBe(false);
  });

  it('prepare reports the parser reason for an unclosed scope', () => {
    setup();
    setPullTitle('feat(demo-1: broken');
    const refused = run(['prepare', String(PR)]);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain('パーサが解析できません');
    expect(existsSync(stateFile())).toBe(false);
  });

  it('S2 prepare (class F) refuses the title before the predicted tree verify: no verify run, no state, branch untouched', () => {
    setup({ merge: { mode: 'S2' } });
    advanceMain({ 'peer.txt': 'peer\n' });
    setPullTitle(BRANCH_TITLE);
    const refused = run(['prepare', String(PR)]);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain('gh pr edit 7 --title');
    expect(refused.stderr).not.toContain('クラス=F'); // 分類にも進まない
    expect(verified()).toEqual([]);
    expect(existsSync(stateFile())).toBe(false);
    expect(git(work, ['symbolic-ref', '--short', 'HEAD'])).toBe('bd/demo-1');

    // 直せば (main が動いたままなので) クラス F で先へ進み、着地予定ツリーを verify する。
    setPullTitle(FIXED_TITLE);
    const prepared = run(['prepare', String(PR)]);
    expect(prepared.status).toBe(0);
    expect(prepared.stderr).toContain('クラス=F');
    expect(verified()).toHaveLength(1);
  });

  it('gate refuses a title that went bad after prepare before the layer-3 wait and acquire (no slot to return, record kept), then runs once the title is fixed', () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    const before = readState();
    setPullTitle(BRANCH_TITLE);
    const refused = run(['gate', String(PR)]);
    expect(refused.status).toBe(2);
    expect(refused.stdout).toBe('');
    expect(refused.stderr).toContain(`${BRANCH_TITLE} (#7)`);
    expect(refused.stderr).toContain('gh pr edit 7 --title "<type>(demo-1): <英語の要約>"');
    expect(refused.stderr).toContain('枠はまだ取っていません');
    expect(calls('bd', 'acquire')).toEqual([]);
    expect(calls('bd', 'release')).toEqual([]);
    expect(readFake().slot.holder).toBeNull();
    expect(readState()).toEqual(before); // prepare の記録はそのまま (gateAt なし)
    expect(readState()).not.toHaveProperty('gateAt');
    expect(auditText()).toContain('gate-title-refused');
    expect(auditText()).not.toContain('gate-acquired');

    setPullTitle(FIXED_TITLE);
    const gated = run(['gate', String(PR)]);
    expect(gated.status).toBe(0);
    expect(gated.stdout).toBe(`gh pr merge 7 --squash --delete-branch --match-head-commit ${head} --subject '${FIXED_TITLE} (#7)'\n`);
    expect(readFake().slot.holder).toBe('demo-1 / PR#7');
    expect(gated.stderr).not.toContain('注意: PR タイトル'); // 枠を取った後の弱い警告は検査に置き換わった
  });

  it('gate with a good title prints the merge line as before', () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    const gated = run(['gate', String(PR)]);
    expect(gated.status).toBe(0);
    expect(gated.stdout).toContain("--subject 'feat(demo-1): add the thing (#7)'");
    expect(auditText()).toContain('gate-acquired');
    expect(auditText()).not.toContain('title-refused');
  });
});
