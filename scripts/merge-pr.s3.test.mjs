// bdboard-ulxa.3: マージ手順 S3 (merge.mode "S3") — main 側と重ならず hot file にも触れない PR (クラス L) は
// 着地予定ツリーで軽量チェック (merge.lightCheck) だけを回し、着地後検証はフル verify のまま、のテスト。
//
// 一時リポジトリ + 偽の gh / bd / npm の harness は merge-pr.test-support.mjs と共有する (merge-pr.test.mjs は
// max-lines 1500 に近いので別ファイル)。軽量チェックは契約の merge.lightCheck = 'node verify.cjs --light' で、
// 偽の検証コマンドはそのときだけ検証ログの行末に " --light" を付ける (フル verify と見分けるため)。
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { forgetLightFailure, lightLandedState, reportLightLanded } from './merge-pr/light-landed.mjs';

import {
  DEFAULT_HOT_FILES,
  DEFAULT_LIGHT_BLIND_FILES,
  DEFAULT_LIGHT_CHECK,
  decideS3Class,
  hotTouched,
  MERGE_PROCEDURE_FILES,
  parseMergeConfig,
  recordProblem,
} from './merge-pr.mjs';
import {
  advanceMain,
  auditText,
  base,
  calls,
  commitAll,
  git,
  head,
  landSquash,
  mainCheckout,
  posted,
  PR,
  readFake,
  readState,
  REPO_ROOT,
  registerTempRepoHooks,
  run,
  setup,
  simulateMerge,
  stateFile,
  status,
  TITLE,
  verified,
  work,
  writeFake,
} from './merge-pr.test-support.mjs';
import { RM_OPTIONS } from './test-support/quiet-git.mjs';

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

  it('parseMergeConfig: lightBlindFiles defaults to scripts/** harness/** .claude/** (bdboard-ulxa.7) and is a separate key from hotFiles', () => {
    const parsed = parseMergeConfig({ ...contract, merge: { mode: 'S3' } }).config;
    expect(parsed.lightBlindFiles).toEqual(['scripts/**', 'harness/**', '.claude/**']);
    expect(DEFAULT_LIGHT_BLIND_FILES).toEqual(['scripts/**', 'harness/**', '.claude/**']);
    for (const pattern of DEFAULT_LIGHT_BLIND_FILES) {
      expect(parsed.hotFiles).not.toContain(pattern); // S2 の R を増やさない
    }
    expect(parseMergeConfig({ ...contract, merge: { lightBlindFiles: ['tools/**'] } }).config).toMatchObject({
      lightBlindFiles: ['tools/**'],
      hotFiles: DEFAULT_HOT_FILES,
    });
    expect(parseMergeConfig({ ...contract, merge: { lightBlindFiles: 'scripts/**' } }).ok).toBe(false);
    const bad = parseMergeConfig({ ...contract, merge: { lightBlindFiles: ['{a,b'] } });
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain('merge.lightBlindFiles');
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

  it('decideS3Class: scripts/** on both sides is F (the light check sees no types or imports there); on one side it stays L', () => {
    const tree = 'b'.repeat(40);
    const f = { class: 'F', reason: '衝突なし・hot file なし', tree, mainFiles: ['src/a.ts'], mineFiles: ['src/b.ts'], overlap: [] };
    // PR #854 レビューの例: main が scripts/commit-message-guard.mjs の export を改名、こちらが新しい scripts/new-tool.mjs で旧名を import。
    const both = decideS3Class({ ...f, mainFiles: ['scripts/commit-message-guard.mjs'], mineFiles: ['scripts/new-tool.mjs'] }, DEFAULT_HOT_FILES);
    expect(both.class).toBe('F');
    expect(both.reason).toContain('軽量チェックが中身を見ないファイル (scripts/**) を両側が変更 (型・import を見ない。フル verify)');
    expect(both.reason).toContain('main scripts/commit-message-guard.mjs / 自分 scripts/new-tool.mjs');
    // 既定の引数 (lightBlindFiles 省略) と明示の既定値は同じ。
    expect(decideS3Class({ ...f, mainFiles: ['scripts/x.mjs'], mineFiles: ['scripts/y.test.mjs'] }, DEFAULT_HOT_FILES, DEFAULT_LIGHT_BLIND_FILES).class).toBe('F');
    expect(decideS3Class({ ...f, mainFiles: ['scripts/x.mjs'] }, DEFAULT_HOT_FILES).class).toBe('L'); // main 側だけ
    expect(decideS3Class({ ...f, mineFiles: ['scripts/y.mjs'] }, DEFAULT_HOT_FILES).class).toBe('L'); // 自分の側だけ
    // 契約で置き換えた lightBlindFiles が効く (空なら両側 scripts/** でも L)。
    expect(decideS3Class({ ...f, mainFiles: ['scripts/x.mjs'], mineFiles: ['scripts/y.mjs'] }, DEFAULT_HOT_FILES, []).class).toBe('L');
    expect(decideS3Class({ ...f, mainFiles: ['tools/a.mjs'], mineFiles: ['tools/b.mjs'] }, DEFAULT_HOT_FILES, ['tools/**']).class).toBe('F');
  });

  it('decideS3Class: each side hitting any lightBlindFiles pattern is F, even when the two sides hit different patterns', () => {
    const tree = 'b'.repeat(40);
    const f = { class: 'F', reason: '衝突なし・hot file なし', tree, mainFiles: ['src/a.ts'], mineFiles: ['src/b.ts'], overlap: [] };
    const blind = ['tools/**', 'scripts/**', 'docs/**'];
    // main は tools/、自分は scripts/ (自分の scripts が main の tools を import していれば軽量チェックは見ない)。
    const crossed = decideS3Class({ ...f, mainFiles: ['tools/a.mjs', 'src/x.ts'], mineFiles: ['src/y.ts', 'scripts/b.mjs'] }, DEFAULT_HOT_FILES, blind);
    expect(crossed.class).toBe('F');
    expect(crossed.reason).toContain('軽量チェックが中身を見ないファイル (tools/**, scripts/**) を両側が変更');
    expect(crossed.reason).toContain('main tools/a.mjs / 自分 scripts/b.mjs');
    expect(decideS3Class({ ...f, mainFiles: ['scripts/a.mjs'], mineFiles: ['tools/b.mjs'] }, DEFAULT_HOT_FILES, blind).class).toBe('F');
    // 片側だけなら (要素が複数当たっても) L のまま。
    expect(decideS3Class({ ...f, mainFiles: ['tools/a.mjs', 'scripts/a.mjs'] }, DEFAULT_HOT_FILES, blind).class).toBe('L');
  });

  it('decideS3Class: harness/** and .claude/** on both sides is F by default (bdboard-ulxa.7: only test:server sees their coupling); on one side it stays L', () => {
    const tree = 'b'.repeat(40);
    const f = { class: 'F', reason: '衝突なし・hot file なし', tree, mainFiles: ['src/a.ts'], mineFiles: ['src/b.ts'], overlap: [] };
    // 指摘 5 の例: main が route.sh の出力を変え、こちらが aimix-run.sh (route.sh の出力を解析する) を変える。
    const pair = decideS3Class(
      { ...f, mainFiles: ['harness/packs/bdboard-harness/scripts/route.sh'], mineFiles: ['harness/packs/bdboard-harness/scripts/aimix-run.sh'] },
      DEFAULT_HOT_FILES,
    );
    expect(pair.class).toBe('F');
    expect(pair.reason).toContain('軽量チェックが中身を見ないファイル (harness/**) を両側が変更');
    // 注入コピー (.claude/skills/bdboard-harness) 側と、パック (harness/packs) 側をそれぞれ触る PR の組も F (要素が別でよい)。
    const crossed = decideS3Class(
      { ...f, mainFiles: ['.claude/skills/bdboard-harness/references/layering.md'], mineFiles: ['harness/packs/bdboard-harness/hooks/README.md'] },
      DEFAULT_HOT_FILES,
    );
    expect(crossed.class).toBe('F');
    expect(crossed.reason).toContain('(harness/**, .claude/**)');
    expect(decideS3Class({ ...f, mainFiles: ['.claude/agents/a.md'], mineFiles: ['.claude/rules/b.md'] }, DEFAULT_HOT_FILES).class).toBe('F');
    // 片側だけなら L のまま (パックの変更は注入コピーの変更とセットで 1 つの PR に入る)。
    expect(decideS3Class({ ...f, mineFiles: ['harness/packs/x.sh', '.claude/skills/x.sh'] }, DEFAULT_HOT_FILES).class).toBe('L');
    expect(decideS3Class({ ...f, mainFiles: ['.claude/agents/a.md'] }, DEFAULT_HOT_FILES).class).toBe('L');
    // 契約で置き換えれば効かなくなる (置き換え方式は scripts/** と同じ)。
    expect(decideS3Class({ ...f, mainFiles: ['harness/a.sh'], mineFiles: ['harness/b.sh'] }, DEFAULT_HOT_FILES, ['scripts/**']).class).toBe('L');
  });

  it('decideS3Class: the merge procedure itself (merge-pr / check-drift) on either side is F, whatever lightBlindFiles says', () => {
    const tree = 'b'.repeat(40);
    const f = { class: 'F', reason: '衝突なし・hot file なし', tree, mainFiles: ['src/a.ts'], mineFiles: ['src/b.ts'], overlap: [] };
    expect(MERGE_PROCEDURE_FILES).toEqual([
      'scripts/merge-pr/**',
      'scripts/merge-pr.mjs',
      'scripts/check-drift/**',
      'scripts/check-drift.mjs',
      'scripts/check-commit-parse/**', // bdboard-07q8: merge-pr/pr-title.mjs が PR タイトルの検査に動的 import する
      'scripts/check-commit-parse.mjs',
      'scripts/process-identity.mjs',
      'scripts/process-tree.mjs',
      'scripts/verify-slot.mjs',
      'scripts/verify-slot-files.mjs',
      'scripts/verify-slot-queue.mjs',
      'scripts/verify-slot-wait.mjs', // bdboard-xdk8: verify-slot.mjs が import する (待ちの打ち切りの延長と待ちの表示)
      'scripts/worktree-lock.mjs', // bdboard-wea0.2: merge-pr/worktree-hold.mjs が import する
      'scripts/worktree-lock-owner.mjs',
    ]);
    for (const file of ['scripts/merge-pr/finish.mjs', 'scripts/merge-pr.mjs', 'scripts/check-drift/git.mjs', 'scripts/check-drift.mjs', 'scripts/check-commit-parse/classify.mjs', 'scripts/check-commit-parse.mjs', 'scripts/process-identity.mjs']) {
      for (const side of ['mainFiles', 'mineFiles']) {
        const decided = decideS3Class({ ...f, [side]: [file] }, DEFAULT_HOT_FILES, []);
        expect(decided.class, `${side}: ${file}`).toBe('F');
        expect(decided.reason).toContain(`マージ手順自身 (merge-pr / check-drift) に触れている (フル verify): ${file}`);
      }
    }
    // 似た名前でも手順の外なら対象外 (scripts/** の片側だけ = L)。
    expect(decideS3Class({ ...f, mineFiles: ['scripts/merge-pr.test.mjs', 'scripts/check-drift.test.mjs'] }, DEFAULT_HOT_FILES).class).toBe('L');
  });

  it('MERGE_PROCEDURE_FILES covers every scripts/ module that merge-pr and check-drift import (walked from their entry points)', () => {
    // PR #854 再レビュー: merge-pr は scripts/merge-pr/ の外 (process-identity / process-tree / verify-slot*) も import する。
    // そこが軽量チェックだけで壊れて着地しても merge-pr は起動時に落ちる。import が増えたらここで落ちる。
    const specifier = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/g;
    const seen = new Set();
    const queue = ['scripts/merge-pr.mjs', 'scripts/check-drift.mjs'];
    while (queue.length > 0) {
      const file = queue.shift();
      if (seen.has(file)) {
        continue;
      }
      seen.add(file);
      for (const match of readFileSync(path.join(REPO_ROOT, file), 'utf8').matchAll(specifier)) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
        expect(existsSync(path.join(REPO_ROOT, target)), `${file} imports ${match[1]}`).toBe(true);
        queue.push(target);
      }
    }
    const walked = [...seen].filter((file) => file.startsWith('scripts/'));
    expect(walked).toEqual(expect.arrayContaining(['scripts/merge-pr/finish.mjs', 'scripts/process-identity.mjs', 'scripts/verify-slot.mjs']));
    expect(walked.filter((file) => hotTouched([file], MERGE_PROCEDURE_FILES).length === 0)).toEqual([]);
  });

  it('lightLandedState / reportLightLanded never throw (one warning line instead): they also run on S2 paths', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bdboard-light-landed-'));
    vi.stubEnv('BDBOARD_MERGE_AUDIT_LOG', path.join(dir, 'audit.log'));
    const written = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => written.push(String(chunk)));
    try {
      // git リポジトリでない場所: 状態ディレクトリの場所 (git rev-parse) から失敗する。
      expect(lightLandedState(dir, 'a'.repeat(40))).toBeNull();
      // 報告の途中 (案内の組み立て) で投げても外へ出さない。
      expect(reportLightLanded({ class: 'L', pr: 9, id: 'demo-9' }, undefined, 'failure', 'manual')).toBeNull();
      expect(reportLightLanded(null, 'a'.repeat(40), 'failure', 'manual')).toBeNull(); // L でなければ何もしない
    } finally {
      spy.mockRestore();
      vi.unstubAllEnvs();
      rmSync(dir, RM_OPTIONS);
    }
    expect(written).toHaveLength(2);
    expect(written[0]).toMatch(/^merge-pr: 警告: クラス L の記録 \(状態ファイル\) の読み出しに失敗しました \(マージ手順は続けます\): .+\n$/);
    expect(written[1]).toMatch(/^merge-pr: 警告: クラス L の着地後検証の報告に失敗しました \(マージ手順は続けます\): .+\n$/);
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
    // L の木の突き合わせは light-tree (S2 の指標・戻し規則が数える predicted-tree には出さない)。
    expect(auditText()).toMatch(/\tlight-tree\tpr=7\tid=demo-1\tmatch=true.*class=L/);
    expect(auditText()).not.toMatch(/\tpredicted-tree\t/);
    expect(auditText()).toMatch(/\tlight-landed\t.*result=success\tby=finish/);
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

  it('S3: scripts/** changed on both sides is F with the full verify; on one side only it stays L', () => {
    setup({ merge: S3, branchFiles: { 'scripts/new-tool.mjs': "import { renamed } from './commit-message-guard.mjs';\n" } });
    advanceMain({ 'scripts/commit-message-guard.mjs': 'export const renamedAgain = 1;\n' });
    const both = run(['prepare', String(PR)]);
    expect(both.status).toBe(0);
    expect(both.stderr).toContain('クラス=F');
    expect(both.stderr).toContain('軽量チェックが中身を見ないファイル (scripts/**) を両側が変更 (型・import を見ない');
    expect(readState().predictedVerifiedAt).toBeTruthy();
    expect(verified()).toEqual([readState().predictedCommit]); // --light ではない

    setup({ merge: S3, branchFiles: { 'scripts/new-tool.mjs': 'export const x = 1;\n' } });
    advanceMain({ 'peer.txt': 'peer\n' });
    const mineOnly = run(['prepare', String(PR)]);
    expect(mineOnly.status).toBe(0);
    expect(mineOnly.stderr).toContain('クラス=L');
    expect(verified()).toEqual([`${readState().lightCommit} --light`]);
  });

  it('S3: harness/** and .claude/** changed on both sides is F with the full verify by default (bdboard-ulxa.7); on one side only it stays L', () => {
    setup({ merge: S3, branchFiles: { 'harness/packs/demo/scripts/aimix-run.sh': '#!/bin/sh\n' } });
    advanceMain({ '.claude/skills/demo/route.sh': '#!/bin/sh\n' });
    const both = run(['prepare', String(PR)]);
    expect(both.status).toBe(0);
    expect(both.stderr).toContain('クラス=F');
    expect(both.stderr).toContain('軽量チェックが中身を見ないファイル (harness/**, .claude/**) を両側が変更');
    expect(verified()).toEqual([readState().predictedCommit]); // --light ではない

    setup({ merge: S3, branchFiles: { 'harness/packs/demo/scripts/aimix-run.sh': '#!/bin/sh\n' } });
    advanceMain({ 'peer.txt': 'peer\n' });
    const mineOnly = run(['prepare', String(PR)]);
    expect(mineOnly.status).toBe(0);
    expect(mineOnly.stderr).toContain('クラス=L');
    expect(verified()).toEqual([`${readState().lightCommit} --light`]);
  });

  it("S3: the contract's merge.lightBlindFiles is what prepare classifies with (replacing the defaults)", () => {
    const both = { 'scripts/new-tool.mjs': 'export const x = 1;\n' };
    // 空のリスト: 既定なら F になる両側 scripts/** が L になる。
    setup({ merge: { ...S3, lightBlindFiles: [] }, branchFiles: both });
    advanceMain({ 'scripts/other-tool.mjs': 'export const y = 1;\n' });
    const emptied = run(['prepare', String(PR)]);
    expect(emptied.status).toBe(0);
    expect(emptied.stderr).toContain('クラス=L');
    expect(verified()).toEqual([`${readState().lightCommit} --light`]);

    // 別のリスト: 既定なら L になる (scripts/** の外) 両側の変更が、要素が別々でも F になる。
    setup({ merge: { ...S3, lightBlindFiles: ['tools/**', 'gen/**'] }, branchFiles: { 'gen/b.mjs': 'export const b = 1;\n' } });
    advanceMain({ 'tools/a.mjs': 'export const a = 1;\n' });
    const replaced = run(['prepare', String(PR)]);
    expect(replaced.status).toBe(0);
    expect(replaced.stderr).toContain('軽量チェックが中身を見ないファイル (tools/**, gen/**) を両側が変更');
    expect(readState().class).toBe('F');
    expect(verified()).toEqual([readState().predictedCommit]);
  });

  it('S3: the merge procedure (merge-pr / check-drift) changed on one side only is F, not L', () => {
    setup({ merge: S3, branchFiles: { 'scripts/merge-pr/new-step.mjs': 'export const step = 1;\n' } });
    advanceMain({ 'peer.txt': 'peer\n' });
    const mine = run(['prepare', String(PR)]);
    expect(mine.status).toBe(0);
    expect(mine.stderr).toContain('マージ手順自身 (merge-pr / check-drift) に触れている (フル verify): scripts/merge-pr/new-step.mjs');
    expect(readState().class).toBe('F');

    // main 側の merge-pr の変更は prepare の入口で止まる (取り込みが先) ので、main 側は check-drift で確かめる。
    setup({ merge: S3 });
    advanceMain({ 'scripts/check-drift/git.mjs': 'export const x = 1;\n' });
    const mainSide = run(['prepare', String(PR)]);
    expect(mainSide.status).toBe(0);
    expect(mainSide.stderr).toContain('マージ手順自身 (merge-pr / check-drift) に触れている (フル verify): scripts/check-drift/git.mjs');
    expect(readState().class).toBe('F');
    expect(verified()).toEqual([readState().predictedCommit]);
  });

  it('S3: a broken PRED_BASE (ledger failure) is refused before the light check runs', () => {
    setup({ merge: S3 });
    const moved = advanceMain({ 'peer.txt': 'peer\n' });
    writeFake({ statuses: { [moved]: [status('failure')] } });
    const prepared = run(['prepare', String(PR)]);
    expect(prepared.status).toBe(4);
    expect(prepared.stderr).toContain('クラス=L');
    expect(prepared.stderr).toContain(`main ${moved.slice(0, 12)} の着地後検証 (bdboard/landed-verify) が failure です`);
    expect(verified()).toEqual([]); // 壊れた main の上で軽量チェックを回さない
    expect(existsSync(stateFile())).toBe(false);
    expect(auditText()).toMatch(/\tprepare-main-broken\t/);
    expect(auditText()).not.toMatch(/\tlight-check\t/);
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
    expect(finished.stderr).toContain('既知のフレーク');
    expect(finished.stderr).toContain('修復 PR (fix-forward / revert) に .claude/bdboard-harness.json の merge.mode を "S2" にする 1 行を含め');
    // bdboard-ulxa.7 (指摘 9): 別の merger も同じ着地コミットを報告しうる。実際に重なる条件と、起票前に見る 3 か所 (文言は docs と同じ)。
    const step3 = finished.stderr.split('\n').find((line) => line.includes('  3. 同じ着地コミットの failure を別の merger も報告することがある'));
    expect(step3).toBeDefined();
    for (const overlap of ['gh pr merge から LEASE 以上あとに finish を始めた', 'pending を書く前の npm ci が LEASE より長い', 'heartbeat の投稿が LEASE より長く失敗', '自己修復が報告したあとで遅れて finish が走った']) {
      expect(step3).toContain(overlap);
    }
    expect(step3).not.toContain('finish の verify が LEASE より長引く'); // finish の verify 自体は pending を LEASE/3 ごとに更新するので重ならない
    expect(step3).toContain(`bd search "main 破損: ${landed.slice(0, 12)}" --status open`);
    expect(step3).toContain(`bd merge-slot check (枠の holder が "… / main-broken ${landed.slice(0, 12)}")`);
    expect(step3).toContain('gh pr list --state open');
    expect(step3).toContain('していれば重ねて作らない');
    // フレークの再検証 (手順 1) は success でも main-broken の枠が残るので、確かめて返すコマンドも案内する。
    expect(finished.stderr).toContain(`bd merge-slot check で "… / main-broken ${landed.slice(0, 12)}" を確かめ、gate --repair 済みの修復 PR が無ければ bd merge-slot release --holder '<holder>'`);
    expect(posted().map(({ sha, state }) => [sha, state])).toEqual([
      [landed, 'pending'],
      [landed, 'failure'],
    ]);
    expect(readFake().slot.holder).toBe(`demo-1 / main-broken ${landed.slice(0, 12)}`);
    expect(auditText()).toMatch(/\tlight-landed\t.*result=failure/);
  });

  // 指摘 4: L の failure で finish が状態を消すと、フレークの再検証 (merge-pr verify <sha>) が L を見分けられず、
  // light-landed の success を書けない → result=failure by=finish が最後の行として残り、すり抜けに数えられていた。
  it('S3 flake: finish keeps the L record on a failure, so the re-verify writes a light-landed success as the last line and then removes the record (a non-L failure removes it at once)', () => {
    setup({ merge: S3 });
    const moved = advanceMain({ 'peer.txt': 'peer\n' });
    expect(run(['prepare', String(PR)]).status).toBe(0);
    writeFake({ statuses: { [moved]: [status('success')] } });
    expect(run(['gate', String(PR)]).status).toBe(0);
    const landed = landSquash();
    expect(run(['finish', String(PR)], { FAKE_VERIFY_EXIT: '1' }).status).toBe(6);
    // class と着地コミットが残り、failure の印が付く (実行中の印は bdboard-wea0.2 で worktree lock に置き換えて書かない)。
    expect(readState()).toMatchObject({ class: 'L', newMain: landed, landedResult: 'failure' });
    expect(readState()).not.toHaveProperty('verifyingPid');
    const holder = `demo-1 / main-broken ${landed.slice(0, 12)}`;
    expect(readFake().slot.holder).toBe(holder);
    const acquires = calls('bd', 'acquire').length; // gate の枠と、finish が failure で取った main-broken の枠

    const again = run(['verify', landed]); // ログでフレークと分かった: 検証し直しは success
    expect(again.status).toBe(0);
    const lightLines = () =>
      auditText()
        .split('\n')
        .filter((line) => line.includes('\tlight-landed\t') && line.includes(`new=${landed}`))
        .map((line) => /result=(\w+)\tby=(\w+)/.exec(line)?.slice(1));
    expect(lightLines()).toEqual([
      ['failure', 'finish'],
      ['success', 'manual'],
    ]);
    expect(posted().at(-1)).toMatchObject({ sha: landed, state: 'success' });
    expect(existsSync(stateFile())).toBe(false); // フレークと確かめられた failure の記録は消える
    // main-broken の枠は自動では返さず、返すコマンドをそのまま印字する (修復 PR が引き継いでいると返してはいけない)。
    expect(again.stderr).toContain(`bd merge-slot release --holder '${holder}'`);
    expect(readFake().slot.holder).toBe(holder);
    // 再実行しても 2 つ目の failure の行は付かず、枠も取り直さない。
    const rerun = run(['finish', String(PR)]);
    expect(rerun.status).toBe(2);
    expect(rerun.stderr).toContain('gate した記録がありません');
    expect(lightLines()).toEqual([
      ['failure', 'finish'],
      ['success', 'manual'],
    ]);
    expect(calls('bd', 'acquire')).toHaveLength(acquires);
    // 対照: 別の SHA の success では、その SHA の main-broken の枠が無いので何も印字しない。
    const other = run(['verify', moved]);
    expect(other.status).toBe(0);
    expect(other.stderr).not.toContain('merge-slot release');

    // 対照: クラス N の failure は従来どおり記録を消す (消えるのは L だけを残す変更)。
    setup({ merge: S3 });
    expect(run(['prepare', String(PR)]).stderr).toContain('クラス=N');
    expect(run(['gate', String(PR)]).status).toBe(0);
    simulateMerge();
    expect(run(['finish', String(PR)], { FAKE_VERIFY_EXIT: '1' }).status).toBe(6);
    expect(existsSync(stateFile())).toBe(false);
  });

  // レビュー (major): 残した記録は gateAt / releasedAt / newMain を持つので、そのままだと finish <N> をやり直せてしまい、
  // 直った後の main に main-broken の枠を取り直して全 gate を止める。origin/main では記録が無く exit 2 だった。
  it('S3 failure record: after a class-L failure, finish / gate / prepare stop with exit 2 pointing at merge-pr verify, take no slot, and a confirmed slip keeps the record', () => {
    setup({ merge: S3 });
    const moved = advanceMain({ 'peer.txt': 'peer\n' });
    expect(run(['prepare', String(PR)]).status).toBe(0);
    writeFake({ statuses: { [moved]: [status('success')] } });
    expect(run(['gate', String(PR)]).status).toBe(0);
    const landed = landSquash();
    expect(run(['finish', String(PR)], { FAKE_VERIFY_EXIT: '1' }).status).toBe(6);
    const acquires = calls('bd', 'acquire').length;
    const verifiedBefore = verified();
    const auditBefore = auditText();

    for (const phase of ['finish', 'gate', 'prepare']) {
      const rerun = run([phase, String(PR)]);
      expect(rerun.status, phase).toBe(2);
      expect(rerun.stderr, phase).toContain('その着地後検証');
      expect(rerun.stderr, phase).toContain('prepare / gate / finish はやり直せません');
      expect(rerun.stderr, phase).toContain(`npm run merge-pr -- verify ${landed}`);
      expect(rerun.stderr, phase).not.toContain('枠を保持');
    }
    expect(calls('bd', 'acquire')).toHaveLength(acquires); // main-broken の枠を取り直していない
    expect(verified()).toEqual(verifiedBefore); // 同じ SHA をもう一度検証していない
    expect(auditText().slice(auditBefore.length)).not.toMatch(/\tlight-landed\t|\tlanded-verify\t/);
    expect(readFake().slot.holder).toBe(`demo-1 / main-broken ${landed.slice(0, 12)}`);

    // 再検証も failure (確定したすり抜け): 記録は残る (すり抜けの件数で抑えられる)。
    expect(run(['verify', landed], { FAKE_VERIFY_EXIT: '1' }).status).toBe(6);
    expect(readState()).toMatchObject({ class: 'L', newMain: landed, landedResult: 'failure' });
  });

  // 指摘 2: gate → gh pr merge の後、finish が newMain を書く前に落ちると、状態ファイルは gate のまま (newMain なし)。
  // 8 分の LEASE の後に着地コミットの検証をするのは別の人 (merge-pr verify <sha> / 次の gate の自己修復)。
  it('S3 slip with no newMain: a landing whose finish never ran is attributed to its L record by tree and first parent (merge-pr verify)', () => {
    setup({ merge: S3 });
    const moved = advanceMain({ 'peer.txt': 'peer\n' });
    expect(run(['prepare', String(PR)]).status).toBe(0);
    writeFake({ statuses: { [moved]: [status('success')] } });
    expect(run(['gate', String(PR)]).status).toBe(0);
    const landed = landSquash();
    expect(readState()).toMatchObject({ class: 'L', predBase: moved, gateAt: expect.any(String) });
    expect(readState().newMain).toBeUndefined();

    const failed = run(['verify', landed], { FAKE_VERIFY_EXIT: '1' });
    expect(failed.status).toBe(6);
    expect(failed.stderr).toContain(`${landed.slice(0, 12)} はクラス L (着地予定ツリーの軽量チェックだけで着地) で、その着地後検証が failure です — S3 のすり抜け`);
    expect(auditText()).toMatch(new RegExp(`\tlight-landed\tpr=7\tid=demo-1\tnew=${landed}\tresult=failure\tby=manual`));
  });

  it('lightLandedState: an L record without newMain matches only a commit with its lightTree and first parent PRED_BASE; one with newMain only that SHA', () => {
    setup({ merge: S3 });
    advanceMain({ 'peer.txt': 'peer\n' });
    expect(run(['prepare', String(PR)]).status).toBe(0);
    const record = readState();
    const landed = landSquash();
    const write = (patch) => writeFileSync(stateFile(), JSON.stringify({ ...record, ...patch }));
    const other = 'c'.repeat(40);

    // prepare しただけで gate していない記録 (gateAt なし) は、同じ木と親でも引かない (マージ前の記録に帰属しない)。
    write({});
    expect(record.gateAt).toBeUndefined();
    expect(lightLandedState(work, landed)).toBeNull();
    write({ gateAt: 'x' });
    expect(lightLandedState(work, landed)).toMatchObject({ pr: PR, class: 'L' });
    write({ gateAt: 'x', releasedAt: 'x', holder: 'demo-1 / PR#7' });
    expect(lightLandedState(work, landed)).toMatchObject({ pr: PR, holder: 'demo-1 / PR#7' });
    // 照合が外れる記録は帰属しない (別の PR・別の木・別のベース・L でない・読めないコミット)。
    write({ gateAt: 'x', lightTree: other });
    expect(lightLandedState(work, landed)).toBeNull();
    write({ gateAt: 'x', predBase: other });
    expect(lightLandedState(work, landed)).toBeNull();
    write({ gateAt: 'x', class: 'F' });
    expect(lightLandedState(work, landed)).toBeNull();
    write({ gateAt: 'x' });
    expect(lightLandedState(work, other)).toBeNull();
    expect(lightLandedState(work, 'not-a-sha')).toBeNull();
    // newMain を持つ記録は、その SHA でだけ引く (木と親が合っていても別の着地コミットなら内容では引かない)。
    write({ gateAt: 'x', newMain: other });
    expect(lightLandedState(work, landed)).toBeNull();
    expect(lightLandedState(work, other)).toMatchObject({ pr: PR });
    write({ newMain: landed, lightTree: other });
    expect(lightLandedState(work, landed)).toMatchObject({ pr: PR });
  });

  // レビュー (nit): 同じ木と親に合う gate 済みの記録が複数あっても、readdir の順で黙って決めない。
  it('lightLandedState: when several gated L records match the landed commit, it says so and picks the most recent gateAt', () => {
    setup({ merge: S3 });
    advanceMain({ 'peer.txt': 'peer\n' });
    expect(run(['prepare', String(PR)]).status).toBe(0);
    const record = readState();
    const landed = landSquash();
    const dir = path.dirname(stateFile());
    const put = (pr, gateAt) => writeFileSync(path.join(dir, `pr-${pr}.json`), JSON.stringify({ ...record, pr, id: `demo-${pr}`, gateAt }));
    const written = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => written.push(String(chunk)));
    try {
      // PR 番号の小さい方が新しい: 番号順 (readdir の順) では決まらない。
      put(8, '2026-10-02T00:00:00.000Z');
      put(9, '2026-10-01T00:00:00.000Z');
      expect(lightLandedState(work, landed)).toMatchObject({ pr: 8 });
      put(9, '2026-10-03T00:00:00.000Z');
      expect(lightLandedState(work, landed)).toMatchObject({ pr: 9 });
      put(8, '2026-10-03T00:00:00.000Z'); // 同時刻なら PR 番号の大きい方
      expect(lightLandedState(work, landed)).toMatchObject({ pr: 9 });
    } finally {
      spy.mockRestore();
    }
    expect(written).toHaveLength(6); // 3 回の照会 × 2 行
    expect(written.slice(0, 2).join('')).toBe(
      `merge-pr: 注意: ${landed.slice(0, 12)} に合うクラス L の記録が複数あります (PR #8, #9)。\nmerge-pr: gate の時刻が最も新しい PR #8 のものとして扱います。\n`,
    );
    expect(written[3]).toBe('merge-pr: gate の時刻が最も新しい PR #9 のものとして扱います。\n');
    expect(written[5]).toBe('merge-pr: gate の時刻が最も新しい PR #9 のものとして扱います。\n');
    // 1 件だけなら何も言わない (上の spy の外)。
    rmSync(path.join(dir, 'pr-9.json'));
    rmSync(path.join(dir, 'pr-8.json'));
    put(8, 'x');
    expect(lightLandedState(work, landed)).toMatchObject({ pr: 8 });
  });

  // レビュー (minor): 手動の再検証が success のとき、フレークと確かめられた failure の記録だけを消す。
  it('forgetLightFailure: removes only a finish-kept failure record of that SHA', () => {
    setup({ merge: S3 });
    advanceMain({ 'peer.txt': 'peer\n' });
    expect(run(['prepare', String(PR)]).status).toBe(0);
    const record = readState();
    const landed = landSquash();
    const kept = { ...record, gateAt: 'x', newMain: landed, landedResult: 'failure' };
    const attempt = (patch, sha = landed) => {
      writeFileSync(stateFile(), JSON.stringify({ ...kept, ...patch }));
      forgetLightFailure(work, { ...kept, ...patch }, sha);
      return existsSync(stateFile());
    };
    expect(attempt({})).toBe(false); // フレークだった failure の記録
    expect(attempt({ landedResult: undefined })).toBe(true); // error で残した記録 (finish のやり直しの対象) は消さない
    expect(attempt({ class: 'F' })).toBe(true);
    expect(attempt({}, 'd'.repeat(40))).toBe(true); // 別の SHA の再検証では消さない
    // bdboard-wea0.2: 旧コードの実行中の印 (verifyingPid) は見ない。印の付いた記録は finish の検証が終わってから書かれる。
    expect(attempt({ verifyingPid: process.ppid, verifyingAt: new Date().toISOString() })).toBe(false);
    expect(forgetLightFailure(work, null, landed)).toBeUndefined(); // 記録が無くても投げない
  });

  it('S3 slip after an error: finish keeps the L record when the landed verify cannot run, and merge-pr verify <sha> reports a failure as the slip', () => {
    setup({ merge: S3 });
    const moved = advanceMain({ 'peer.txt': 'peer\n' });
    expect(run(['prepare', String(PR)]).status).toBe(0);
    writeFake({ statuses: { [moved]: [status('success')] } });
    expect(run(['gate', String(PR)]).status).toBe(0);
    const landed = landSquash();
    // 75 = verify スロット待ちの打ち切り (verify は走っていない) → 着地後検証は error。
    const errored = run(['finish', String(PR)], { FAKE_VERIFY_EXIT: '75' });
    expect(errored.status).toBe(1);
    expect(errored.stderr).toContain('はクラス L (軽量チェックだけで着地) ですが、着地後検証を実行できませんでした');
    expect(errored.stderr).toContain(`npm run merge-pr -- verify ${landed}`);
    expect(errored.stderr).not.toContain('着地後検証が failure です'); // 結果が無いのですり抜けとはまだ言わない
    expect(auditText()).toMatch(new RegExp(`\tlight-landed\tpr=7\tid=demo-1\tnew=${landed}\tresult=error\tby=finish`));
    // 状態ファイルは error でも残る (class と着地コミット) — verify がこれで L を見分ける。
    expect(readState()).toMatchObject({ class: 'L', newMain: landed });

    const failed = run(['verify', landed], { FAKE_VERIFY_EXIT: '1' });
    expect(failed.status).toBe(6);
    expect(failed.stderr).toContain(`${landed.slice(0, 12)} はクラス L (着地予定ツリーの軽量チェックだけで着地) で、その着地後検証が failure です — S3 のすり抜け`);
    expect(failed.stderr).toContain('既知のフレーク');
    expect(failed.stderr).toContain('merge.mode を "S2" にする 1 行を含め');
    expect(auditText()).toMatch(new RegExp(`\tlight-landed\tpr=7\tid=demo-1\tnew=${landed}\tresult=failure\tby=manual`));

    // 対照: L の記録が無い SHA (PRED_BASE) の verify はすり抜けを言わない。
    const other = run(['verify', moved], { FAKE_VERIFY_EXIT: '1' });
    expect(other.status).toBe(6);
    expect(other.stderr).not.toContain('S3 のすり抜け');
    expect(auditText()).not.toMatch(new RegExp(`\tlight-landed\t.*new=${moved}`));
  });

  it('S3 slip found by gate: a self-heal verify of a PRED_BASE left unverified by a class-L finish reports the slip', () => {
    setup({ merge: S3, mainDate: '2026-01-01T00:00:00Z' });
    writeFake({ statuses: {} }); // PRED_BASE の着地後検証が LEASE を過ぎても無い = 自己修復の対象
    // PRED_BASE (base) をクラス L で着地させた別の PR の finish が error で終わり、記録だけが残っている。
    const leftover = { pr: 9, id: 'demo-9', class: 'L', newMain: base, gateAt: 'x', releasedAt: 'x' };
    expect(run(['prepare', String(PR)]).status).toBe(0);
    writeFileSync(path.join(path.dirname(stateFile()), 'pr-9.json'), JSON.stringify(leftover));
    const gated = run(['gate', String(PR)], { FAKE_VERIFY_EXIT: '1' });
    expect(gated.status).toBe(4);
    expect(gated.stderr).toContain(`${base.slice(0, 12)} はクラス L (着地予定ツリーの軽量チェックだけで着地) で、その着地後検証が failure です — S3 のすり抜け`);
    expect(auditText()).toMatch(new RegExp(`\tlight-landed\tpr=9\tid=demo-9\tnew=${base}\tresult=failure\tby=self-heal`));
    expect(calls('bd', 'acquire')).toEqual([]);
  });

  it('S3 slip found by gate with no newMain: the self-heal of a PRED_BASE that an L landing left before finish ran reports the slip (bdboard-ulxa.7)', () => {
    setup({ merge: S3, mainDate: '2026-01-01T00:00:00Z' });
    writeFake({ statuses: {} });
    // 別の PR (9) が L として着地した (base の上に 1 親の squash。LEASE を過ぎた古い時刻)。その finish は走らなかった。
    writeFileSync(path.join(mainCheckout, 'landed-by-9.txt'), 'nine\n');
    const landed = commitAll(mainCheckout, 'feat(demo-9): other thing (#9)', { GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' });
    git(mainCheckout, ['push', '-q', 'origin', 'main']);
    expect(run(['prepare', String(PR)]).status).toBe(0);
    const gateOnly = { pr: 9, id: 'demo-9', class: 'L', predBase: base, head: 'e'.repeat(40), lightCommit: 'f'.repeat(40), gateAt: 'x' };
    const dir = path.dirname(stateFile());
    const lightTree = git(mainCheckout, ['rev-parse', `${landed}^{tree}`]);
    // 木が合わない記録 (別の PR の L) では帰属しない: 普通の main 破損として扱う。
    writeFileSync(path.join(dir, 'pr-9.json'), JSON.stringify({ ...gateOnly, lightTree: 'c'.repeat(40) }));
    const unattributed = run(['gate', String(PR)], { FAKE_VERIFY_EXIT: '1' });
    expect(unattributed.status).toBe(4);
    expect(unattributed.stderr).not.toContain('S3 のすり抜け');
    expect(auditText()).not.toMatch(/\tlight-landed\t/);

    writeFake({ statuses: {} }); // 自己修復が台帳に書いた failure を消す (もう一度 PRED_BASE を未検証にする)
    expect(run(['prepare', String(PR)]).status).toBe(0);
    writeFileSync(path.join(dir, 'pr-9.json'), JSON.stringify({ ...gateOnly, lightTree }));
    const gated = run(['gate', String(PR)], { FAKE_VERIFY_EXIT: '1' });
    expect(gated.status).toBe(4);
    expect(gated.stderr).toContain(`${landed.slice(0, 12)} はクラス L (着地予定ツリーの軽量チェックだけで着地) で、その着地後検証が failure です — S3 のすり抜け`);
    expect(auditText()).toMatch(new RegExp(`\tlight-landed\tpr=9\tid=demo-9\tnew=${landed}\tresult=failure\tby=self-heal`));
    expect(calls('bd', 'acquire')).toEqual([]);
  });

  // PR #854 再レビュー: listStates が JSON.parse の結果をそのまま返していたので、中身が null の状態ファイル 1 つで
  // S2 の merge-pr verify / gate の自己修復が「想定外のエラー」(exit 1) になっていた。
  for (const [label, content] of [
    ['null', 'null'],
    ['a non-object', '"not a record"'],
  ]) {
    it(`S2: a state file holding ${label} does not change the exit codes of merge-pr verify or the gate self-heal`, () => {
      setup({ merge: { mode: 'S2' }, mainDate: '2026-01-01T00:00:00Z' });
      writeFake({ statuses: {} });
      expect(run(['prepare', String(PR)]).status).toBe(0);
      const dir = path.dirname(stateFile());
      writeFileSync(path.join(dir, 'pr-8.json'), content);
      // 壊れた記録と並んだ正しい L の記録は今までどおり見分ける (飛ばすのは壊れた方だけ)。
      writeFileSync(path.join(dir, 'pr-9.json'), JSON.stringify({ pr: 9, id: 'demo-9', class: 'L', newMain: base }));

      const manual = run(['verify', base], { FAKE_VERIFY_EXIT: '1' });
      expect(manual.stderr).not.toContain('想定外');
      expect(manual.status).toBe(6);
      expect(manual.stderr).toContain('S3 のすり抜け');
      expect(auditText()).toMatch(new RegExp(`\tlight-landed\tpr=9\tid=demo-9\tnew=${base}\tresult=failure\tby=manual`));

      writeFake({ statuses: {} });
      const gated = run(['gate', String(PR)], { FAKE_VERIFY_EXIT: '1' });
      expect(gated.stderr).not.toContain('想定外');
      expect(gated.status).toBe(4);
      expect(auditText()).toMatch(new RegExp(`\tlight-landed\tpr=9\tid=demo-9\tnew=${base}\tresult=failure\tby=self-heal`));

      // 壊れた記録しか無くても同じ (L とは見分けないだけ)。
      writeFileSync(path.join(dir, 'pr-9.json'), content);
      const alone = run(['verify', base]);
      expect(alone.stderr).not.toContain('想定外');
      expect(alone.status).toBe(0);
    });
  }

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
