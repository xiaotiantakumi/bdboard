/**
 * Onion architecture boundary rules (docs/PLAN.md「層構成」節)。
 *
 * NOTE (S0確定事項, 2026-08-14): infrastructure→domain と interface→domain の直接依存は
 * 意図的に「禁止しない」。オニオンアーキテクチャでは外側の層(infrastructure/interface)は
 * 内側の層(domain)の型に直接依存してよい(逆方向のみ禁止)。加えて docs/PLAN.md のポート方式
 * (IssueRepository 等を application が定義し infrastructure が実装)では、S3の
 * BdCliIssueRepository が bd CLI の JSON から domain の Ticket 等を直接構築して返す必要が
 * あるため、ここを禁止すると実装が破綻する。過去にこのルールを追加/削除で往復した実績が
 * あるため、再度「厳格にしたい」と思ったらこの注記を読んでから判断すること。
 *
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'bdboard-tml8: import 循環を禁止する。既知の循環のうち src/interface/http 側は' +
        '型定義の抽出(api-deps.ts / harness-routes-deps.ts)で解消済み。' +
        'web/src/api/board.ts <-> tickets-read.ts の型だけの相互循環は、下の2ルールで' +
        '具体的なパス対のみ許容している(bdboard-a8e6 で解消予定)。ここではその2ファイルを' +
        '「発信元」とする循環だけ除外し、他ファイルからの循環や、この2ファイルが絡む' +
        '新しい(別の相手先への)循環は引き続き検出する。',
      from: {
        pathNot: [
          '^web/src/api/board\\.ts$',
          '^web/src/api/tickets-read\\.ts$',
        ],
      },
      to: { circular: true },
    },
    {
      name: 'no-circular-board-dto-allowlisted',
      severity: 'error',
      comment:
        'bdboard-tml8 / bdboard-a8e6: board.ts -> tickets-read.ts は type-only の相互' +
        '循環(board.ts が TicketSummaryDto を、tickets-read.ts が Lane を type-only' +
        'import)。Lane が LANES/LANE_LABELS と密結合しており、この場で安全に切り離せる' +
        '分量ではなかったため許容する。board.ts から他ファイルへの新しい循環は引き続き検出する。',
      from: { path: '^web/src/api/board\\.ts$' },
      to: {
        circular: true,
        pathNot: '^web/src/api/tickets-read\\.ts$',
      },
    },
    {
      name: 'no-circular-tickets-read-dto-allowlisted',
      severity: 'error',
      comment:
        'bdboard-tml8 / bdboard-a8e6: tickets-read.ts -> board.ts の逆方向。上の' +
        'no-circular-board-dto-allowlisted と対になる許容(bdboard-a8e6 で解消予定)。' +
        'tickets-read.ts から他ファイルへの新しい循環は引き続き検出する。',
      from: { path: '^web/src/api/tickets-read\\.ts$' },
      to: {
        circular: true,
        pathNot: '^web/src/api/board\\.ts$',
      },
    },
    {
      name: 'domain-no-upstream-deps',
      severity: 'error',
      comment:
        'domain must not depend on application, infrastructure, or interface',
      from: { path: '^src/domain' },
      to: { path: '^src/(application|infrastructure|interface)' },
    },
    {
      name: 'application-no-infrastructure',
      severity: 'error',
      comment: 'application must not depend on infrastructure',
      from: { path: '^src/application' },
      to: { path: '^src/infrastructure' },
    },
    {
      name: 'application-no-interface',
      severity: 'error',
      comment: 'application must not depend on interface',
      from: { path: '^src/application' },
      to: { path: '^src/interface' },
    },
    {
      name: 'interface-no-infrastructure',
      severity: 'error',
      comment: 'interface must not depend on infrastructure directly',
      from: { path: '^src/interface' },
      to: { path: '^src/infrastructure' },
    },
    {
      name: 'infrastructure-no-interface',
      severity: 'error',
      comment: 'infrastructure must not depend on interface',
      from: { path: '^src/infrastructure' },
      to: { path: '^src/interface' },
    },
    {
      name: 'no-upstream-deps-on-bootstrap',
      severity: 'error',
      comment:
        'bdboard-sso1.14: domain/application/infrastructure/interface must not depend on ' +
        'src/bootstrap (the composition root). bootstrap itself stays unconstrained as an ' +
        'IMPORT SOURCE (it may import from any layer, same as main.ts always could) — this ' +
        'rule only constrains it as an IMPORT TARGET.',
      from: { path: '^src/(domain|application|infrastructure|interface)' },
      to: { path: '^src/bootstrap' },
    },
    {
      name: 'no-child-process-outside-process-runners',
      severity: 'error',
      comment:
        'child_process may only be imported from infrastructure/process or infrastructure/runners',
      from: {
        pathNot: '^src/infrastructure/(process|runners)/',
      },
      to: {
        dependencyTypes: ['core'],
        path: '^child_process$',
      },
    },
    {
      name: 'web-no-server-src',
      severity: 'error',
      comment:
        'web/ (browser bundle) must not import from src/ (server). DTO 等は web/src 側で別途定義する',
      from: { path: '^web/' },
      to: { path: '^src/' },
    },
    {
      name: 'server-no-web',
      severity: 'error',
      comment: 'src/ (server) must not import from web/ (browser bundle)',
      from: { path: '^src/' },
      to: { path: '^web/' },
    },
  ],
  options: {
    doNotFollow: {
      path: 'node_modules',
    },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
  },
};
