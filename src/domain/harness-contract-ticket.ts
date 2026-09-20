import {
  HARNESS_CONTRACT_RELATIVE_PATH,
  HARNESS_CONTRACT_VERSION,
  type ContractState,
  type VerifyPackageScripts,
} from './harness-contract.js';

/**
 * 検証コントラクト不足を直すチケットに付ける固定ラベル。冪等性チェック
 * (同ラベルの open チケットが既にあれば作らない) と起票時の分類の両方に使う
 * (bdboard-p5l.25)。
 */
export const HARNESS_CONTRACT_TICKET_LABEL = 'harness-contract';
export const HARNESS_CONTRACT_TICKET_TYPE = 'task';
export const HARNESS_CONTRACT_TICKET_PRIORITY = 2;

/**
 * 起票時/最後に state 変化を追記した時点の契約 state を記録する bd メタデータキー
 * (bdboard-13mp)。ラベルは state ごとに分けず `HARNESS_CONTRACT_TICKET_LABEL` を
 * 使い回すため、「このチケットが最後にどの state 向けだったか」はこのキーでだけ
 * 判別できる。キーの無い旧チケット (この仕組みが導入される前に起票されたもの) は
 * 「state 不明」として扱う — 判定は application 層の責務。
 */
export const HARNESS_CONTRACT_TICKET_STATE_METADATA_KEY = 'bdboard.harness_contract.state';

export interface HarnessContractTicketContent {
  readonly title: string;
  readonly description: string;
}

/** 名前だけでそれらしいと判定する verify 候補 (中身までは読まない)。 */
const CANDIDATE_VERIFY_SCRIPT_NAMES = ['verify', 'ci', 'check'] as const;
/** 単体では verify っぽくないが、複数揃えば「一通り検証した」とみなせる script 名。 */
const CANDIDATE_COMPONENT_SCRIPT_NAMES = ['build', 'lint', 'typecheck', 'test'] as const;

/**
 * package.json の scripts **名前だけ**から verify コマンドの候補を推測する。
 * 中身 (実コマンド) までは読まない — 詮索しすぎず「名前が verify っぽい script が
 * あればそれを勧める」「build/test 等が複数揃っていれば繋いで勧める」程度に留める。
 * 判定できなければ null (呼び出し側はテンプレートにプレースホルダを残す)。
 */
export function suggestVerifyCommand(scripts: VerifyPackageScripts): string | null {
  if (scripts === null || scripts === 'absent' || scripts.length === 0) {
    return null;
  }
  const scriptSet = new Set(scripts);
  for (const name of CANDIDATE_VERIFY_SCRIPT_NAMES) {
    if (scriptSet.has(name)) {
      return `npm run ${name}`;
    }
  }
  const present = CANDIDATE_COMPONENT_SCRIPT_NAMES.filter((name) => scriptSet.has(name));
  if (present.length >= 2) {
    return present.map((name) => `npm run ${name}`).join(' && ');
  }
  return null;
}

function buildMissingContractTemplate(verifySuggestion: string | null): string {
  const verify = verifySuggestion ?? '<検証コマンド (exit 0 が合格)>';
  // version はハードコードせず HARNESS_CONTRACT_VERSION を参照する — 将来この定数が
  // 上がったときに、テンプレートだけ古いバージョンを勧めてパーサに弾かれる事故を防ぐ
  // (レビュー指摘)。
  return JSON.stringify(
    { version: HARNESS_CONTRACT_VERSION, verify, prFlow: 'pr', mainBranch: 'main' },
    null,
    2,
  );
}

function buildMissingContent(
  rootPackageScripts: VerifyPackageScripts,
): HarnessContractTicketContent {
  const suggestion = suggestVerifyCommand(rootPackageScripts);
  const suggestionLine =
    suggestion !== null
      ? `package.json の scripts から推測した verify 候補: \`${suggestion}\`` +
        ' (そのまま使えるか確認してください)'
      : 'package.json の scripts から verify 候補を推測できませんでした。' +
        'プロジェクトのフルの検証コマンド (exit 0 が合格) を verify に指定してください。';

  return {
    title: 'ハーネス: 検証コントラクト (.claude/bdboard-harness.json) を作成する',
    description: [
      `${HARNESS_CONTRACT_RELATIVE_PATH} が見つかりません。bdboard はこの状態を` +
        ' Hygiene に「検証ループ未定義」として警告し、エージェント実行の実行ボタンも' +
        ' 押せなくなります。',
      '',
      suggestionLine,
      '',
      '以下のテンプレートを元にプロジェクトルートへ作成してください:',
      '',
      '```json',
      buildMissingContractTemplate(suggestion),
      '```',
      '',
      '- version: 1 固定',
      '- verify: フルの検証コマンド (exit 0 が合格。プロジェクトに合わせて調整してください)',
      '- prFlow: pr (PR必須) / direct (main直コミット可) / none (git運用なし) のいずれか',
      '- mainBranch: 省略可 (既定 main)',
    ].join('\n'),
  };
}

function buildInvalidContent(message: string): HarnessContractTicketContent {
  return {
    title: 'ハーネス: 検証コントラクト (.claude/bdboard-harness.json) のスキーマ不正を直す',
    description: [
      `${HARNESS_CONTRACT_RELATIVE_PATH} の内容がスキーマとして解釈できません:`,
      '',
      message,
      '',
      'version / verify / prFlow / mainBranch の型・値を見直して修正してください' +
        ' (version は 1 固定、verify は改行を含まない空でない1行の文字列、' +
        ' prFlow は pr / direct / none のいずれか)。',
    ].join('\n'),
  };
}

function buildCommandMissingContent(
  script: string,
  verify: string,
): HarnessContractTicketContent {
  return {
    title: 'ハーネス: 検証コントラクトの verify が指す npm script を直す',
    description: [
      `検証コントラクト (${HARNESS_CONTRACT_RELATIVE_PATH}) の verify が指す npm script` +
        ` "${script}" が package.json に見つかりません (verify = "${verify}")。`,
      '',
      '次のいずれかで直してください:',
      `- package.json の scripts に "${script}" を追加する`,
      '- verify を実在する script を指すコマンドに変更する',
    ].join('\n'),
  };
}

/**
 * 検証コントラクトの状態から起票するチケットの中身を組み立てる。
 *
 * `ok` / `not-applicable` はそもそも直すことが無いので null。呼び出し側
 * (application 層) はこれを「チケット不要」の合図として扱う。
 *
 * @param rootPackageScripts `missing` 状態のときだけ使う、プロジェクトルートの
 *   package.json の scripts 名一覧 (verify 候補の推測用)。他の状態では無視する
 *   (command-missing は ContractState 自身が script/verify を持っている)。
 */
export function buildHarnessContractTicketContent(
  contract: ContractState,
  rootPackageScripts: VerifyPackageScripts,
): HarnessContractTicketContent | null {
  switch (contract.state) {
    case 'ok':
    case 'not-applicable':
      return null;
    case 'missing':
      return buildMissingContent(rootPackageScripts);
    case 'invalid':
      return buildInvalidContent(contract.message);
    case 'command-missing':
      return buildCommandMissingContent(contract.script, contract.verify);
  }
}

/**
 * state 遷移をまたいだ陳腐化チケットの扱い (bdboard-13mp)。既存の
 * `HARNESS_CONTRACT_TICKET_LABEL` 付き未クローズチケットを見つけたが、起票時/
 * 最後に追記した state (`HARNESS_CONTRACT_TICKET_STATE_METADATA_KEY` の値) が
 * 現在の state と違うときに追記するコメント本文を組み立てる。
 *
 * 本文は `buildHarnessContractTicketContent` (起票時と同じビルダー) をそのまま
 * 再利用する — 「いま必要な対処」の文面を state ごとに2箇所へ書かない。
 * `ok` / `not-applicable` は (呼び出し元がその時点でチケットを起票/追記しない
 * 状態なので) content が null になり、この関数も null を返す。
 *
 * **文字数上限に注意**: この文字列は `bd comment` (bd-tool-catalog の `bd_comment`,
 * 上限 2000 文字) 経由で送るのに対し、`buildHarnessContractTicketContent` は
 * チケット起票 (`bd create --stdin`, 上限無し) にも使われる。現状の各 state の
 * 生成量 (missing 500字台 / invalid 200字台+メッセージ / command-missing 250字台、
 * いずれも `CONTRACT_ECHO_MAX_LENGTH` 等で頭打ち) は上限に対して十分な余裕がある
 * (レビュー確認済み) が、テンプレートを拡張するときはこの非対称 — 起票は通っても
 * 追記だけ失敗する — を踏まないよう長さを意識すること。
 */
export function buildHarnessContractTicketStateChangeComment(
  contract: ContractState,
  rootPackageScripts: VerifyPackageScripts,
): string | null {
  const content = buildHarnessContractTicketContent(contract, rootPackageScripts);
  if (content === null) {
    return null;
  }
  return [
    `現在の状態は ${contract.state} です。いま必要な対処:`,
    '',
    content.description,
  ].join('\n');
}
