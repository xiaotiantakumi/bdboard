import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { bdGateListItemSchema } from './bd-cli-human-decisions.js';
import { bdInProgressItemSchema } from './bd-cli-lease-reader.js';
import { bdMergeSlotItemSchema } from './bd-cli-merge-slot-reader.js';

// e2e 専用の bd fixture (test/e2e/fixtures/bd/*.json) が、それを実際に読む本番 reader の
// zod スキーマを満たすことを unit test 段階で固定する (bdboard-0rch)。
// 背景: PR #428 でスキーマに必須フィールドを足したとき lease.in-progress.json が
// そのフィールドを持たず、npm run verify は通るのに CI の e2e だけが落ちた。
// fixture は偽 bd (test/e2e/fixtures/bin/bd) が返す。本番 reader の parse の仕方は 3 者で違う:
//   - gate list  : 要素ごとに safeParse し、合わない要素だけ黙って捨てる (e2e では確認待ちが消える)
//   - lease      : 要素ごとに safeParse し、1 件でも合わなければ BdError
//   - merge-slot : 先頭要素だけ safeParse し、合わなければ BdError
// ここでは挙動の差によらず全要素を検査する (merge-slot は本番より厳しいが無害)。
// 対象外: スキーマは通るが reader / domain が捨てる値 (gate の await_type、lease の失効判定、
// merge-slot の updated_at のパース可否) と、ゴールデン test/fixtures/bd/bdboard.list.json を
// human list として読む組み合わせ。これらは bdboard-0rch から discovered-from で切った
// フォローアップチケットで扱う。

const e2eBdFixturesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../test/e2e/fixtures/bd',
);

interface FixtureContract {
  readonly file: string;
  /** 偽 bd がこの fixture を返すコマンド形 (test/e2e/fixtures/bin/bd 参照)。 */
  readonly command: string;
  /** その出力を読む本番 reader が各要素に適用するスキーマ。 */
  readonly schema: z.AnyZodObject;
}

// fixture ファイル → 本番スキーマの対応表。fixture を増やしたらここに行を足す
// (足さないと下の網羅性テストが落ちる)。
const contracts: readonly FixtureContract[] = [
  {
    file: 'gate.list.json',
    command: 'bd gate list --json (BdCliHumanDecisions)',
    schema: bdGateListItemSchema,
  },
  {
    file: 'lease.in-progress.json',
    command: 'bd list --status in_progress --json (BdCliLeaseReader)',
    schema: bdInProgressItemSchema,
  },
  {
    file: 'merge-slot.list.json',
    command: 'bd list --label gt:slot --json (BdCliMergeSlotReader)',
    schema: bdMergeSlotItemSchema,
  },
];

function readFixtureItems(file: string): unknown[] {
  const raw = readFileSync(path.join(e2eBdFixturesDir, file), 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`${file} must be a JSON array (bd --json list output)`);
  }
  return parsed;
}

// スキーマの shape から必須キー (optional でないもの) を導く。表に手で書くと
// スキーマ側の必須化に追従し損ねるので、本番スキーマそのものから取る。
function requiredKeys(schema: z.AnyZodObject): string[] {
  return Object.entries(schema.shape as Record<string, z.ZodTypeAny>)
    .filter(([, fieldSchema]) => !fieldSchema.isOptional())
    .map(([key]) => key)
    .sort();
}

describe('e2e bd fixtures satisfy the production zod schemas', () => {
  it('every fixture under test/e2e/fixtures/bd has a row in the contract table', () => {
    const onDisk = readdirSync(e2eBdFixturesDir)
      .filter((name) => name.endsWith('.json'))
      .sort();
    expect(onDisk).toEqual(contracts.map((c) => c.file).sort());
  });

  describe.each(contracts)('$file ← $command', ({ file, schema }) => {
    it('is a non-empty array whose every item parses', () => {
      const items = readFixtureItems(file);
      expect(items.length).toBeGreaterThan(0);
      items.forEach((item, index) => {
        const result = schema.safeParse(item);
        expect(
          result.success,
          `${file}[${index}] does not match the production schema: ${
            result.success ? '' : JSON.stringify(result.error.issues)
          }`,
        ).toBe(true);
      });
    });

    // 対照実験: 必須キーを 1 つ抜いた要素をスキーマが本当に弾くことを確かめ、上のテストが
    // 「何でも通すスキーマ」で緑になっていないことを保証する (fixture 自体の検査ではない)。
    // ネストしたオブジェクト内の欠損は上の「全要素が parse できる」テストが捕まえる。
    it('is rejected when any required field is missing', () => {
      const keys = requiredKeys(schema);
      // 必須キーが 1 つも無いと下のループが空回りして何も検証しなくなる。
      expect(
        keys.length,
        `${file}: schema has no required keys, so this negative control is meaningless; revisit the contract`,
      ).toBeGreaterThan(0);
      const [first] = readFixtureItems(file);
      expect(first).toBeTypeOf('object');
      for (const key of keys) {
        const mutated: Record<string, unknown> = { ...(first as Record<string, unknown>) };
        // 配列で渡す: 文字列だと "a.b" のようなキーがネストのパスとして解釈される。
        expect(mutated, `${file}[0] lacks required field "${key}"`).toHaveProperty([key]);
        delete mutated[key];
        expect(
          schema.safeParse(mutated).success,
          `${file}[0] without "${key}" should be rejected`,
        ).toBe(false);
      }
    });
  });
});
