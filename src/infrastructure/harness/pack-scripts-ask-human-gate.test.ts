import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandResult } from '../../application/ports/command-runner.js';
import { NodeCommandRunner } from '../process/node-command-runner.js';

/**
 * bdboard-harness パックの scripts/ask-human-gate.py の統合テスト (bdboard-7yfj.2)。
 *
 * 本物の bd は呼ばない。PATH の先頭に「引数を 1 行 JSON で記録し、gate create には固定の
 * id を返す」stub を置き、呼び出しの順序・本文の見出し・スキーマ違反時の未呼び出しを見る。
 */

const PACKS_ROOT = fileURLToPath(new URL('../../../harness/packs/', import.meta.url));
const SCRIPT = path.join(PACKS_ROOT, 'bdboard-harness', 'scripts', 'ask-human-gate.py');

const runner = new NodeCommandRunner();

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
  'bdboard-harness scripts/ask-human-gate.py',
  () => {
    let tmpRoot: string;
    let env: Record<string, string>;
    let callsLog: string;
    let base: Record<string, unknown>;

    beforeEach(() => {
      tmpRoot = mkdtempSync(path.join(tmpdir(), 'bdboard-ask-gate-'));
      const binDir = path.join(tmpRoot, 'bin');
      mkdirSync(binDir, { recursive: true });
      callsLog = path.join(tmpRoot, 'calls.jsonl');
      writeFileSync(callsLog, '', 'utf8');
      mkdirSync(path.join(tmpRoot, 'wt'), { recursive: true });
      writeFileSync(path.join(tmpRoot, 'shot.png'), 'x', 'utf8');
      writeFileSync(path.join(tmpRoot, 'empty.png'), '', 'utf8');
      const stub = path.join(binDir, 'bd');
      writeFileSync(
        stub,
        [
          '#!/usr/bin/env python3',
          'import json, sys',
          'a = sys.argv[1:]',
          `open(${JSON.stringify(callsLog)}, "a").write(json.dumps(a) + "\\n")`,
          'if a[:2] == ["gate", "create"]:',
          '    print(json.dumps({"id": "proj-gate1"}))',
          '',
        ].join('\n'),
        'utf8',
      );
      chmodSync(stub, 0o755);
      env = {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? '/usr/bin:/bin'}`,
        HOME: tmpRoot,
      };
      base = {
        ticket: 'proj-work1',
        decision: 'キャッシュは Redis と SQLite のどちらにしますか。',
        background: '一覧 API が遅い。\n関連: proj-slow2。',
        options: [
          { label: 'A: Redis', consequence: '速いが常駐プロセスが増える' },
          { label: 'B: SQLite', consequence: '追加の常駐は無いが書き込みが直列' },
        ],
        recommend: { choice: 'B: SQLite', reason: '運用が単純' },
        resume: { worktree: 'wt', steps: ['A なら redis 版を実装', 'B なら sqlite 版を実装'] },
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

    it('creates the gate, writes the description, comments, labels; last stdout line is the gate id', async () => {
      const r = await run(['--spec', writeSpec(base)]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim().split('\n').pop()).toBe('proj-gate1');
      const c = calls();
      expect(c.map((x) => x.slice(0, 2).join(' '))).toEqual([
        'gate create',
        'update proj-gate1',
        'comment proj-work1',
        'label add',
      ]);
      expect(c[0]).toEqual([
        'gate',
        'create',
        '--type=human',
        '--blocks',
        'proj-work1',
        '--title',
        'Gate: キャッシュは Redis と SQLite のどちらにしますか。',
        '--json',
      ]);
      expect(c[1]?.[2]).toBe('--description');
      const body = c[1]?.[3] ?? '';
      const order = [
        '## 決めてほしいこと',
        '## 背景',
        '## 選択肢',
        '- **A: Redis** — 帰結: 速いが常駐プロセスが増える',
        '## 推奨',
        'B: SQLite — 運用が単純',
        '## 回答後の再開手順',
        '1. A なら redis 版を実装',
      ];
      let last = -1;
      for (const needle of order) {
        const idx = body.indexOf(needle);
        expect(idx, needle).toBeGreaterThan(last);
        last = idx;
      }
      expect(body).not.toContain('## 視覚的な確認');
      expect(c[2]).toEqual([
        'comment',
        'proj-work1',
        '質問は gate proj-gate1 を参照（bd show proj-gate1）',
      ]);
      expect(c[3]).toEqual(['label', 'add', 'proj-work1', 'human']);
    });

    it('--review-after sets bdboard.review_after on the work ticket and never uses dep add', async () => {
      const r = await run(['--spec', writeSpec(base), '--review-after', 'proj-first']);
      expect(r.exitCode).toBe(0);
      const c = calls();
      expect(c[c.length - 1]).toEqual([
        'update',
        'proj-work1',
        '--set-metadata',
        'bdboard.review_after=proj-first',
      ]);
      expect(c.map((x) => x[0])).not.toContain('dep');
    });

    it('--dry-run prints the body only and does not call bd', async () => {
      const r = await run(['--spec', writeSpec(base), '--dry-run']);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('## 選択肢');
      expect(calls()).toHaveLength(0);
    });

    it('renders the visual section and "no recommendation" when asked', async () => {
      const r = await run([
        '--spec',
        writeSpec({
          ...base,
          recommend: { choice: 'none', reason: '判断材料が拮抗している' },
          visual: { screenshots: ['shot.png'], preview_url: 'http://localhost:9000/x' },
        }),
        '--dry-run',
      ]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('## 視覚的な確認');
      expect(r.stdout).toContain('- shot.png');
      expect(r.stdout).toContain('http://localhost:9000/x');
      expect(r.stdout).toContain('推奨なし — 判断材料が拮抗している');
    });

    it('truncates a long first line of decision in the title', async () => {
      const long = `${'あ'.repeat(120)}？`;
      const r = await run(['--spec', writeSpec({ ...base, decision: long })]);
      expect(r.exitCode).toBe(0);
      const title = calls()[0]?.[6] ?? '';
      expect(title.startsWith('Gate: ')).toBe(true);
      expect(title.length).toBeLessThanOrEqual('Gate: '.length + 80);
    });

    describe('--spec schema validation', () => {
      async function reject(spec: Record<string, unknown>, ...reasons: string[]): Promise<void> {
        const r = await run(['--spec', writeSpec(spec)]);
        expect(r.exitCode).not.toBe(0);
        expect(r.stdout).toBe('');
        for (const reason of reasons) expect(r.stderr).toContain(reason);
        expect(calls()).toHaveLength(0);
      }

      it('rejects missing required keys', async () => {
        const { options: _o, resume: _r, ...rest } = base;
        await reject(rest, 'spec: 必須キー options がありません', 'spec: 必須キー resume がありません');
      });

      it('rejects fewer than 2 options and options without a consequence', async () => {
        await reject(
          { ...base, options: [{ label: 'A', consequence: 'x' }], recommend: { choice: 'none', reason: 'r' } },
          'spec.options: 要素が少なすぎます',
        );
        await reject(
          { ...base, options: [{ label: 'A: Redis' }, { label: 'B: SQLite', consequence: 'x' }] },
          'spec.options[0]: 必須キー consequence がありません',
        );
        await reject(
          { ...base, options: [{ label: 'A: Redis', consequence: '' }, { label: 'B: SQLite', consequence: 'x' }] },
          'spec.options[0].consequence',
        );
      });

      it('rejects duplicate option labels', async () => {
        await reject(
          {
            ...base,
            options: [
              { label: 'B: SQLite', consequence: 'x' },
              { label: 'B: SQLite', consequence: 'y' },
            ],
          },
          'label が重複しています',
        );
      });

      it('requires recommend; none needs a reason; choice must be an option label', async () => {
        const { recommend: _r, ...noRec } = base;
        await reject(noRec, 'spec: 必須キー recommend がありません');
        await reject({ ...base, recommend: { choice: 'none' } }, 'spec.recommend.reason: choice が none のとき');
        await reject({ ...base, recommend: { choice: 'C: Mongo', reason: 'r' } }, 'spec.recommend.choice');
        const ok = await run(['--spec', writeSpec({ ...base, recommend: { choice: 'none', reason: 'r' } }), '--dry-run']);
        expect(ok.exitCode).toBe(0);
      });

      it('requires an existing worktree directory and at least one resume step', async () => {
        await reject(
          { ...base, resume: { worktree: 'nope', steps: ['x'] } },
          'spec.resume.worktree: ディレクトリが存在しません',
        );
        await reject(
          { ...base, resume: { worktree: 'shot.png', steps: ['x'] } },
          'ディレクトリではありません',
        );
        await reject({ ...base, resume: { worktree: 'wt', steps: [] } }, 'spec.resume.steps: 要素が少なすぎます');
        await reject({ ...base, resume: { steps: ['x'] } }, 'spec.resume: 必須キー worktree がありません');
      });

      it('checks visual screenshots exist and previews are http(s) URLs', async () => {
        await reject({ ...base, visual: { screenshots: ['none.png'] } }, 'spec.visual.screenshots[0]', '存在しません');
        await reject({ ...base, visual: { screenshots: ['empty.png'] } }, '空です');
        await reject({ ...base, visual: { preview_url: 'ftp://x' } }, 'spec.visual.preview_url');
        await reject({ ...base, visual: {} }, 'spec.visual: キーが 1 つもありません');
      });

      it('rejects unknown keys, wrong types and bad ticket ids, one reason per violation', async () => {
        await reject({ ...base, extra: 1 }, 'spec.extra: 未知のキー');
        await reject({ ...base, decision: 3 }, 'spec.decision: string である必要');
        await reject({ ...base, ticket: 'bad id' }, 'spec.ticket');
        const r = await run([
          '--spec',
          writeSpec({ ...base, ticket: '', decision: '', bogus: 1 }),
          '--dry-run',
        ]);
        expect(r.exitCode).not.toBe(0);
        const errs = r.stderr.split('\n').filter((l) => l.startsWith('ERROR: spec'));
        expect(errs.length).toBeGreaterThanOrEqual(3);
      });

      it('rejects a decision over 3 lines', async () => {
        await reject({ ...base, decision: 'a\nb\nc\nd' }, 'spec.decision');
      });

      it('does not call bd on an invalid spec even in non-dry-run mode', async () => {
        const r = await run(['--spec', writeSpec({ ...base, options: [] }), '--review-after', 'proj-x']);
        expect(r.exitCode).not.toBe(0);
        expect(calls()).toHaveLength(0);
      });

      it('rejects a malformed --review-after before any bd call', async () => {
        const r = await run(['--spec', writeSpec(base), '--review-after', 'a b;c']);
        expect(r.exitCode).not.toBe(0);
        expect(r.stderr).toContain('--review-after');
        expect(calls()).toHaveLength(0);
      });

      it('--help prints the keys generated from the schema file', async () => {
        const r = await run(['--help']);
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toContain('ask-human-gate.schema.json');
        const schema = JSON.parse(
          readFileSync(path.join(path.dirname(SCRIPT), 'ask-human-gate.schema.json'), 'utf8'),
        ) as { properties: Record<string, unknown> };
        for (const key of Object.keys(schema.properties)) expect(r.stdout).toContain(key);
      });
    });
  },
);
