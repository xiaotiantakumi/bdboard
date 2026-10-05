// bdboard-07q8: PR のタイトルから gate が作る squash の件名 (`<title> (#N)`) が conventional commit かの機械チェック。
//
// 事故 (2026-10-06): `gh pr create --fill` が複数コミットのブランチでブランチ名 (bd/bdboard 4y8q.6.4) を PR のタイトルにし、
// prepare は 9 分の着地予定ツリーの verify を通し、gate は `--subject 'bd/bdboard 4y8q.6.4 (#920)'` を印字した。そのまま
// 打つと main に conventional commit でない件名が入り、release-please の CHANGELOG から黙って落ちる (2026-09-04 の括弧の
// 事故と同じ類)。gate 後は gate をやり直せない (枠を持っている) ので、直すなら finish → prepare で verify 1 回分が無駄になる。
//
// 規則は新しく書かない: `npm run check:commits` (scripts/check-commit-parse.mjs) と同じ。release-please と同じパーサが解析でき
// (checkCommitMessage)、かつ `type(scope)!: 説明` の形 (isConventionalSubject) であること。
// prepare は assertOpenPull の直後 (レビュー記録・必須チェック・分類・着地予定ツリーの verify より前) に、gate は assertOpenPull の
// 直後 (層 3 の待ち・枠の取得より前 = 枠をまだ持っていないので返すものが無い) に呼ぶ。検査する件名と gate が印字する件名は
// 同じ squashSubject で、同じ PR 読み取り (pull) から作る。
//
// 検査器 (@conventional-commits/parser を含む check-commit-parse) は動的 import する。scripts/merge-pr.mjs は枠を返す finish と同じ
// 入口なので、依存が無い環境でも finish が import で落ちてはいけない。読み込めなければ fail-closed (EXIT.USAGE) — 検査できない
// 件名を黙って通さない。
import { EXIT, fail, ticketIdFor } from './context.mjs';
import { audit } from './state.mjs';

/**
 * gate が `gh pr merge --subject` に渡す件名。改行・連続空白は 1 個の空白に潰す (印字は必ず 1 行)。
 * mergeCommand (gate.mjs) と検査の両方がこれを使う。
 */
export function squashSubject(pr, title) {
  return `${String(title ?? '').replace(/\s+/g, ' ').trim()} (#${pr})`;
}

/** check:commits と同じ規則の部品を読み込む。読み込めなければ throw。 */
export async function loadTitleRules() {
  const { checkCommitMessage, isConventionalSubject } = await import('../check-commit-parse.mjs');
  return { checkCommitMessage, isConventionalSubject };
}

/**
 * 件名の問題。無ければ null、あれば理由の文字列の配列 (形とパーサ。両方当たれば両方)。
 */
export function subjectProblem(subject, rules) {
  const problems = [];
  if (!rules.isConventionalSubject(subject)) {
    problems.push('type(scope): 説明 の形ではありません (type と : の後ろに半角空白が必要です)');
  }
  const parsed = rules.checkCommitMessage(subject);
  if (!parsed.ok) {
    problems.push(`release-please のパーサが解析できません: ${parsed.parserMessage}`);
  }
  return problems.length === 0 ? null : problems;
}

/** 止めたときの案内。phase は 'prepare' | 'gate' (どこからやり直すかが違う)。 */
export function titleSteps({ pr, id, subject, problems, phase }) {
  const fixId = id.startsWith('pr-') ? '<ticket-id>' : id;
  const lines = [
    `PR #${pr} のタイトルから作る squash の件名が conventional commit ではありません: ${subject}`,
    ...problems.map((problem) => `  - ${problem}`),
    'このまま main に入ると release-please が CHANGELOG に載せられません (規則は npm run check:commits と同じ)。',
    'タイトルを直してください (head は変わらないので push も CI のやり直しも要りません):',
    `  gh pr edit ${pr} --title "<type>(${fixId}): <英語の要約>"`,
  ];
  if (phase === 'prepare') {
    lines.push(`直したら: npm run merge-pr -- prepare ${pr}`);
  } else {
    lines.push(`直したら: 枠はまだ取っていません。prepare の記録は残っているので、そのまま BDBOARD_MERGER=chair npm run merge-pr -- gate ${pr}`);
  }
  return lines;
}

/**
 * PR のタイトルから作る squash の件名が conventional commit でなければ止める (EXIT.PRECONDITION)。
 * 検査器を読み込めないときも止める (EXIT.USAGE。検査できない件名は通さない)。
 * loadRules はテストが「読み込めない」を作るための差し込み口。
 */
export async function assertConventionalTitle(pull, pr, { phase, loadRules = loadTitleRules } = {}) {
  const subject = squashSubject(pr, pull.title);
  const id = ticketIdFor(pull.headRef, pr);
  let rules;
  try {
    rules = await loadRules();
  } catch (error) {
    audit(`${phase}-title-unchecked`, { pr, id, subject });
    fail(
      EXIT.USAGE,
      `PR タイトルの検査規則 (scripts/check-commit-parse.mjs) を読み込めませんでした: ${error instanceof Error ? error.message : String(error)}`,
      'npm install (worktree のルート) で依存を入れてから、同じコマンドをやり直してください。',
    );
  }
  const problems = subjectProblem(subject, rules);
  if (problems !== null) {
    audit(`${phase}-title-refused`, { pr, id, subject });
    fail(EXIT.PRECONDITION, ...titleSteps({ pr, id, subject, problems, phase }));
  }
}
