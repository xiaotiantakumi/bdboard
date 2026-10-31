import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandResult } from '../../application/ports/command-runner.js';
import { NodeCommandRunner } from '../process/node-command-runner.js';

/**
 * bdboard-harness パックの scripts/post-review-ticket.py の統合テスト (bdboard-efw5)。
 *
 * 本物の bd は呼ばない。PATH の先頭に「引数を 1 行 JSON で記録し、show には固定の旧本文を
 * 返す」stub を置き、見出しの順番・パスの一度だけ・notes 退避・human ラベルを見る。
 */

const PACKS_ROOT = fileURLToPath(new URL('../../../harness/packs/', import.meta.url));
const SCRIPT = path.join(PACKS_ROOT, 'bdboard-harness', 'scripts', 'post-review-ticket.py');

const runner = new NodeCommandRunner();

const FULL_SPEC = {
  main_video: 'out/main.mp4',
  main_video_label: '3分・8場面',
  fix_videos: ['out/fix.mp4', 'out/fix2.mov'],
  ear_videos: ['out/ear.mp4'],
  points: ['冒頭の字幕', '- 2:10 の読み'],
  decision: 'OK なら OK とコメントしてください。',
  fixed: '| 箇所 | 内容 |\n|---|---|\n| 0:10 | 直した |',
  ear: '- 1:00 疑い',
  materials: ['docs/memo.md'],
  other: '補足',
};

async function pythonAvailable(): Promise<boolean> {
  try {
    const r = await runner.run('python3', ['--version'], { timeoutMs: 5_000 });
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

const HAS_PYTHON = await pythonAvailable();

describe.skipIf(process.platform === 'win32' || !HAS_PYTHON)(
  'bdboard-harness scripts/post-review-ticket.py',
  () => {
    let tmpRoot: string;
    let env: Record<string, string>;
    let callsLog: string;
    let oldDescFile: string;

    beforeEach(() => {
      tmpRoot = mkdtempSync(path.join(tmpdir(), 'bdboard-post-review-'));
      const binDir = path.join(tmpRoot, 'bin');
      mkdirSync(binDir, { recursive: true });
      callsLog = path.join(tmpRoot, 'calls.jsonl');
      oldDescFile = path.join(tmpRoot, 'old-desc.txt');
      writeFileSync(callsLog, '', 'utf8');
      writeFileSync(oldDescFile, '', 'utf8');
      // spec の動画パスは実在して空でないことを検査される (cwd = tmpRoot 基準の相対パス)
      mkdirSync(path.join(tmpRoot, 'out'), { recursive: true });
      for (const f of ['main.mp4', 'fix.mp4', 'fix2.mov', 'ear.mp4']) {
        writeFileSync(path.join(tmpRoot, 'out', f), 'x', 'utf8');
      }
      writeFileSync(path.join(tmpRoot, 'out', 'empty.mp4'), '', 'utf8');
      writeFileSync(path.join(tmpRoot, 'a.mp4'), 'x', 'utf8');
      const stub = path.join(binDir, 'bd');
      writeFileSync(
        stub,
        [
          '#!/usr/bin/env python3',
          'import json, os, sys',
          'a = sys.argv[1:]',
          `open(${JSON.stringify(callsLog)}, "a").write(json.dumps(a) + "\\n")`,
          'if a[0] == "show":',
          `    print(json.dumps([{"id": a[1], "description": open(${JSON.stringify(oldDescFile)}).read()}]))`,
          'elif a[0] == "create":',
          '    print(json.dumps({"id": "proj-new1"}))',
          '',
        ].join('\n'),
        'utf8',
      );
      chmodSync(stub, 0o755);
      env = {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? '/usr/bin:/bin'}`,
        HOME: tmpRoot,
      };
    });

    afterEach(() => {
      rmSync(tmpRoot, { recursive: true, force: true });
    });

    function writeSpec(spec: Record<string, unknown>): string {
      const p = path.join(tmpRoot, 'spec.json');
      writeFileSync(p, JSON.stringify(spec), 'utf8');
      return p;
    }

    function run(args: readonly string[]): Promise<CommandResult> {
      return runner.run('python3', [SCRIPT, ...args], {
        cwd: tmpRoot,
        env,
        timeoutMs: 20_000,
      });
    }

    function calls(): string[][] {
      return readFileSync(callsLog, 'utf8')
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as string[]);
    }

    it('orders headings and omits empty sections; main video path appears once', async () => {
      const r = await run(['--spec', writeSpec(FULL_SPEC), '--date', '2026-10-31', '--dry-run']);
      expect(r.exitCode).toBe(0);
      const out = r.stdout;
      const order = [
        '## 今回見てほしいもの（2026-10-31）',
        '通しの動画（3分・8場面）',
        '直した箇所の確認動画',
        '耳で確かめる確認動画',
        '見るポイント',
        '判断してほしいこと',
        '## 直したところ',
        '## 耳で聞いてほしいところ',
        '## 資料',
        '## そのほか',
      ];
      let last = -1;
      for (const needle of order) {
        const idx = out.indexOf(needle);
        expect(idx, needle).toBeGreaterThan(last);
        last = idx;
      }
      expect(out.split('out/main.mp4').length - 1).toBe(1);
      expect(out).toContain('docs/memo.md');

      const small = await run([
        '--spec',
        writeSpec({
          main_video: 'a.mp4',
          points: ['見る'],
          decision: 'OK ですか。',
        }),
        '--dry-run',
      ]);
      expect(small.stdout).toContain('通しの動画');
      expect(small.stdout).not.toContain('## 直したところ');
      expect(small.stdout).not.toContain('## 資料');
      expect(small.stdout).toContain('判断してほしいこと');
    });

    it('creates a ticket with the human label', async () => {
      const r = await run(['--spec', writeSpec(FULL_SPEC), '--title', 'T', '--date', '2026-10-31']);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('proj-new1');
      const c = calls();
      expect(c).toHaveLength(1);
      expect(c[0]?.[0]).toBe('create');
      expect(c[0]).toContain('human');
      expect(c[0]).toContain('--description');
    });

    it('updates: moves old summary to --append-notes first, then replaces description', async () => {
      writeFileSync(
        oldDescFile,
        '## 今回見てほしいもの（2026-10-30）\n\n旧の動画\n\n見るポイント\n\n- 旧ポイント\n',
        'utf8',
      );
      const r = await run([
        '--spec',
        writeSpec(FULL_SPEC),
        '--ticket',
        'proj-1',
        '--date',
        '2026-10-31',
      ]);
      expect(r.exitCode).toBe(0);
      const c = calls();
      expect(c.map((x) => x[0])).toEqual(['show', 'update', 'update']);
      expect(c[1]).toContain('--append-notes');
      expect(c[1]?.some((x) => x.startsWith('2026-10-31: '))).toBe(true);
      expect(c[2]).toContain('--description');
      expect(c.flat()).not.toContain('--notes');
    });

    it('does not add notes when the old description is empty or identical', async () => {
      const spec = writeSpec(FULL_SPEC);
      const empty = await run(['--spec', spec, '--ticket', 'proj-1', '--date', '2026-10-31']);
      expect(empty.exitCode).toBe(0);
      expect(calls().flat()).not.toContain('--append-notes');

      const body = await run(['--spec', spec, '--date', '2026-10-31', '--dry-run']);
      writeFileSync(oldDescFile, body.stdout, 'utf8');
      writeFileSync(callsLog, '', 'utf8');
      const same = await run(['--spec', spec, '--ticket', 'proj-1', '--date', '2026-10-31']);
      expect(same.exitCode).toBe(0);
      expect(calls().flat()).not.toContain('--append-notes');
    });

    describe('--spec schema validation', () => {
      const base = {
        main_video: 'a.mp4',
        points: ['見る'],
        decision: 'OK ですか。',
      };

      async function reject(spec: Record<string, unknown>, ...reasons: string[]): Promise<void> {
        const r = await run(['--spec', writeSpec(spec), '--dry-run']);
        expect(r.exitCode).not.toBe(0);
        expect(r.stdout).toBe('');
        for (const reason of reasons) expect(r.stderr).toContain(reason);
        expect(calls()).toHaveLength(0);
      }

      it('accepts a minimal valid spec', async () => {
        const r = await run(['--spec', writeSpec(base), '--dry-run']);
        expect(r.exitCode).toBe(0);
      });

      it('rejects missing, empty, wrong-extension and directory video paths', async () => {
        await reject({ ...base, main_video: 'out/none.mp4' }, 'spec.main_video', '存在しません');
        await reject({ ...base, main_video: 'out/empty.mp4' }, '空です');
        await reject({ ...base, main_video: 'out/main.mp4.txt' }, '形式が合いません');
        await reject({ ...base, main_video: '' }, 'spec.main_video');
      });

      it('accepts an absolute video path', async () => {
        const abs = path.join(tmpRoot, 'out', 'main.mp4');
        const r = await run(['--spec', writeSpec({ ...base, main_video: abs }), '--dry-run']);
        expect(r.exitCode).toBe(0);
      });

      it('requires points and decision when any video is given', async () => {
        await reject(
          { main_video: 'a.mp4' },
          'main_video があるとき points も必須',
          'decision も必須',
        );
        await reject({ ...base, ear_videos: ['out/ear.mp4'] }, 'ear_videos があるとき ear も必須');
        await reject(
          { ...base, fix_videos: ['out/fix.mp4'] },
          'fix_videos があるとき fixed も必須',
        );
        await reject(
          { fix_videos: ['out/fix.mp4'], fixed: 'x' },
          'fix_videos があるとき points も必須',
          'decision も必須',
        );
      });

      it('requires main_video for main_video_label', async () => {
        await reject(
          { points: ['見る'], decision: 'd', main_video_label: 'x' },
          'main_video_label があるとき main_video も必須',
        );
      });

      it('validates points: non-empty array of single short sentences', async () => {
        await reject({ ...base, points: [] }, '要素が少なすぎます');
        await reject({ ...base, points: 'text' }, 'array である必要');
        await reject(
          { ...base, points: ['一つ目。二つ目。'] },
          'spec.points[0]',
          '形式が合いません',
        );
        await reject({ ...base, points: ['a\nb'] }, 'spec.points[0]');
        await reject({ ...base, points: ['あ'.repeat(81)] }, '長すぎます');
        await reject({ ...base, points: ['  '] }, 'spec.points[0]');
      });

      it('rejects main_video repeated in other fields', async () => {
        await reject({ ...base, materials: ['a.mp4'] }, 'spec.materials', '重複');
        await reject({ ...base, fix_videos: ['a.mp4'], fixed: 'x' }, 'spec.fix_videos', '重複');
        await reject({ ...base, other: '動画は a.mp4 です' }, 'spec.other', '重複');
      });

      it('caps line counts so suspect lists cannot be pasted whole', async () => {
        const lines = (n: number) => Array.from({ length: n }, (_, i) => `- ${i}`).join('\n');
        await reject(
          { ...base, ear_videos: ['out/ear.mp4'], ear: lines(21) },
          'spec.ear',
          '形式が合いません',
        );
        await reject({ ...base, other: lines(21) }, 'spec.other');
        await reject({ ...base, decision: lines(6) }, 'spec.decision');
        const ok = await run(['--spec', writeSpec({ ...base, other: lines(20) }), '--dry-run']);
        expect(ok.exitCode).toBe(0);
      });

      it('rejects unknown keys, wrong types and empty specs, one reason per violation', async () => {
        await reject({ ...base, video: 'x.mp4' }, 'spec.video: 未知のキー');
        await reject({ ...base, decision: 3 }, 'spec.decision: string である必要');
        await reject({}, 'キーが 1 つもありません');
        const r = await run([
          '--spec',
          writeSpec({ main_video: 'out/none.mp4', bogus: 1 }),
          '--dry-run',
        ]);
        expect(r.exitCode).not.toBe(0);
        const errs = r.stderr.split('\n').filter((l) => l.startsWith('ERROR: spec'));
        expect(errs.length).toBeGreaterThanOrEqual(4);
      });

      it('does not call bd when the spec is invalid (create and update)', async () => {
        const bad = writeSpec({ main_video: 'out/none.mp4' });
        const c = await run(['--spec', bad, '--title', 'T']);
        const u = await run(['--spec', bad, '--ticket', 'proj-1']);
        expect(c.exitCode).not.toBe(0);
        expect(u.exitCode).not.toBe(0);
        expect(calls()).toHaveLength(0);
      });

      it('--help prints the keys generated from the schema file', async () => {
        const r = await run(['--help']);
        expect(r.exitCode).toBe(0);
        for (const key of [
          'main_video',
          'fix_videos',
          'ear_videos',
          'points',
          'decision',
          'post-review-ticket.schema.json',
        ]) {
          expect(r.stdout).toContain(key);
        }
        const schema = JSON.parse(
          readFileSync(path.join(path.dirname(SCRIPT), 'post-review-ticket.schema.json'), 'utf8'),
        ) as { properties: Record<string, unknown> };
        for (const key of Object.keys(schema.properties)) expect(r.stdout).toContain(key);
      });
    });
  },
);
