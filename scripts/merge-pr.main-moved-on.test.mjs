// bdboard-89jv: PR #862 (ulxa.7) の差分レビュー指摘 F1-F7 のテスト。
//   F1 finish の再実行 (および遅い回復 finish) が、修復済みの main で古い SHA の main-broken 枠を取り直さない
//   F2 holder の印字を shellQuote する / F4 枠を読めないとき 1 行出す / F5 枠の言い方
//   F6 印字する議長専用コマンドに BDBOARD_MERGER=chair を前置する / F7 success 行を追記できたときだけ L の記録を消す
// 一時リポジトリ + 偽の gh / bd / npm の harness は merge-pr.test-support.mjs と共有する。
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { lightSlipSteps, mainBrokenSlotHeldSteps } from './merge-pr/messages.mjs';
import { audit } from './merge-pr/state.mjs';
import {
  advanceMain,
  auditText,
  base,
  calls,
  git,
  landSquash,
  mainCheckout,
  PR,
  readFake,
  readState,
  registerTempRepoHooks,
  run,
  setup,
  simulateMerge,
  stateFile,
  status,
  tmp,
  work,
  writeFake,
} from './merge-pr.test-support.mjs';

const S3 = { mode: 'S3', lightCheck: 'node verify.cjs --light' };
const LONG = 'a'.repeat(40);
const green = (sha) => writeFake({ statuses: { ...readFake().statuses, [sha]: [status('success')] } });
const ledgerOf = (sha, row) => writeFake({ statuses: { ...readFake().statuses, [sha]: [row] } });
const short = (sha) => sha.slice(0, 12);

/** parent の上に 1 コミットを作る (他の PR・修復の着地の代役。push しない — verify の最中に動かすときはこれだけ使う)。 */
function commitOnTop(parent, message) {
  return git(work, ['commit-tree', `${parent}^{tree}`, '-p', parent, '-m', message]);
}
/** commitOnTop して origin/main をそこへ進める。 */
function landOnTop(parent, message) {
  const next = commitOnTop(parent, message);
  git(work, ['push', '-q', 'origin', `${next}:refs/heads/main`]);
  return next;
}

/** repro A の (1)(2): finish が error で終わり (状態は残る)、手動 verify が failure を台帳に書く (印も枠も付けない)。 */
function failedLandingAfterError() {
  setup();
  expect(run(['prepare', String(PR)]).status).toBe(0);
  expect(run(['gate', String(PR)]).status).toBe(0);
  const landed = simulateMerge();
  expect(run(['finish', String(PR)], { FAKE_VERIFY_EXIT: '75' }).status).toBe(1);
  expect(run(['verify', landed], { FAKE_VERIFY_EXIT: '1' }).status).toBe(6);
  expect(readFake().slot.holder).toBeNull();
  return landed;
}

/** S3 のクラス L を gate まで進めて着地させる (finish はまだ)。 */
function landClassL() {
  setup({ merge: S3 });
  const moved = advanceMain({ 'peer.txt': 'peer\n' });
  expect(run(['prepare', String(PR)]).status).toBe(0);
  green(moved);
  expect(run(['gate', String(PR)]).status).toBe(0);
  return landSquash();
}

describe.skipIf(process.platform === 'win32')('merge-pr: landed failure after main moved on (bdboard-89jv)', { timeout: 60_000 }, () => {
  registerTempRepoHooks();

  it('F1 repro A: finish re-run after a repair landed and the tip is green does not take the old SHA main-broken slot', () => {
    const landed = failedLandingAfterError();
    const acquires = calls('bd', 'acquire').length; // gate の 1 回
    const repair = landOnTop(landed, 'fix(demo-2): repair');
    green(repair);
    const retried = run(['finish', String(PR)], { FAKE_VERIFY_EXIT: '1' });
    expect(retried.status).toBe(6);
    expect(calls('bd', 'acquire')).toHaveLength(acquires);
    expect(readFake().slot.holder).toBeNull();
    expect(retried.stderr).toContain(`origin/main は既に ${short(repair)} まで進んでいます`);
    expect(retried.stderr).toContain('main は壊れていません');
    expect(retried.stderr).toContain(`${short(landed)} の main-broken の枠は取りません`);
    expect(retried.stderr).not.toContain('この上にマージしません');
    expect(auditText()).toMatch(new RegExp(`\\tfinish-main-moved-on\\t.*landed=${landed}\\ttip=${repair}`));
    expect(existsSync(stateFile())).toBe(false);
  });

  it('F1 no regression: while the landed commit is still the tip, the finish re-run takes main-broken as before', () => {
    const landed = failedLandingAfterError();
    const acquires = calls('bd', 'acquire').length;
    const retried = run(['finish', String(PR)], { FAKE_VERIFY_EXIT: '1' });
    expect(retried.status).toBe(6);
    expect(calls('bd', 'acquire')).toHaveLength(acquires + 1);
    expect(readFake().slot.holder).toBe(`demo-1 / main-broken ${short(landed)}`);
    expect(retried.stderr).toContain('この上にマージしません');
    expect(retried.stderr).not.toContain('既に');
    expect(auditText()).not.toContain('finish-main-moved-on');
  });

  it('F1: main moving while the landed verify runs is seen (the tip is read again after the verify, not before)', () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR)]).status).toBe(0);
    const landed = simulateMerge();
    const next = commitOnTop(landed, 'feat(peer): landed during the verify');
    green(next);
    // 偽の verify が、検証の最中に next を origin/main へ push する (finish の最初の fetch の時点ではまだ landed が先頭)。
    const finished = run(['finish', String(PR)], { FAKE_VERIFY_EXIT: '1', FAKE_VERIFY_MOVE_MAIN: next });
    expect(finished.status).toBe(6);
    expect(calls('bd', 'acquire')).toHaveLength(1); // gate の 1 回だけ
    expect(readFake().slot.holder).toBeNull();
    expect(finished.stderr).toContain(`origin/main は既に ${short(next)} まで進んでいます`);
  });

  it.each([
    {
      ledger: 'none',
      row: null,
      has: (tip) => [`台帳: none`, `BDBOARD_MERGER=chair npm run merge-pr -- verify ${tip}`],
      lacks: ['この上にマージしません'],
    },
    {
      ledger: 'pending',
      row: status('pending'),
      has: (tip) => [`台帳: pending`, `BDBOARD_MERGER=chair npm run merge-pr -- verify ${tip}`],
      lacks: ['この上にマージしません'],
    },
    {
      ledger: 'failure',
      row: status('failure'),
      has: (tip) => [`先頭 ${short(tip)} の着地後検証も failure`, `main ${short(tip)} の着地後検証`, 'この上にマージしません'],
      lacks: ['台帳:'],
    },
  ])('F1: a moved tip whose ledger is $ledger still takes no old-SHA slot; only the advice differs', ({ row, has, lacks }) => {
    const landed = failedLandingAfterError();
    const acquires = calls('bd', 'acquire').length;
    const repair = landOnTop(landed, 'fix(demo-2): repair');
    if (row !== null) {
      ledgerOf(repair, row);
    }
    const retried = run(['finish', String(PR)], { FAKE_VERIFY_EXIT: '1' });
    expect(retried.status).toBe(6);
    expect(calls('bd', 'acquire')).toHaveLength(acquires);
    expect(readFake().slot.holder).toBeNull();
    for (const text of has(repair)) {
      expect(retried.stderr).toContain(text);
    }
    for (const text of lacks) {
      expect(retried.stderr).not.toContain(text);
    }
  });

  it('F1 late recovery finish: after the merger crashed and others landed on top, a failing verify of the old SHA takes no slot', () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR)]).status).toBe(0);
    const landed = simulateMerge();
    const next = landOnTop(landed, 'feat(peer): meanwhile');
    green(next);
    const retried = run(['finish', String(PR)], { FAKE_VERIFY_EXIT: '1' });
    expect(retried.status).toBe(6);
    expect(calls('bd', 'acquire')).toHaveLength(1);
    expect(readFake().slot.holder).toBeNull();
    expect(retried.stderr).toContain(`既に ${short(next)} まで進んでいます`);
  });

  it('F1 class L: with main moved on, the slip is still reported and the L record kept, but no slot is taken', () => {
    const landed = landClassL();
    const next = landOnTop(landed, 'feat(peer): meanwhile');
    green(next);
    const finished = run(['finish', String(PR)], { FAKE_VERIFY_EXIT: '1' });
    expect(finished.status).toBe(6);
    expect(calls('bd', 'acquire')).toHaveLength(1);
    expect(readFake().slot.holder).toBeNull();
    expect(finished.stderr).toContain('S3 のすり抜け');
    expect(finished.stderr).toContain(`既に ${short(next)} まで進んでいます`);
    expect(readState()).toMatchObject({ class: 'L', newMain: landed, landedResult: 'failure' });
  });

  it('F2/F5: mainBrokenSlotHeldSteps quotes an apostrophe in the holder and names the slot by SHA, not by who took it', () => {
    const quoted = mainBrokenSlotHeldSteps(LONG, "o'brien / main-broken abcdef123456");
    expect(quoted[1]).toContain("--holder 'o'\\''brien / main-broken abcdef123456'");
    const plain = mainBrokenSlotHeldSteps(LONG, 'demo-1 / main-broken abc');
    expect(plain[1]).toContain("--holder 'demo-1 / main-broken abc'");
    expect(plain[0]).toContain('この SHA の枠は、finish が failure のときに取ったもの・gate --repair が引き継いだもの・手で取ったもののどれでもありえ');
    expect(plain[0]).not.toContain('は finish が failure のときに取った main-broken の枠で');
    const slip = lightSlipSteps(LONG)[1];
    expect(slip).toContain('success でも、この SHA の main-broken 枠');
    expect(slip).not.toContain('success なら finish が取った main-broken の枠が残る');
  });

  it('F2: the release failure line (slot.mjs) quotes an apostrophe in the holder', () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR)]).status).toBe(0);
    // finish の最初の release は state.holder を使う。偽の枠は demo-1 / PR#7 が持っているので、別の名前の release は断られる。
    writeFileSync(stateFile(), JSON.stringify({ ...readState(), holder: "o'brien" }));
    simulateMerge();
    const finished = run(['finish', String(PR)]);
    expect(finished.stderr).toContain("手で返してください: bd merge-slot release --holder 'o'\\''brien'");
  });

  it('F2: the repair-finish error guidance (finish.mjs) quotes an apostrophe in the holder', () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR)]).status).toBe(0);
    writeFileSync(stateFile(), JSON.stringify({ ...readState(), repair: true, holder: "o'brien / main-broken abc" }));
    simulateMerge();
    const finished = run(['finish', String(PR)], { FAKE_VERIFY_EXIT: '75' });
    expect(finished.status).toBe(1);
    expect(finished.stderr).toContain("success を確かめたら: bd merge-slot release --holder 'o'\\''brien / main-broken abc'");
  });

  it('F4: a successful manual verify says to check the slot by hand only when bd merge-slot check itself fails', () => {
    setup();
    writeFake({ slot: { holder: null, broken: true } }); // 偽の bd が merge-slot check で落ちる
    const unreadable = run(['verify', base]);
    expect(unreadable.status).toBe(0);
    expect(unreadable.stderr).toContain(`${short(base)} の main-broken 枠が残っていないか確かめられませんでした (bd merge-slot check に失敗`);
    expect(unreadable.stderr).toContain('手で bd merge-slot check を実行し');

    setup();
    const empty = run(['verify', base]);
    expect(empty.status).toBe(0);
    expect(empty.stderr).not.toContain('main-broken 枠が残っていないか');
    expect(empty.stderr).not.toContain('main-broken 枠 (');

    setup();
    writeFake({ slot: { holder: `demo-1 / main-broken ${short(base)}` } });
    const held = run(['verify', base]);
    expect(held.status).toBe(0);
    expect(held.stderr).toContain(`${short(base)} の main-broken 枠 (demo-1 / main-broken ${short(base)}) が残っています`);
    expect(held.stderr).not.toContain('main-broken 枠が残っていないか');
  });

  it('F6: every printed verify / finish / gate command carries BDBOARD_MERGER=chair', () => {
    const bare = (text) => text.match(/(?<!BDBOARD_MERGER=chair )npm run (?:-s )?merge-pr -- (?:verify|finish|gate)\b/g) ?? [];
    const prefixed = 'BDBOARD_MERGER=chair npm run merge-pr -- verify';

    // finish が error (L): finish の案内と light-landed の案内。続く手動 verify の failure はすり抜けの案内 (lightSlipSteps)。
    const landed = landClassL();
    const errored = run(['finish', String(PR)], { FAKE_VERIFY_EXIT: '75' });
    expect(errored.status).toBe(1);
    expect(errored.stderr).toContain(`原因を直して ${prefixed}`);
    expect(errored.stderr).toContain(`直して ${prefixed} ${landed}`);
    expect(bare(errored.stderr)).toEqual([]);
    const slip = run(['verify', landed], { FAKE_VERIFY_EXIT: '1' });
    expect(slip.status).toBe(6);
    expect(slip.stderr).toContain(`そうなら壊れていないので ${prefixed} ${landed}`);
    expect(bare(slip.stderr)).toEqual([]);

    // L の failure を残した記録に対する finish のやり直し拒否 (keptLightFailureSteps)。
    const keptLanded = landClassL();
    expect(run(['finish', String(PR)], { FAKE_VERIFY_EXIT: '1' }).status).toBe(6);
    const refused = run(['finish', String(PR)]);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain(`${prefixed} ${keptLanded}`);
    expect(bare(refused.stderr)).toEqual([]);

    // main checkout からの verify の拒否 (landed-verify.mjs)。
    const fromMain = run(['verify', base], {}, mainCheckout);
    expect(fromMain.status).toBe(1);
    expect(fromMain.stderr).toContain(`${prefixed} ${base}`);
    expect(bare(fromMain.stderr)).toEqual([]);

    // 将来の印字の抜けを固定する: ソース (コメント行を除く) に前置きの無い議長専用コマンドが無い。
    const dir = new URL('./merge-pr/', import.meta.url);
    for (const name of readdirSync(dir).filter((entry) => entry.endsWith('.mjs'))) {
      const code = readFileSync(new URL(name, dir), 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join('\n');
      expect(bare(code), name).toEqual([]);
    }
  });

  it('F7: audit() says whether the line was appended, and never throws', () => {
    setup();
    vi.stubEnv('BDBOARD_MERGE_AUDIT_LOG', path.join(tmp, 'audit-here.log'));
    try {
      expect(audit('test-event', { a: 1 })).toBe(true);
      expect(readFileSync(path.join(tmp, 'audit-here.log'), 'utf8')).toContain('\ttest-event\ta=1');
      vi.stubEnv('BDBOARD_MERGE_AUDIT_LOG', path.join(tmp, 'no-such-dir', 'audit.log'));
      expect(audit('test-event', {})).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('F7: the class-L failure record is kept when the success line cannot be appended, then removed once it is', () => {
    const landed = landClassL();
    expect(run(['finish', String(PR)], { FAKE_VERIFY_EXIT: '1' }).status).toBe(6);
    const unwritable = path.join(tmp, 'no-such-dir', 'audit.log');
    const first = run(['verify', landed], { BDBOARD_MERGE_AUDIT_LOG: unwritable });
    expect(first.status).toBe(0); // 再検証そのものは success
    expect(existsSync(stateFile())).toBe(true);
    expect(readState()).toMatchObject({ class: 'L', newMain: landed, landedResult: 'failure' });
    expect(first.stderr).toContain('light-landed の success 行を追記できなかった');
    expect(first.stderr).toContain('監査ログを直して');
    expect(first.stderr).toContain(`BDBOARD_MERGER=chair npm run merge-pr -- verify ${landed}`);

    const second = run(['verify', landed]);
    expect(second.status).toBe(0);
    expect(existsSync(stateFile())).toBe(false);
    expect(auditText()).toMatch(new RegExp(`\\tlight-landed\\tpr=7\\tid=demo-1\\tnew=${landed}\\tresult=success\\tby=manual`));
    expect(second.stderr).not.toContain('追記できなかった');
  });
});
