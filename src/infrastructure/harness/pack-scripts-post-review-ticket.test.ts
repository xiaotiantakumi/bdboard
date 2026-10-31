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
  fix_videos: ['out/fix.mp4', 'out/fix.md'],
  ear_videos: ['out/ear.mp4'],
  points: ['冒頭の字幕', '- 2:10 の読み'],
  decision: 'OK なら OK とコメントしてください。',
  fixed: '| 箇所 | 内容 |\n|---|---|\n| 0:10 | 直した |',
  ear: '- 1:00 疑い',
  materials: ['out/main.mp4', 'docs/memo.md'],
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
      return runner.run('python3', [SCRIPT, ...args], { cwd: tmpRoot, env, timeoutMs: 20_000 });
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

      const small = await run(['--spec', writeSpec({ main_video: 'a.mp4' }), '--dry-run']);
      expect(small.stdout).toContain('通しの動画');
      expect(small.stdout).not.toContain('## 直したところ');
      expect(small.stdout).not.toContain('## 資料');
      expect(small.stdout).not.toContain('判断してほしいこと');
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
      writeFileSync(oldDescFile, '## 今回見てほしいもの（2026-10-30）\n\n旧の動画\n\n見るポイント\n\n- 旧ポイント\n', 'utf8');
      const r = await run(['--spec', writeSpec(FULL_SPEC), '--ticket', 'proj-1', '--date', '2026-10-31']);
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
  },
);
