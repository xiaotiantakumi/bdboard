import { expect, test, type Page } from '@playwright/test';

/**
 * モバイル(375/393 x 812)でアクティビティ行タイトルと Hygiene プロジェクト名が
 * 横省略で判別不能になる回帰を防ぐ (bdboard-h4xs.8)。
 *
 * アクティビティは e2e フィクスチャの bd データが 2026-08-14 起点で期間選択が
 * 最大 7 日のため素では 0 行。/api/activity を stub して現在時刻の長いタイトルを返す。
 * Hygiene は e2e サーバー実データを使う（projectId が tmp 配下のフルパスになる）。
 */

/** web/src/api.ts ActivityEventDto の wire 形（e2e は web/src を import しない） */
interface ActivityEventFixture {
  kind:
    | 'created'
    | 'started'
    | 'closed'
    | 'status_changed'
    | 'priority_changed'
    | 'field_changed';
  at: string;
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  status: string;
  priority: number;
  issueType: string;
  actor?: string;
  from?: string;
  to?: string;
}

interface ActivityTitleMetrics {
  clientWidth: number;
  scrollWidth: number;
  clientHeight: number;
  scrollHeight: number;
  rowWidth: number;
  naturalSingleLineWidth: number;
}

interface HygieneProjectMetrics {
  textContent: string;
  title: string | null;
  clientWidth: number;
  scrollWidth: number;
  rowContentWidth: number;
  displayedNaturalWidth: number;
  realisticNameWidth: number;
  textOverflow: string;
  overflowX: string;
}

/**
 * 実ボード (localhost:8787) で実測した最長のプロジェクト名 (2026-09-05, 13 プロジェクト中最長の 21 文字)。
 * e2e フィクスチャの basename は `fixture-project` (15 文字 / 自然幅 78.75px @375px) しかなく、
 * 最狭の hygiene 行 (stale lease、project セル 87px) にも収まってしまうため、
 * `scrollWidth <= clientWidth` は 74 行中 0 行でしか発火しない空振りガードだった (bdboard-4kik)。
 * 実機相当の長さはこの定数が持ち、列がその幅を確保していることを補助チェックする。
 *
 * この定数は 2026-09-05 時点のスナップショット。より長い名前が実機に増えても
 * 主たる不変条件（clientWidth >= 行のコンテンツ幅）は名前長に非依存なので陳腐化しないが、
 * この補助チェックを実機に合わせたいときはここを更新する。
 */
const REAL_BOARD_LONGEST_PROJECT_NAME = 'chewing-enlightenment';

/** 上記の名前の @375px 実測自然幅 133.7px を下回らないことの下限 (フォント差のマージン込み) */
const REAL_BOARD_LONGEST_PROJECT_NAME_MIN_WIDTH_PX = 120;

/*
 * 実在するチケットタイトル相当の長さ。修正前は nowrap + ellipsis + 幅 176px のため
 * clientWidth 176px / scrollWidth 565px で約 31% しか見えなかった (375x812 実測)。
 * 修正後は行全幅 (351px) に落ちて 2 行で収まり、3 行 line-clamp (clientHeight 69px)
 * には 1 行分の余裕が残る。極端に長いタイトル (110 文字級) を置くと clamp に
 * 引っかかって落ちるので、ここは現実的な長さに保つこと。
 */
const LONG_ACTIVITY_TITLE =
  'アクティビティ/Hygiene: モバイルでタイトル・プロジェクト名が省略され判別不能になる';

function buildActivityStub(): ActivityEventFixture[] {
  return [
    {
      kind: 'created',
      at: new Date().toISOString(),
      id: 'bdboard-h4xs.8-fixture',
      projectId: 'fixture-project',
      projectName: 'fixture-project',
      title: LONG_ACTIVITY_TITLE,
      status: 'open',
      priority: 2,
      issueType: 'task',
      actor: 'example-user',
    },
  ];
}

async function readActivityTitleMetrics(page: Page): Promise<ActivityTitleMetrics> {
  return page.evaluate(() => {
    const title = document.querySelector('.activity-event-title');
    const row = document.querySelector('.activity-event-row');
    if (!title || !row) {
      throw new Error('activity title or row not found');
    }

    // 自然な1行幅。フィクスチャのタイトルが短くなってこのテストが無力化するのを防ぐ。
    const probe = title.cloneNode(true) as HTMLElement;
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.style.display = 'inline';
    probe.style.width = 'auto';
    probe.style.maxWidth = 'none';
    probe.style.whiteSpace = 'nowrap';
    probe.style.webkitLineClamp = 'none';
    title.parentElement!.appendChild(probe);
    const naturalSingleLineWidth = probe.getBoundingClientRect().width;
    probe.remove();

    return {
      clientWidth: title.clientWidth,
      scrollWidth: title.scrollWidth,
      clientHeight: title.clientHeight,
      scrollHeight: title.scrollHeight,
      rowWidth: row.getBoundingClientRect().width,
      naturalSingleLineWidth,
    };
  });
}

async function readHygieneProjectMetrics(
  page: Page,
  realisticProjectName: string,
): Promise<HygieneProjectMetrics[]> {
  return page.evaluate(
    ({ realisticName }) => {
      function measureNaturalWidth(el: Element, text?: string): number {
        const probe = el.cloneNode(true) as HTMLElement;
        probe.style.position = 'absolute';
        probe.style.visibility = 'hidden';
        probe.style.display = 'inline';
        probe.style.width = 'auto';
        probe.style.maxWidth = 'none';
        probe.style.whiteSpace = 'nowrap';
        if (text !== undefined) {
          probe.textContent = text;
        }
        el.parentElement!.appendChild(probe);
        const width = probe.getBoundingClientRect().width;
        probe.remove();
        return width;
      }

      return Array.from(document.querySelectorAll('.hygiene-issue-project')).map((el) => {
        const style = getComputedStyle(el);
        const row = el.closest('.hygiene-issue-row');
        if (!row) {
          throw new Error(
            '.hygiene-issue-project must be inside .hygiene-issue-row — layout prerequisite broken',
          );
        }
        const rowStyle = getComputedStyle(row);
        const rowContentWidth =
          row.clientWidth -
          parseFloat(rowStyle.paddingLeft) -
          parseFloat(rowStyle.paddingRight);
        return {
          textContent: (el.textContent ?? '').trim(),
          title: el.getAttribute('title'),
          clientWidth: el.clientWidth,
          scrollWidth: el.scrollWidth,
          rowContentWidth,
          displayedNaturalWidth: measureNaturalWidth(el),
          realisticNameWidth: measureNaturalWidth(el, realisticName),
          textOverflow: style.textOverflow,
          overflowX: style.overflowX,
        };
      });
    },
    { realisticName: realisticProjectName },
  );
}

// 480px メディアクエリ境界に対し 375px は下限側、393px は iPhone 14/15 主力実機幅。
// 旧レイアウト（project が col3 ≈ 105px）なら 393px で chewing-enlightenment (133.7px) が再 clip する。
for (const viewportWidth of [375, 393] as const) {
  test.describe(`mobile activity and hygiene truncation @${viewportWidth}px`, () => {
    test.use({
      viewport: { width: viewportWidth, height: 812 },
      isMobile: true,
      hasTouch: true,
    });

    test('activity titles use full row width without horizontal clipping', async ({ page }) => {
      test.setTimeout(60_000);

      await page.route('**/api/activity?**', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(buildActivityStub()),
        });
      });

      await page.goto('/');
      await page.getByRole('button', { name: 'アクティビティ', exact: true }).click();
      await expect(page.locator('.activity-event-row').first()).toBeVisible({ timeout: 15_000 });

      const metrics = await readActivityTitleMetrics(page);

      // フィクスチャのタイトルは 1 行に収まらない長さでなければ、このテストは
      // 何も検出しない（修正前でも通ってしまう）。@375px 実測: 自然幅 ≈565px vs clientWidth ≈351px。
      expect(
        metrics.naturalSingleLineWidth,
        `fixture title is too short to exercise truncation: natural single-line width ${metrics.naturalSingleLineWidth} must exceed clientWidth ${metrics.clientWidth}`,
      ).toBeGreaterThan(metrics.clientWidth);

      expect(
        metrics.scrollWidth,
        `title scrollWidth (${metrics.scrollWidth}) should fit within clientWidth (${metrics.clientWidth}) — horizontal clipping detected`,
      ).toBeLessThanOrEqual(metrics.clientWidth);

      expect(
        metrics.scrollHeight,
        `title scrollHeight (${metrics.scrollHeight}) should fit within clientHeight (${metrics.clientHeight}) — vertical clipping beyond 3-line clamp`,
      ).toBeLessThanOrEqual(metrics.clientHeight);

      // 修正前: clientWidth/rowWidth ≈ 176/351 = 0.50（@375px）。行全幅の 80% 以上を使うこと。
      const widthRatio = metrics.clientWidth / metrics.rowWidth;
      expect(
        widthRatio,
        `title clientWidth (${metrics.clientWidth}) should be >= 80% of row width (${metrics.rowWidth}), ratio=${widthRatio.toFixed(3)}`,
      ).toBeGreaterThanOrEqual(0.8);
    });

    test('hygiene project names show basename with full path in title', async ({ page }) => {
      test.setTimeout(60_000);

      await page.goto('/');
      await page.getByRole('button', { name: '健全性', exact: true }).click();
      await expect(page.locator('.hygiene-issue-project').first()).toBeVisible({
        timeout: 15_000,
      });

      const projects = await readHygieneProjectMetrics(page, REAL_BOARD_LONGEST_PROJECT_NAME);

      expect(
        projects.length,
        `expected at least one .hygiene-issue-project element, found ${projects.length}`,
      ).toBeGreaterThanOrEqual(1);

      for (const [index, project] of projects.entries()) {
        expect(
          project.realisticNameWidth,
          `[${index}] REAL_BOARD_LONGEST_PROJECT_NAME ("${REAL_BOARD_LONGEST_PROJECT_NAME}") renders only ${project.realisticNameWidth}px wide — 実機最長 (133.7px @375px) を下回る定数に置き換えるとこの補助ガードは空振りする`,
        ).toBeGreaterThanOrEqual(REAL_BOARD_LONGEST_PROJECT_NAME_MIN_WIDTH_PX);

        expect(
          project.clientWidth,
          `[${index}] project cell clientWidth (${project.clientWidth}px) should span the row's full content width (${project.rowContentWidth}px) — this is the name-length-independent invariant that the ≤480px grid-template-areas fix (bdboard-4kik) establishes; a regression here means project is back in a shared column`,
        ).toBeGreaterThanOrEqual(project.rowContentWidth - 0.5);

        // effectiveGuardWidth: fixture 名より長い REAL_BOARD 定数のどちらか大きい方が
        // 列に必要な最小幅。fixture が 21 文字超にリネームされても偽陽性にならない。
        const effectiveGuardWidth = Math.max(
          project.displayedNaturalWidth,
          project.realisticNameWidth,
        );
        expect(
          project.clientWidth,
          `[${index}] project cell clientWidth (${project.clientWidth}px) should fit effective guard width (${effectiveGuardWidth}px) for "${project.textContent}" — 補助チェック（主たる不変条件は上の row-full-width assert）。before bdboard-4kik fix, stale lease rows were 87px and failed here`,
        ).toBeGreaterThanOrEqual(effectiveGuardWidth);

        expect(
          project.textOverflow,
          `[${index}] textOverflow should be "ellipsis" so overflow names degrade gracefully, got "${project.textOverflow}"`,
        ).toBe('ellipsis');

        expect(
          project.overflowX,
          `[${index}] overflow-x should be "hidden" so ellipsis applies, got "${project.overflowX}"`,
        ).toBe('hidden');

        // 上の row-full-width / effectiveGuardWidth assert が通れば恒真だが、clip の直接目撃者として意図的に残置（bdboard-4kik レビュー N1）。
        expect(
          project.scrollWidth,
          `[${index}] scrollWidth (${project.scrollWidth}) should fit within clientWidth (${project.clientWidth}) for "${project.textContent}"`,
        ).toBeLessThanOrEqual(project.clientWidth);

        expect(
          project.textContent.includes('/'),
          `[${index}] textContent should be basename without path separators, got "${project.textContent}"`,
        ).toBe(false);

        expect(
          project.title,
          `[${index}] title attribute should hold the full project path`,
        ).not.toBeNull();

        expect(
          project.title!.includes('/'),
          `[${index}] title should contain path separators, got "${project.title}"`,
        ).toBe(true);

        expect(
          project.title!.endsWith(project.textContent),
          `[${index}] title ("${project.title}") should end with displayed basename ("${project.textContent}")`,
        ).toBe(true);
      }
    });
  });
}
