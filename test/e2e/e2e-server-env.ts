import path from 'node:path';

/**
 * e2e のサーバー (test/e2e/global-setup.ts が起動する src/main.ts) に渡す環境変数を組み立てる。
 *
 * global-setup.ts から切り出したのは、「このサーバーは本物の gh を起動しない」(bdboard-em45) のように、
 * env が満たすべき性質を e2e を回さずに vitest (e2e-server-env.test.ts) で固定するため。
 * 値の意味と理由のコメントは、すべてここにある (global-setup.ts から動かしただけで、値は変えていない)。
 */
export interface E2eServerEnvInputs {
  /** 親プロセスの env (通常は process.env)。ここへ下の値を上書きして渡す。 */
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly port: string;
  readonly host: string;
  readonly dbPath: string;
  /** スキャン対象のプロジェクトのルート (使い捨てディレクトリ)。 */
  readonly scanRoots: readonly string[];
  readonly scanRootsConfigPath: string;
  /** bd / claude の stub を置いたディレクトリ。PATH の先頭に入れる。 */
  readonly binDir: string;
  readonly claudeStub: string;
  readonly listFixture: string;
  readonly gateListFixture: string;
  readonly leaseFixture: string;
  readonly mergeSlotFixture: string;
  readonly webDist: string;
  readonly instanceNonce: string;
}

export function buildE2eServerEnv(inputs: E2eServerEnvInputs): NodeJS.ProcessEnv {
  return {
    ...inputs.baseEnv,
    PATH: `${inputs.binDir}${path.delimiter}${inputs.baseEnv.PATH ?? ''}`,
    BDBOARD_PORT: inputs.port,
    BDBOARD_HOST: inputs.host,
    BDBOARD_DB: inputs.dbPath,
    BDBOARD_SCAN_ROOTS: inputs.scanRoots.join(','),
    // Points the scan-roots user-config store at a throwaway path inside this test's tmp
    // root so the e2e run never reads/writes the developer's real
    // ~/.config/bdboard/config.json (bdboard-3tw.102.2).
    BDBOARD_SCAN_ROOTS_CONFIG_PATH: inputs.scanRootsConfigPath,
    // Auth is explicitly disabled (not "set fake creds and log in") so
    // this fixture never has to hold a username/password-shaped literal.
    BDBOARD_AUTH_DISABLED: '1',
    BDBOARD_AUTH_USER: '',
    BDBOARD_AUTH_PASSWORD: '',
    // Chat stays enabled for chat-mobile e2e; smoke scenarios never open the panel.
    BDBOARD_CLAUDE_PATH: inputs.claudeStub,
    BDBOARD_AI_QUOTA_DISABLED: '1',
    // 届いた issue (公開リポジトリに届いた issue) の定期確認を止める (bdboard-em45)。この確認は、サーバーの
    // repoRoot (src/main.ts のある checkout) に .beads があるメンテナ環境だと、起動の 60 秒後に本物の gh
    // (`gh api --method GET`) を呼び、その checkout の data/external-issues に写しを書く。e2e を main checkout から
    // 回すとこれに当たり、常時稼働のサーバーとは別の lock・別の枠 (1 時間 12 回) で動いてしまう。worktree と CI には
    // .beads が無いので元から動かない。止めておけば、どの場所から回しても同じ条件になる (いまの e2e の画面は、この確認の
    // 結果を使わない。使う画面の e2e を足すときは、ここで止めたまま、その spec 用に別の手立てを考える)。BDBOARD_GH_PATH を失敗する stub に向ける手もあるが、それは PR の状態の読み取りなど他の
    // gh も巻き込み、確認の timer と写しの置き場は残る。
    // 親の env に BDBOARD_EXTERNAL_ISSUES_DISABLED=0 などが入っていても、ここで '1' に上書きする。
    BDBOARD_EXTERNAL_ISSUES_DISABLED: '1',
    // src/bootstrap/resolve-main-config.ts の envBoolDefaultTrue('BDBOARD_RECLAIM_ENABLED') を
    // 落として、自動 reclaim ループを e2e では止める。止めないと
    // web/src/components/hygiene/StaleLeaseSection.tsx の reclaimEnabled 分岐が
    // 「自動 reclaim は無効です」
    // ではなく reclaim 実行状況の行を描画し、そこに tmp のフルパス + bd スタブの
    // エラー文字列が折り返し指定無しで入る。375x812 で document.body.scrollWidth が
    // 375 → 437 に膨らみ、html{overflow-x:hidden} / body{overflow-x:clip} により
    // 62px が到達不能な切り取られ領域になる (実測: 修正前 437 / 修正後 375)。
    // 同時に起動のたびに出る
    // `Reclaim failed for project=...: bd stub: unsupported subcommand` のログノイズも消える。
    // 製品側の折り返し不足そのものは bdboard-z5tv に分離済み。
    BDBOARD_RECLAIM_ENABLED: '0',
    BDBOARD_E2E_BD_LIST_FIXTURE: inputs.listFixture,
    // 確認待ちレーンにも同じゴールデン一覧を流す。旧スタブは `list` を含む全形状に
    // これを返していたため、`bd list -l human` 由来の pendingDecisions が暗黙に
    // 埋まり、健全性パネルの stale_pending_decision 行 —
    // mobile-activity-hygiene-truncation.spec.ts の `.hygiene-issue-project` —
    // がそれに依存していた。形状別ディスパッチ化(bdboard-sp5q)で human 一覧が
    // 既定 `[]` になると、その行ごと消えてテストが落ちる。ここで明示的に配線し、
    // 「たまたま通っていた」状態を「意図して覆っている」状態に置き換える。
    BDBOARD_E2E_BD_HUMAN_LIST_FIXTURE: inputs.listFixture,
    // gate / lease / merge-slot は e2e 専用の最小 fixture (bdboard-vr71)。
    // global-setup で渡すので全 e2e spec に一律で効く — 特定の spec だけに
    // 効くものではない。
    //
    // lease fixture が健全性パネルに増やす行の kind バッジ
    // `stale lease（heartbeat 途絶）` は 182px・white-space: nowrap でパネル中
    // 最長。`.hygiene-issue-row` は grid-template-columns: auto auto 1fr
    // なので、この行だけ project 列 (1fr) が潰れる。
    // ≤480px の帯では bdboard-4kik で project が行全幅 (375px 幅で 325px) に移った。
    // 以下の 87px / 余白 8.25px の実測は 481px 以上の帯（旧 3 列レイアウト）の話。
    // 結果として同 spec の `.hygiene-issue-project` に対する
    // `scrollWidth <= clientWidth` / `clientWidth >= rowContentWidth` の assert 群の
    // 安全余白が 66px から 8px に縮んだ（481px+ 帯での話）。
    // macOS Chromium 実測 (481px+ 帯): 既存の `放置された確認待ち` 行は 145px 列に
    // 78.75px で余白 66.25px、新しい stale lease 行は 87px 列に 78.75px で余白 8.25px。
    // truncation 系 spec が落ちたらまずここを疑うこと。
    //
    // (m4) lease.in-progress.json は bdboard-3tw.8 を
    // `bd list --status in_progress` の結果として返すが、ゴールデン一覧
    // test/fixtures/bd/bdboard.list.json ではこのチケットは "status": "open"。
    // 実物の bd では起こりえない組み合わせ。ゴールデン一覧に in_progress の
    // チケットが1件も無いため、lease fixture は open チケットの ID を借りている。
    // 盤面とは意図的に不整合であり、レーン件数を変えると他 spec に波及するため
    // 直していない (JSON にコメントが書けないのでここに書く)。
    //
    // (m6) lease.in-progress.json の heartbeat_at は、
    // src/domain/lease.ts の detectStaleLeases が leaseExpiresAt しか見ないため
    // 完全に飾り。実物の出力形に寄せるためだけに置いてある。
    BDBOARD_E2E_BD_GATE_LIST_FIXTURE: inputs.gateListFixture,
    BDBOARD_E2E_BD_LEASE_FIXTURE: inputs.leaseFixture,
    BDBOARD_E2E_BD_MERGE_SLOT_FIXTURE: inputs.mergeSlotFixture,
    BDBOARD_WEB_DIST: inputs.webDist,
    // per-run nonce: waitForHealth が同一ポートの他人サーバーと自分の子を区別する (bdboard-aokz)
    BDBOARD_INSTANCE_NONCE: inputs.instanceNonce,
  };
}
