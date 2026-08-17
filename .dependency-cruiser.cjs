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
      from: { path: '^web/src' },
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
