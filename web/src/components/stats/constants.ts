export const CFD_STATUS_ORDER = [
  'open',
  'in_progress',
  'blocked',
  'closed',
  'deferred',
  'pinned',
  'hooked',
] as const;

export const CFD_STATUS_LABELS: Record<string, string> = {
  open: '未着手',
  in_progress: '作業中',
  blocked: 'ブロック中',
  closed: '完了',
  deferred: '延期',
  pinned: '固定',
  hooked: 'フック',
};

// bdboard-7g0a: 7 色すべてがテーマ追従のトークンで定義されている
// (web/src/index.css の :root / prefers-color-scheme:dark ブロック)。
// open/in_progress/blocked は既存の意味的トークンを流用し、pinned/hooked は
// 7g0a で新設した専用トークンを参照する。定義済みなのでフォールバック値は
// 不要 (未定義参照時に固定色が両テーマへ焼き付く問題を避ける)。
//
// bdboard-8gvg: closed/deferred は当初 --color-success / --color-warning を
// 直接流用していたが、light の --color-bg-elevated 上で closed 2.22:1 /
// deferred 2.20:1 と SC 1.4.11 (非テキストコントラスト 3:1) を下回っていた。
// --color-success / --color-warning 自体は他に約 30 箇所で参照されており値を
// 動かせないため、pinned/hooked と同じ形で CFD 専用の派生トークン
// (--throughput-cfd-closed / --throughput-cfd-deferred、index.css 参照) を
// 新設して差し替えた。dark は元々 3:1 を満たしていたため、新設トークンの
// dark 値は --color-success / --color-warning の現行 dark 値の複製 (悪化なし)。
export const CFD_STATUS_COLORS: Record<string, string> = {
  open: 'var(--color-accent)',
  in_progress: 'var(--color-purple)',
  blocked: 'var(--color-danger)',
  closed: 'var(--throughput-cfd-closed)',
  deferred: 'var(--throughput-cfd-deferred)',
  pinned: 'var(--throughput-cfd-pinned)',
  hooked: 'var(--throughput-cfd-hooked)',
};

export const CHART_DESCRIPTIONS = {
  openTicketAge:
    '未完了チケットが作成から何日経過しているか(件数)',
  modelWeeklyCloses:
    '工程で使用したAIモデルごとの、週次クローズ件数',
  modelStageDistribution:
    '実装/テスト/レビュー等の工程ごとに、どのAIモデルが何件使われたか',
} as const;

export const SECTION_DESCRIPTIONS = {
  throughput:
    'チケットの完了ペースと、未完了チケットの滞留状況',
  flow:
    '日々のステータス別件数の推移からボトルネックを読み取る',
  modelStats:
    'bdメタデータ(bdboard.model.<工程>)から集計した、工程ごとのAIモデル使用実績',
  harnessKpi:
    'エージェント作業の進め方(ハーネス)自体が効いているかを見る4指標',
} as const;
