import { expect, test } from '@playwright/test';

/**
 * gate / lease / merge-slot の e2e 専用 bd fixture がサーバー→UI まで届くことを検証する
 * (bdboard-vr71)。human 一覧は global-setup で別途配線済み。
 */

// smoke.spec.ts / test/fixtures/bd/bdboard.list.json と同期
const TICKET_ID = 'bdboard-3tw.8';
const TICKET_TITLE = 'Fixture ticket bdboard-3tw.8';

// test/e2e/fixtures/bd/merge-slot.list.json の metadata.holder と同期
const MERGE_SLOT_HOLDER = 'e2e-fixture-merge-slot-holder';
// web/src/components/HygienePanel.tsx:78 の MERGE_SLOT_KIND_LABEL と同期
const MERGE_SLOT_KIND_LABEL = 'マージスロット';
// web/src/components/HygienePanel.tsx:77 の STALE_LEASE_KIND_LABEL と同期
const STALE_LEASE_KIND_LABEL = 'stale lease（heartbeat 途絶）';
// web/src/components/TicketDetailPanel.tsx:2164-2166 の pendingDecision.kind === 'gate'
// のときだけ出る <p className="detail-help"> と同期
const GATE_PRE_SUBMIT_NOTICE =
  'これは質問専用のゲートです。回答するとゲートはクローズされ、ブロックされていたチケットが着手可能になります。';

test.describe('hygiene signals from e2e bd fixtures', () => {
  test.describe('健全性ビュー', () => {
    test.beforeEach(async ({ page }) => {
      await page.goto('/');
      await page.getByRole('button', { name: '健全性', exact: true }).click();
    });

    test.describe.configure({ timeout: 60_000 });

    test('hygiene panel shows merge-slot held status from merge-slot fixture', async ({
      page,
    }) => {
      const mergeSlotBadge = page.locator('.hygiene-kind-merge_slot', {
        hasText: MERGE_SLOT_KIND_LABEL,
      });
      await expect(mergeSlotBadge).toBeVisible({ timeout: 15_000 });

      const mergeSlotRow = page.locator('.hygiene-merge-slot-group .hygiene-issue-row');
      await expect(mergeSlotRow).toHaveCount(1);
      await expect(mergeSlotRow.locator('.hygiene-issue-id')).toHaveText(MERGE_SLOT_HOLDER);
      await expect(mergeSlotRow.locator('.hygiene-issue-message')).toContainText('保持中');
      // merge-slot.list.json の updated_at がパース不能だと heldForMs=0 になり
      // isLongHeld=false のまま通ってしまう (src/domain/merge-slot.ts:60-62, :71)。
      // badge-stalled の可視性で isLongHeld (しきい値 30分) を固定し、updated_at の
      // パースが load-bearing になる。
      // fixture の updated_at は固定の過去日時。相対的に「今日」な値だと
      // しきい値 30分をまたぐ時間帯で不安定になる。
      await expect(mergeSlotRow.locator('.badge-stalled')).toBeVisible();
    });

    test('hygiene panel shows stale lease from in_progress lease fixture', async ({ page }) => {
      const staleLeaseBadge = page.locator('.hygiene-kind-stale_lease', {
        hasText: STALE_LEASE_KIND_LABEL,
      });
      await expect(staleLeaseBadge).toBeVisible({ timeout: 15_000 });

      const staleLeaseRow = page.locator('.hygiene-stale-lease-group .hygiene-issue-row', {
        hasText: TICKET_ID,
      });
      await expect(staleLeaseRow).toHaveCount(1);
      await expect(staleLeaseRow.locator('.hygiene-issue-message')).toContainText(
        'lease 失効から',
      );
    });
  });

  test('gate list fixture marks the ticket pending decision as kind gate in detail panel', async ({
    page,
  }) => {
    test.setTimeout(60_000);

    await page.goto('/');

    const card = page.locator('article', { hasText: TICKET_TITLE });
    await expect(card).toBeVisible({ timeout: 15_000 });
    // web/src/components/LaneColumn.tsx:328-330 の
    // <span className="badge badge-pending-decision" title="ユーザー確認待ち"> と同期。
    // 第1アサートは前提条件であって gate 配線を守ってはいない。bdboard-3tw.8 は
    // human 一覧 (BDBOARD_E2E_BD_HUMAN_LIST_FIXTURE) にも入っているので、gate fixture
    // を外した origin/main の状態でも成立する。gate 配線を実際に守っているのは
    // ゲート予告文の可視性だけ (fixture を外すとカウント 0、配線すると 1 という実測)。
    // bdboard-3tw.8 は human 一覧にもあるため mergePendingDecisions
    // (src/infrastructure/bd/bd-cli-human-decisions.ts:367-377) の上書き分岐を通る。
    // 本来の動機である newGateIds 追記分岐 (同ファイル :387、human ラベルを持たない
    // gate) は未カバーであり、カードが存在せず UI から観測できないため意図的に対象外。
    await expect(card.locator('.badge-pending-decision')).toHaveText('確認待ち');

    await card.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(GATE_PRE_SUBMIT_NOTICE)).toBeVisible({
      timeout: 15_000,
    });
  });
});
