// scripts/check-file-size.mjs から切り出した結果の表示整形。bdboard-sso1.58: move-only 分割。
import { CONFIG_RELATIVE_PATH } from './constants.mjs';

function formatFinding(prefix, lines) {
  return lines.map((line) => `file-size:   ${line}`).join('\n');
}

export function formatResult(evaluation, { report = false } = {}) {
  const {
    newOverLimit,
    overOwnLimit,
    shrunkBelowDefault,
    missingFiles,
    ratchetWarnings,
    ratchetWarningThreshold,
    ok,
  } = evaluation;
  const parts = [];
  const total =
    newOverLimit.length + overOwnLimit.length + shrunkBelowDefault.length + missingFiles.length;

  if (total === 0) {
    parts.push('file-size: 巨大ファイルの新規発生・baseline 超過はありません。');
  } else {
    parts.push(`file-size: 対処が要る項目が ${total} 件あります。`);
  }

  if (newOverLimit.length > 0) {
    parts.push(
      `file-size: (a) baseline 未登録で既定上限を超えている新規/未追跡ファイル ${newOverLimit.length} 件:`,
    );
    parts.push(
      formatFinding(
        'a',
        newOverLimit.map(
          (f) =>
            `${f.path} (${f.lines} 行 > 既定上限 ${f.defaultLimit} 行) — 分割するか、理由を添えて ${CONFIG_RELATIVE_PATH} に登録してください`,
        ),
      ),
    );
  }

  if (overOwnLimit.length > 0) {
    parts.push(`file-size: (b) baseline の limit を超えているファイル ${overOwnLimit.length} 件:`);
    parts.push(
      formatFinding(
        'b',
        overOwnLimit.map(
          (f) =>
            `${f.path} (${f.lines} 行 > baseline limit ${f.limit} 行) — 分割するか、${CONFIG_RELATIVE_PATH} の limit と reason を書き換えてください`,
        ),
      ),
    );
  }

  if (shrunkBelowDefault.length > 0) {
    parts.push(
      `file-size: (c) baseline にあるが既定上限以下まで縮んだファイル ${shrunkBelowDefault.length} 件:`,
    );
    parts.push(
      formatFinding(
        'c',
        shrunkBelowDefault.map(
          (f) =>
            `${f.path} (${f.lines} 行 <= 既定上限 ${f.defaultLimit} 行、baseline limit ${f.limit} 行) — ${CONFIG_RELATIVE_PATH} の entries から外してください`,
        ),
      ),
    );
  }

  if (missingFiles.length > 0) {
    parts.push(
      `file-size: (c) baseline にあるが対象ファイルが見つからないもの ${missingFiles.length} 件 (削除 / リネーム / 対象ディレクトリ外への移動):`,
    );
    parts.push(
      formatFinding(
        'c',
        missingFiles.map(
          (f) => `${f.path} (baseline limit ${f.limit} 行) — ${CONFIG_RELATIVE_PATH} の entries から外してください`,
        ),
      ),
    );
  }

  if (ratchetWarnings.length > 0) {
    parts.push(
      `file-size: (d) 警告 — baseline の limit が現行行数より ${ratchetWarningThreshold} 行以上大きく、ラチェットを締める余地があります (${ratchetWarnings.length} 件、非fatal):`,
    );
    parts.push(
      formatFinding(
        'd',
        ratchetWarnings.map(
          (f) => `${f.path} (現行 ${f.lines} 行、limit ${f.limit} 行、差 ${f.gap} 行)`,
        ),
      ),
    );
  }

  if (report) {
    const rows = [
      ...ok.map((r) => ({ path: r.path, lines: r.lines, limit: r.baseline?.limit ?? r.defaultLimit, hasBaseline: r.baseline != null })),
      ...newOverLimit.map((f) => ({ path: f.path, lines: f.lines, limit: f.defaultLimit, hasBaseline: false })),
      ...overOwnLimit.map((f) => ({ path: f.path, lines: f.lines, limit: f.limit, hasBaseline: true })),
      ...shrunkBelowDefault.map((f) => ({ path: f.path, lines: f.lines, limit: f.limit, hasBaseline: true })),
    ].sort((x, y) => y.lines - x.lines);
    parts.push(`file-size: --report 一覧 (行数降順、${rows.length} 件):`);
    parts.push(
      rows
        .map((r) => `file-size:   ${r.lines}\t${r.hasBaseline ? `baseline limit=${r.limit}` : '(baseline無し)'}\t${r.path}`)
        .join('\n'),
    );
  }

  return parts.join('\n');
}
