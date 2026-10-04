// bdboard-ulxa.3: マージ手順 S3 (merge.mode "S3") — main 側と重ならず hot file にも触れない PR (クラス L) は
// 着地予定ツリーで軽量チェック (merge.lightCheck) だけを回し、着地後検証はフル verify のまま、のテスト。
//
// 一時リポジトリ + 偽の gh / bd / npm の harness は merge-pr.test-support.mjs と共有する (merge-pr.test.mjs は
// max-lines 1500 に近いので別ファイル)。軽量チェックは契約の merge.lightCheck = 'node verify.cjs --light' で、
// 偽の検証コマンドはそのときだけ検証ログの行末に " --light" を付ける (フル verify と見分けるため)。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_HOT_FILES,
  DEFAULT_LIGHT_CHECK,
  decideS3Class,
  hotTouched,
  parseMergeConfig,
  recordProblem,
} from './merge-pr.mjs';
import {
  advanceMain,
  auditText,
  base,
  calls,
  git,
  head,
  landSquash,
  posted,
  PR,
  readFake,
  readState,
  REPO_ROOT,
  registerTempRepoHooks,
  run,
  setup,
  stateFile,
  status,
  TITLE,
  verified,
  work,
  writeFake,
} from './merge-pr.test-support.mjs';

const LIGHT = 'node verify.cjs --light';
const S3 = { mode: 'S3', lightCheck: LIGHT };

describe('merge-pr S3 pure helpers (bdboard-ulxa.3)', () => {
  const contract = { version: 1, verify: 'npm run verify', prFlow: 'pr' };

  it('parseMergeConfig: S3 is a mode, lightCheck defaults to npm run verify -- --light, and an unknown mode stops with the way out', () => {
    expect(parseMergeConfig({ ...contract, merge: { mode: 'S3' } }).config).toMatchObject({ mode: 'S3', lightCheck: DEFAULT_LIGHT_CHECK });
    expect(DEFAULT_LIGHT_CHECK).toBe('npm run verify -- --light');
    expect(parseMergeConfig({ ...contract, merge: { lightCheck: '  npm run x  ' } }).config.lightCheck).toBe('npm run x');
    expect(parseMergeConfig({ ...contract, merge: { lightCheck: ' ' } }).ok).toBe(false);
    expect(parseMergeConfig({ ...contract, merge: { lightCheck: ['npm'] } }).ok).toBe(false);
    const unknown = parseMergeConfig({ ...contract, merge: { mode: 'S4' } });
    expect(unknown.ok).toBe(false);
    expect(unknown.message).toContain('S0 / S1 / S2 / S3');
    expect(unknown.message).toContain('git merge origin/main');
  });

  it("this repo's contract switches S2 <-> S3 by the mode line alone (rollback is one line)", () => {
    const own = JSON.parse(readFileSync(path.join(REPO_ROOT, '.claude', 'bdboard-harness.json'), 'utf8'));
    const as = (mode) => parseMergeConfig({ ...own, merge: { ...own.merge, mode } });
    expect(as('S3').ok).toBe(true);
    expect(as('S2').ok).toBe(true);
    expect({ ...as('S3').config, mode: 'S2' }).toEqual(as('S2').config);
  });

  it('hotTouched: files matching any hot pattern, from either side', () => {
    expect(hotTouched(['src/a.ts', 'web/tsconfig.app.json', '.github/workflows/ci.yml'], DEFAULT_HOT_FILES)).toEqual([
      'web/tsconfig.app.json',
      '.github/workflows/ci.yml',
    ]);
    expect(hotTouched(['eslint.config.mjs', 'scripts/file-size-baseline.json'], DEFAULT_HOT_FILES)).toEqual([]);
    expect(hotTouched(['a.txt'], [])).toEqual([]);
  });

  it('decideS3Class: only an F with no overlap and no hot file on either side becomes L; N / R / incomplete F stay as they are', () => {
    const tree = 'b'.repeat(40);
    const f = { class: 'F', reason: '衝突なし・hot file なし', tree, mainFiles: ['peer.txt'], mineFiles: ['feature.txt'], overlap: [] };
    expect(decideS3Class(f, DEFAULT_HOT_FILES)).toMatchObject({ class: 'L', tree, reason: expect.stringContaining('軽量チェック') });
    const overlapped = decideS3Class({ ...f, mineFiles: ['peer.txt'], overlap: ['peer.txt'] }, DEFAULT_HOT_FILES);
    expect(overlapped).toMatchObject({ class: 'F', reason: expect.stringContaining('重なり 1 件 (フル verify)') });
    expect(decideS3Class({ ...f, mainFiles: ['package-lock.json'] }, DEFAULT_HOT_FILES).class).toBe('F'); // main 側だけの hot
    expect(decideS3Class({ ...f, mineFiles: ['tsconfig.json'] }, DEFAULT_HOT_FILES).class).toBe('F'); // 自分の側だけの hot
    expect(decideS3Class({ class: 'F', reason: 'x', tree }, DEFAULT_HOT_FILES).class).toBe('F'); // 材料が無い F は軽量にしない
    const r = { class: 'R', reason: 'テキスト衝突: a', mainFiles: [], mineFiles: [], overlap: [] };
    expect(decideS3Class(r, DEFAULT_HOT_FILES)).toBe(r);
    const n = { class: 'N', reason: 'main 不動', overlap: [], mainFiles: [] };
    expect(decideS3Class(n, DEFAULT_HOT_FILES)).toBe(n);
  });

  it('recordProblem: which prepare records each mode lets through to gate (light and full results never stand in for each other)', () => {
    const predBase = 'a'.repeat(40);
    const prHead = 'd'.repeat(40);
    const lightTree = 'e'.repeat(40);
    const lightCommit = 'f'.repeat(40);
    const good = (sha) => (sha === lightCommit ? { tree: lightTree, parents: [predBase, prHead] } : null);
    const n = { class: 'N', predBase, head: prHead };
    const f = { ...n, class: 'F', predictedTree: lightTree, predictedVerifiedAt: 'x' };
    const l = { ...n, class: 'L', lightTree, lightCommit, lightCheckedAt: 'x' };
    for (const mode of ['S1', 'S2', 'S3']) {
      expect(recordProblem(mode, n, good)).toBeNull();
    }
    expect(recordProblem('S1', f, good)).toContain('クラス F');
    expect(recordProblem('S2', f, good)).toBeNull();
    expect(recordProblem('S3', f, good)).toBeNull();
    expect(recordProblem('S3', { ...n, class: 'F', lightTree, lightCommit, lightCheckedAt: 'x' }, good)).toContain('verify の結果がありません');
    expect(recordProblem('S3', l, good)).toBeNull();
    expect(recordProblem('S2', l, good)).toContain('S3 から巻き戻された');
    expect(recordProblem('S1', l, good)).toContain('クラス L');
    expect(recordProblem('S3', { ...n, class: 'L', predictedTree: lightTree, predictedVerifiedAt: 'x' }, good)).toContain('軽量チェックの結果がありません');
    expect(recordProblem('S3', l, () => null)).toContain('食い違っています');
    expect(recordProblem('S3', l, () => ({ tree: 'c'.repeat(40), parents: [predBase, prHead] }))).toContain('食い違っています');
    expect(recordProblem('S3', l, () => ({ tree: lightTree, parents: [prHead, predBase] }))).toContain('食い違っています');
    expect(recordProblem('S3', { ...n, class: 'X' }, good)).toContain('知らないクラス');
    expect(recordProblem('S3', { ...n, class: undefined }, good)).toContain('知らないクラス');
  });
});

// 1 テストで node / git を十数回起こす。verify の並列実行中でも既定 5 秒で落ちないよう余裕を取る。
describe.skipIf(process.platform === 'win32')('merge-pr S3 phases against a temp repo + fake gh/bd/npm (bdboard-ulxa.3)', { timeout: 30_000 }, () => {
  registerTempRepoHooks();

  const nonShowBd = () => calls('bd').filter((c) => c[1] !== 'show');

  it('S3 happy path: main moved on other files → L; only the light check runs on the predicted tree, then finish runs the full verify on what landed', () => {
    setup({ merge: S3 });
    const moved = advanceMain({ 'peer.txt': 'peer\n' });
    const prepared = run(['prepare', String(PR)]);
    expect(prepared.stderr).not.toContain('想定外');
    expect(prepared.status).toBe(0);
    expect(prepared.stderr).toContain('クラス=L');
    const expectedTree = git(work, ['merge-tree', '--write-tree', moved, head]);
    const state = readState();
    expect(state).toMatchObject({ class: 'L', predBase: moved, head, lightTree: expectedTree, lightCheck: LIGHT });
    expect(state.lightCheckedAt).toBeTruthy();
    // 軽量チェックの成功はフル verify の記録 (predicted*) にしない。
    expect(state.predictedTree).toBeUndefined();
    expect(state.predictedVerifiedAt).toBeUndefined();
    expect(git(work, ['rev-list', '--parents', '-n', '1', state.lightCommit]).split(' ').slice(1)).toEqual([moved, head]);
    expect(verified()).toEqual([`${state.lightCommit} --light`]);
    expect(git(work, ['symbolic-ref', '--short', 'HEAD'])).toBe('bd/demo-1');
    expect(posted()).toEqual([]); // 台帳 (commit status) には何も書かない
    expect(nonShowBd()).toEqual([]); // 枠に触れない
    expect(auditText()).toMatch(/\tlight-check\t.*result=success/);
    expect(auditText()).not.toMatch(/\tpredicted-verify\t/);
    expect(auditText()).toMatch(/\tprepare\t.*class=L.*s3=L/);

    writeFake({ statuses: { [moved]: [status('success')] } });
    const gated = run(['gate', String(PR)]);
    expect(gated.status).toBe(0);
    expect(gated.stdout).toBe(`gh pr merge ${PR} --squash --delete-branch --match-head-commit ${head} --subject '${TITLE} (#${PR})'\n`);
    const landed = landSquash();
    const finished = run(['finish', String(PR)]);
    expect(finished.status).toBe(0);
    expect(finished.stderr).toContain('クラス L: 着地した木は prepare で 軽量チェック した着地予定ツリーと同一');
    expect(verified()).toEqual([`${state.lightCommit} --light`, landed]); // 着地後検証はフル verify
    expect(posted().map(({ sha, state: s }) => [sha, s])).toEqual([
      [landed, 'pending'],
      [landed, 'success'],
    ]);
    expect(auditText()).toMatch(/\tpredicted-tree\tpr=7\tid=demo-1\tmatch=true.*class=L/);
    expect(auditText()).toMatch(/\tlight-landed\t.*result=success/);
    expect(readFake().slot.holder).toBeNull();
  });

  it('S3: main not moved is class N (no light check, no predicted verify)', () => {
    setup({ merge: S3 });
    const prepared = run(['prepare', String(PR)]);
    expect(prepared.status).toBe(0);
    expect(prepared.stderr).toContain('クラス=N');
    expect(readState()).toMatchObject({ class: 'N', predBase: base });
    expect(verified()).toEqual([]);
  });

  it('S3: a file both sides changed (even a clean merge) is F with the full verify, not L', () => {
    setup({ merge: S3, branchFiles: { 'shared.txt': 'same\n' } });
    advanceMain({ 'shared.txt': 'same\n' });
    const prepared = run(['prepare', String(PR)]);
    expect(prepared.status).toBe(0);
    expect(prepared.stderr).toContain('クラス=F');
    expect(prepared.stderr).toContain('重なり 1 件 (フル verify)');
    const state = readState();
    expect(state.predictedVerifiedAt).toBeTruthy();
    expect(state.lightCheckedAt).toBeUndefined();
    expect(verified()).toEqual([state.predictedCommit]); // --light ではない
  });

  it('S3: a hot file on only one side (main or the PR) is F with the full verify, not L', () => {
    setup({ merge: S3 });
    advanceMain({ '.github/workflows/ci.yml': 'on: push\n' });
    const mainSide = run(['prepare', String(PR)]);
    expect(mainSide.status).toBe(0);
    expect(mainSide.stderr).toContain('hot file に触れている (フル verify): .github/workflows/ci.yml');
    expect(readState().class).toBe('F');

    setup({ merge: S3, branchFiles: { 'tsconfig.json': '{}\n' } });
    advanceMain({ 'peer.txt': 'peer\n' });
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(readState().class).toBe('F');
    expect(verified()).toEqual([readState().predictedCommit]);
  });

  it('S3: a failing light check is exit 3 (rebase) with no state, no ledger and no slot', () => {
    setup({ merge: S3 });
    advanceMain({ 'peer.txt': 'peer\n' });
    const prepared = run(['prepare', String(PR)], { FAKE_VERIFY_EXIT: '1' });
    expect(prepared.status).toBe(3);
    expect(prepared.stderr).toContain(`軽量チェック (${LIGHT}) が失敗しました`);
    expect(prepared.stderr).toContain('rebase に格下げ');
    expect(existsSync(stateFile())).toBe(false);
    expect(posted()).toEqual([]);
    expect(nonShowBd()).toEqual([]);
    expect(git(work, ['symbolic-ref', '--short', 'HEAD'])).toBe('bd/demo-1');
    expect(auditText()).toMatch(/\tlight-check\t.*result=failure/);
  });

  it('S3 slip: a class-L merge whose landed full verify fails records failure, holds the slot as main-broken and says to go back to S2', () => {
    setup({ merge: S3 });
    const moved = advanceMain({ 'peer.txt': 'peer\n' });
    expect(run(['prepare', String(PR)]).status).toBe(0);
    writeFake({ statuses: { [moved]: [status('success')] } });
    expect(run(['gate', String(PR)]).status).toBe(0);
    const landed = landSquash();
    const finished = run(['finish', String(PR)], { FAKE_VERIFY_EXIT: '1' });
    expect(finished.status).toBe(6);
    expect(finished.stderr).toContain('S3 のすり抜け');
    expect(finished.stderr).toContain('merge.mode を "S2"');
    expect(posted().map(({ sha, state }) => [sha, state])).toEqual([
      [landed, 'pending'],
      [landed, 'failure'],
    ]);
    expect(readFake().slot.holder).toBe(`demo-1 / main-broken ${landed.slice(0, 12)}`);
    expect(auditText()).toMatch(/\tlight-landed\t.*result=failure/);
  });

  it('gate: a class-L record goes back to prepare after a rollback to S2, when its light result is missing, or when it does not match its commit', () => {
    setup({ merge: { mode: 'S2' } });
    expect(run(['prepare', String(PR)]).status).toBe(0);
    const lightCommit = git(work, ['commit-tree', `${head}^{tree}`, '-p', base, '-p', head, '-m', 'predicted']);
    const light = { class: 'L', lightTree: git(work, ['rev-parse', `${head}^{tree}`]), lightCommit, lightCheckedAt: 'x' };
    writeFileSync(stateFile(), JSON.stringify({ ...readState(), ...light }));
    const rolledBack = run(['gate', String(PR)]);
    expect(rolledBack.status).toBe(75);
    expect(rolledBack.stderr).toContain('S3 から巻き戻された');
    expect(existsSync(stateFile())).toBe(false);
    expect(auditText()).toMatch(/\tgate-record-refused\t.*class=L\tmode=S2/);

    setup({ merge: S3 });
    expect(run(['prepare', String(PR)]).status).toBe(0);
    const record = readState();
    const commit = git(work, ['commit-tree', `${head}^{tree}`, '-p', base, '-p', head, '-m', 'predicted']);
    const tree = git(work, ['rev-parse', `${head}^{tree}`]);
    // フル verify の記録しか無い L は通さない。
    writeFileSync(stateFile(), JSON.stringify({ ...record, class: 'L', predictedTree: tree, predictedVerifiedAt: 'x' }));
    expect(run(['gate', String(PR)]).status).toBe(75);
    // 着地予定コミットの木が記録と違う L は通さない。
    writeFileSync(stateFile(), JSON.stringify({ ...record, class: 'L', lightTree: 'c'.repeat(40), lightCommit: commit, lightCheckedAt: 'x' }));
    const mismatched = run(['gate', String(PR)]);
    expect(mismatched.status).toBe(75);
    expect(mismatched.stderr).toContain('食い違っています');
    expect(calls('bd', 'acquire')).toEqual([]);
    // 記録がそろっていれば S3 の gate は L を通す。
    writeFileSync(stateFile(), JSON.stringify({ ...record, class: 'L', lightTree: tree, lightCommit: commit, lightCheckedAt: 'x' }));
    expect(run(['gate', String(PR)]).status).toBe(0);
  });

  it('prepare --dry-run previews the S3 class from S1 and S2 and never runs the light check', () => {
    setup();
    advanceMain({ 'peer.txt': 'peer\n' });
    const s1 = run(['prepare', String(PR), '--dry-run']);
    expect(s1.status).toBe(3);
    expect(s1.stderr).toContain('参考: merge.mode が S2 ならクラス=F');
    expect(s1.stderr).toContain('参考: merge.mode が S3 ならクラス=L');

    setup({ merge: S3 });
    advanceMain({ 'peer.txt': 'peer\n' });
    const s3 = run(['prepare', String(PR), '--dry-run']);
    expect(s3.status).toBe(0);
    expect(s3.stderr).toContain('クラス=L');
    expect(s3.stderr).toContain('軽量チェックもしません');
    expect(verified()).toEqual([]);
    expect(existsSync(stateFile())).toBe(false);
  });

  it('a mode this script does not know on main (as S3 is to scripts cut before it) stops every phase with exit 1 before touching anything', () => {
    setup({ merge: { mode: 'S4' } });
    for (const phase of ['prepare', 'gate', 'finish']) {
      const result = run([phase, String(PR)]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('merge.mode は S0 / S1 / S2 / S3 のいずれかです (受領: "S4")');
      expect(result.stderr).toContain('git merge origin/main');
    }
    expect(existsSync(stateFile())).toBe(false);
    expect(verified()).toEqual([]);
    expect(calls('gh')).toEqual([]);
    expect(nonShowBd()).toEqual([]);
  });
});
