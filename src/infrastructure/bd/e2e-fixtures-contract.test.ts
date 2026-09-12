import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { CommandRunner } from '../../application/ports/command-runner.js';
import { detectStaleLeases } from '../../domain/lease.js';
import { evaluateMergeSlotStatus } from '../../domain/merge-slot.js';
import {
  bdGateListItemSchema,
  createBdCliHumanDecisions,
} from './bd-cli-human-decisions.js';
import {
  bdInProgressItemSchema,
  createBdCliLeaseReader,
} from './bd-cli-lease-reader.js';
import {
  bdMergeSlotItemSchema,
  createBdCliMergeSlotReader,
} from './bd-cli-merge-slot-reader.js';

// e2e 専用の bd fixture (test/e2e/fixtures/bd/*.json) が、それを実際に読む本番 reader の
// zod スキーマを満たすことを unit test 段階で固定する (bdboard-0rch)。
// 背景: PR #428 でスキーマに必須フィールドを足したとき lease.in-progress.json が
// そのフィールドを持たず、npm run verify は通るのに CI の e2e だけが落ちた。
// fixture は偽 bd (test/e2e/fixtures/bin/bd) が返す。本番 reader の parse の仕方は 3 者で違う:
//   - gate list  : 要素ごとに safeParse し、合わない要素だけ黙って捨てる (e2e では確認待ちが消える)
//   - lease      : 要素ごとに safeParse し、1 件でも合わなければ BdError
//   - merge-slot : 先頭要素だけ safeParse し、合わなければ BdError
// ここでは挙動の差によらず全要素を検査する (merge-slot は本番より厳しいが無害)。
// 加えて下では fixture stdout を本番 reader へ渡し、reader/domain が依存する意味まで検証する。
// human list は e2e fixture ディレクトリ外の共有ゴールデン fixture だが、偽 bd が
// BDBOARD_E2E_BD_HUMAN_LIST_FIXTURE として返すため、対応表と reader 経由の検査に含める。

const e2eBdFixturesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../test/e2e/fixtures/bd',
);
const goldenBdFixturesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../test/fixtures/bd',
);
const ROOT = '/fixture-project';
// e2e は実時計で動くので、ここでは fixture の時刻 (lease 失効 09:55 / merge-slot 更新 09:00) より
// 後で、かつ実際の e2e 実行より必ず前の時刻に固定する。stale lease 判定も merge-slot の保持時間も
// 時間とともに単調に「より stale / より長く保持」側へ進むので、この NOW で成立すれば e2e でも成立する。
const NOW = new Date('2026-08-16T10:00:00Z');
// test/e2e/hygiene-signals.spec.ts が参照する値と同期 (gate / lease / ゴールデン human list で共通の id)。
const FIXTURE_TICKET_ID = 'bdboard-3tw.8';
const MERGE_SLOT_HOLDER = 'e2e-fixture-merge-slot-holder';

interface FixtureContractBase {
  readonly file: string;
  /** 偽 bd がこの fixture を返すコマンド形 (test/e2e/fixtures/bin/bd 参照)。 */
  readonly command: string;
}

interface E2eFixtureContract extends FixtureContractBase {
  readonly directory: 'e2e';
  /** その出力を読む本番 reader が各要素に適用するスキーマ。 */
  readonly schema: z.AnyZodObject;
}

interface GoldenFixtureContract extends FixtureContractBase {
  readonly directory: 'golden';
}

type FixtureContract = E2eFixtureContract | GoldenFixtureContract;

// fixture ファイル → 本番スキーマの対応表。fixture を増やしたらここに行を足す
// (足さないと下の網羅性テストが落ちる)。
const contracts: readonly FixtureContract[] = [
  {
    file: 'gate.list.json',
    directory: 'e2e',
    command: 'bd gate list --json (BdCliHumanDecisions)',
    schema: bdGateListItemSchema,
  },
  {
    file: 'lease.in-progress.json',
    directory: 'e2e',
    command: 'bd list --status in_progress --json (BdCliLeaseReader)',
    schema: bdInProgressItemSchema,
  },
  {
    file: 'merge-slot.list.json',
    directory: 'e2e',
    command: 'bd list --label gt:slot --json (BdCliMergeSlotReader)',
    schema: bdMergeSlotItemSchema,
  },
  // bdHumanListItemSchema は reader 内部の実装詳細なので export せず、下の本番 reader
  // 経由テストで契約する。e2e の偽 bd はこの共有 fixture を human list にも返す。
  // 対象外: この human list が e2e で支える stale_pending_decision 行 (src/domain/hygiene.ts が
  // 判定) は domain の衛生判定であって bd fixture の読み取り契約ではないので、ここでは
  // 「reader が 1 行も落とさない」と「gate との上書き統合」だけを固定する。
  {
    file: 'bdboard.list.json',
    directory: 'golden',
    command: 'bd list -l human --json (BdCliHumanDecisions)',
  },
];

const e2eContracts = contracts.filter(
  (contract): contract is E2eFixtureContract => contract.directory === 'e2e',
);

function readFixtureItems(file: string, directory: FixtureContract['directory'] = 'e2e'): unknown[] {
  const fixtureDirectory = directory === 'e2e' ? e2eBdFixturesDir : goldenBdFixturesDir;
  const raw = readFileSync(path.join(fixtureDirectory, file), 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`${file} must be a JSON array (bd --json list output)`);
  }
  return parsed;
}

interface FakeBdFixtures {
  readonly humanList?: unknown[];
  readonly gateList?: unknown[];
  readonly lease?: unknown[];
  readonly mergeSlot?: unknown[];
}

function hasPair(args: readonly string[], flag: string, value: string): boolean {
  return args.some((arg, index) => arg === flag && args[index + 1] === value);
}

// 偽 bd (test/e2e/fixtures/bin/bd) と同じ引数ペアで振り分け、未対応の形は exit 1 を返す。
// 本番 reader の引数 (例: --label gt:slot) を偽 bd が知らない形に変えると e2e では
// unsupported で落ち、reader の BdError が use case に握りつぶされて行が黙って消える。
// ここでも同じく落ちるようにして、その食い違いを unit test 段階で捕まえる。
function createFakeBdRunner(fixtures: FakeBdFixtures): CommandRunner {
  return {
    async run(_command, args) {
      const emit = (items: unknown[] | undefined) => ({
        stdout: JSON.stringify(items ?? []),
        stderr: '',
        exitCode: 0,
      });
      const gateIndex = args.indexOf('gate');
      if (gateIndex !== -1 && args[gateIndex + 1] === 'list') {
        return emit(fixtures.gateList);
      }
      if (args.includes('list')) {
        if (hasPair(args, '-l', 'human') || hasPair(args, '--label', 'human')) {
          return emit(fixtures.humanList);
        }
        if (hasPair(args, '--label', 'gt:slot')) {
          return emit(fixtures.mergeSlot);
        }
        if (hasPair(args, '--status', 'in_progress')) {
          return emit(fixtures.lease);
        }
      }
      return {
        stdout: '',
        stderr: `fake bd: unsupported shape: ${args.join(' ')}`,
        exitCode: 1,
      };
    },
  };
}

async function assertGateFixture(gateList: unknown[], humanList: unknown[] = []): Promise<void> {
  const decisions = await createBdCliHumanDecisions(
    createFakeBdRunner({ humanList, gateList }),
  ).listPendingDecisions(ROOT);
  expect(decisions).toContainEqual(
    expect.objectContaining({ id: FIXTURE_TICKET_ID, kind: 'gate' }),
  );
}

async function assertLeaseFixture(items: unknown[]): Promise<void> {
  const leases = await createBdCliLeaseReader(createFakeBdRunner({ lease: items }))
    .listInProgressWithLease(ROOT);
  // hygiene-signals e2e は stale lease 行を FIXTURE_TICKET_ID で絞って 1 件であることを見る。
  expect(detectStaleLeases(leases, 'fixture-project', NOW)).toEqual([
    expect.objectContaining({ ticketId: FIXTURE_TICKET_ID }),
  ]);
}

async function assertMergeSlotFixture(items: unknown[]): Promise<void> {
  const signal = await createBdCliMergeSlotReader(createFakeBdRunner({ mergeSlot: items }))
    .readMergeSlotSignal(ROOT);
  expect(signal).not.toBeNull();
  expect(signal!.holder).toBe(MERGE_SLOT_HOLDER);
  // toSatisfy は JestExtendError を投げるので使わない (下の expectAssertionFailure が名前で判定する)。
  expect(
    Number.isFinite(Date.parse(signal!.updatedAt)),
    `merge-slot updated_at must be parseable: ${signal!.updatedAt}`,
  ).toBe(true);
  const status = evaluateMergeSlotStatus('fixture-project', signal, NOW);
  // hygiene-signals e2e は .badge-stalled の可視性で isLongHeld (しきい値 30 分) に依存する。
  // updated_at がパース不能だと heldForMs=0 / isLongHeld=false に黙って落ちる。
  expect(status.heldForMs).toBeGreaterThan(0);
  expect(status.isLongHeld).toBe(true);
}

// 負の対照で「検査の不一致で落ちた」ことを確かめる。reader が BdError を投げて落ちた場合は
// ここで弾き、スキーマで弾かれず domain が黙って捨てる穴を本当に再現していることを保証する。
async function expectAssertionFailure(check: Promise<void>): Promise<void> {
  await expect(check).rejects.toMatchObject({ name: 'AssertionError' });
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
    expect(onDisk).toEqual(e2eContracts.map((c) => c.file).sort());
  });

  describe.each(e2eContracts)('$file ← $command', ({ file, schema }) => {
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

describe('e2e bd fixtures preserve production reader and domain semantics', () => {
  it('returns the gate fixture as a gate decision', async () => {
    await assertGateFixture(readFixtureItems('gate.list.json'));
  });

  it('fails the gate assertion when await_type is absent although zod accepts it', async () => {
    const items = readFixtureItems('gate.list.json');
    delete (items[0] as Record<string, unknown>).await_type;
    await expectAssertionFailure(assertGateFixture(items));
  });

  // e2e と同じ経路: ゴールデン human list にも同じ id があり、gate が種別を上書きする分岐を通る。
  it('fails the gate assertion on the golden human-list merge path when await_type is absent', async () => {
    const items = readFixtureItems('gate.list.json');
    delete (items[0] as Record<string, unknown>).await_type;
    await expectAssertionFailure(
      assertGateFixture(items, readFixtureItems('bdboard.list.json', 'golden')),
    );
  });

  it('passes the gate assertion on the golden human-list merge path', async () => {
    await assertGateFixture(
      readFixtureItems('gate.list.json'),
      readFixtureItems('bdboard.list.json', 'golden'),
    );
  });

  it('finds exactly one stale lease from the lease fixture', async () => {
    await assertLeaseFixture(readFixtureItems('lease.in-progress.json'));
  });

  // 未来時刻は NOW だけでなく実時計で走る e2e から見ても未来になる値にする。
  it.each(['not-a-date', '2099-01-01T00:00:00Z'])(
    'fails the stale-lease assertion when lease_expires_at is %s',
    async (leaseExpiresAt) => {
      const items = readFixtureItems('lease.in-progress.json');
      (items[0] as Record<string, unknown>).lease_expires_at = leaseExpiresAt;
      await expectAssertionFailure(assertLeaseFixture(items));
    },
  );

  it('provides a merge-slot updated_at that the domain can use', async () => {
    await assertMergeSlotFixture(readFixtureItems('merge-slot.list.json'));
  });

  it('fails the merge-slot assertion when updated_at cannot be parsed', async () => {
    const items = readFixtureItems('merge-slot.list.json');
    (items[0] as Record<string, unknown>).updated_at = 'not-a-date';
    await expectAssertionFailure(assertMergeSlotFixture(items));
  });

  it('reads the shared golden fixture through the human-list branch of the production reader', async () => {
    const humanList = readFixtureItems('bdboard.list.json', 'golden');
    const gateList = readFixtureItems('gate.list.json');
    const decisions = await createBdCliHumanDecisions(createFakeBdRunner({ humanList, gateList }))
      .listPendingDecisions(ROOT);
    // gate fixture と同じ id は human list 側にもあり、mergePendingDecisions がその種別を
    // gate に上書きする。したがって件数は増えず、該当 id が gate で残ることを検証する。
    expect(decisions).toHaveLength(humanList.length);
    expect(decisions).toContainEqual(
      expect.objectContaining({ id: FIXTURE_TICKET_ID, kind: 'gate' }),
    );
  });
});
