/**
 * 注入先プロジェクトが宣言する「検証コントラクト」。
 *
 * bdboard 自身には `npm run verify` → PR → CI → merge-slot/CAS → main で再 verify
 * という強いフィードバックループがあるが、パックを注入した他プロジェクトでは
 * 「プロジェクト規約の検証コマンド」を CLAUDE.md から探せと言うだけで、無ければ
 * 何も起きない。注入先にこのファイルを置かせ、無ければ Hygiene に
 * 「検証ループ未定義」を出して可視化する (bdboard-pkr6.3)。
 *
 * `.claude/` 配下に置くのは、注入 API のパストラバーサルガード
 * `resolveUnderClaudeDir` の内側に収めるため。
 */
export const HARNESS_CONTRACT_RELATIVE_PATH = '.claude/bdboard-harness.json';

/** 現在サポートするコントラクトのバージョン。将来の破壊的変更でだけ上げる。 */
export const HARNESS_CONTRACT_VERSION = 1;

/** 既定のメインブランチ名 (`mainBranch` 省略時)。 */
export const DEFAULT_MAIN_BRANCH = 'main';

/** そのプロジェクトの git 運用。`pr` = PR 必須 / `direct` = main 直コミット可 / `none` = git 運用なし。 */
export type HarnessPrFlow = 'pr' | 'direct' | 'none';

export const HARNESS_PR_FLOWS: readonly HarnessPrFlow[] = ['pr', 'direct', 'none'];

/**
 * P1a の pre-bash-guard が読む、プロジェクト固有の禁止パターン。
 * ここでは型とバリデーションだけを持ち、hook 側の解釈には踏み込まない。
 */
export interface HarnessContractHooks {
  readonly denyBashPatterns: readonly string[];
  readonly denyBashMessages: readonly string[];
}

/**
 * モデル振り分け表の複雑度。**`low` / `med` / `high` の 3 段で固定**し、
 * 注入先プロジェクトに増やさせない。
 *
 * 委譲先の aimix が受け取る `--complexity` が 1 次元の enum (既定 `med`) なので、
 * ここを可変にすると「bdboard 側では宣言できるが渡す先が無い」複雑度が作れて
 * しまう。両側の対応が取れる範囲に閉じておく (bdboard-p5l.13)。
 */
export type HarnessModelComplexity = 'low' | 'med' | 'high';

/** parseModelCandidates が検証した member:model。未検証の文字列とは区別する。 */
export type HarnessModelCandidate = string & {
  readonly __harnessModelCandidate: unique symbol;
};

export const HARNESS_MODEL_COMPLEXITIES: readonly HarnessModelComplexity[] = [
  'low',
  'med',
  'high',
];

/** 3 段まとめて 1 本の候補列にするワイルドカードキー。 */
export const HARNESS_MODEL_WILDCARD = '*';

/** 1 つの stage に書ける複雑度キー。 */
export type HarnessModelComplexityKey =
  | HarnessModelComplexity
  | typeof HARNESS_MODEL_WILDCARD;

/**
 * 1 工程 (stage) の振り分け。
 *
 * `*` は「3 段まとめて同じ候補列」の宣言で、個別キーが並んでいればそちらが勝つ。
 * パースの時点で 3 段すべてを解決済みにしておくのは、参照側 (後続チケット) に
 * 「まず個別キーを見て、無ければ `*` に落ちる」フォールバックを再実装させない
 * ため。`*` が無い stage は 3 段すべての宣言を必須にしているので、穴は開かない。
 */
export interface HarnessModelStageRoute {
  readonly stage: string;
  /** 宣言に現れた複雑度キー。UI に出す宣言段数で、`*` 一本は共通扱いになる。 */
  readonly declaredKeys: readonly HarnessModelComplexityKey[];
  readonly low: readonly HarnessModelCandidate[];
  readonly med: readonly HarnessModelCandidate[];
  readonly high: readonly HarnessModelCandidate[];
}

/**
 * member 単位の期限付き除外。チャットで「Cursor を 9/15 まで止めて」と言われたときに、
 * 議長がこの 1 entry を足すだけで振り分け表から一時退避できるようにする (bdboard-p5l.20)。
 *
 * 削除ではなく「期限切れなら自動的に無視」という運用にしているのは、履歴を残して
 * Hygiene に掃除を促すため — 消してしまうと「いつ・なぜ外したか」が失われる。
 */
export interface HarnessModelExclude {
  readonly member: string;
  /** `YYYY-MM-DD` のみ。時刻は持たせない (曖昧さより粗さを採る)。この日を含めて有効。 */
  readonly until: string;
  /** 表示専用。省略可。`verify`/`mainBranch` と同じ untrusted input 扱い。 */
  readonly reason: string | null;
}

export interface HarnessContractModels {
  readonly routes: readonly HarnessModelStageRoute[];
  /** 期限切れ entry も含む生のリスト。期限切れの判定は評価時 (`now` 注入) に行う。 */
  readonly exclude: readonly HarnessModelExclude[];
}

/**
 * UI へ出す要約。**生の候補列は載せない** — 表示に要らないうえ、注入先由来の
 * 文字列を DTO へ広げる理由が無い (`models` の値は run プロンプトにも載せない)。
 */
export interface HarnessModelStageSummary {
  readonly stage: string;
  /** 宣言された複雑度キーの数。`*` 一本なら 1、low/med/high なら 3。 */
  readonly tiers: number;
}

export interface HarnessContract {
  readonly version: typeof HARNESS_CONTRACT_VERSION;
  /** そのプロジェクトのフル検証コマンド。exit 0 が合格、以上の意味は持たせない。 */
  readonly verify: string;
  readonly prFlow: HarnessPrFlow;
  readonly mainBranch: string;
  readonly hooks: HarnessContractHooks | null;
  /** 工程 × 複雑度のモデル振り分け表。未宣言なら null (従来どおりの挙動)。 */
  readonly models: HarnessContractModels | null;
}

export type HarnessContractParseFailureReason = 'invalid-json' | 'schema';

export type ParseHarnessContractResult =
  | { readonly ok: true; readonly contract: HarnessContract }
  | {
      readonly ok: false;
      readonly reason: HarnessContractParseFailureReason;
      readonly message: string;
    };

/**
 * 注入先プロジェクトの検証コントラクトの状態。
 *
 * `not-applicable` は「そもそもパックが注入されていないので問うていない」。
 * 未注入プロジェクトに一斉に警告を出さないための状態で、UI には何も出さない。
 */
export type ContractState =
  | {
      readonly state: 'ok';
      readonly verify: string;
      readonly prFlow: HarnessPrFlow;
      readonly mainBranch: string;
      /** `models` の要約。未宣言なら null。生の候補列はここに出さない。 */
      readonly models: readonly HarnessModelStageSummary[] | null;
      /**
       * `models.exclude` のうち、評価時点 (`now`) で期限切れの件数。0 件なら Hygiene に
       * 何も出さない。削除ではなく無視するだけなので、掃除を促すためにここで数える。
       */
      readonly expiredExcludeCount: number;
      /**
       * 除外により候補列が空になったセルの警告。**`invalid` ではなくここに載せる** —
       * 契約自体は妥当 (member:model の構文は正しい) で、たまたま今アクティブな除外と
       * 突き合わせた結果 0 件になっているだけなので、待遇を分ける。
       */
      readonly modelExclusionWarnings: readonly string[];
    }
  | { readonly state: 'missing' }
  | { readonly state: 'invalid'; readonly message: string }
  | {
      readonly state: 'command-missing';
      readonly script: string;
      readonly verify: string;
    }
  | { readonly state: 'not-applicable' };

/**
 * `verify` が指す package.json の scripts の状態。
 *
 * - `readonly string[]` — 読めた。中身がそのまま script 名の一覧 (`scripts` キーが
 *   無い package.json は空配列 = 「その script は無い」と判定できる)。
 * - `'absent'` — package.json 自体が存在しない。`npm run <script>` は確実に失敗するので
 *   `command-missing` に倒す。
 * - `null` — 存在はするが読めない/壊れている。**判定不能**なので警告しない。
 *
 * 「無い」と「読めない」を分けるのがこの型の全部で、両方 null にすると
 * package.json ごと存在しないプロジェクトの誤宣言を見逃す (PR#282 レビュー minor-1)。
 */
export type VerifyPackageScripts = readonly string[] | 'absent' | null;

export interface HarnessProjectFacts {
  readonly verifyPackageScripts: VerifyPackageScripts;
}
