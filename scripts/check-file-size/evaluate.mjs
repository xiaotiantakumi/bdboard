// scripts/check-file-size.mjs から切り出した判定本体。bdboard-sso1.58: move-only 分割。

/**
 * 走査結果 (records) と baseline を突き合わせ、(a)〜(d) に分類する。純関数。
 */
export function evaluate(records, config) {
  const { defaultLimits, ratchetWarningThreshold, entries } = config;
  const newOverLimit = [];
  const overOwnLimit = [];
  const shrunkBelowDefault = [];
  const ratchetWarnings = [];
  const ok = [];
  const seen = new Set();

  for (const record of records) {
    const defaultLimit = record.isTest ? defaultLimits.test : defaultLimits.nonTest;
    const baseline = entries.get(record.path);

    if (!baseline) {
      if (record.lines > defaultLimit) {
        newOverLimit.push({ path: record.path, lines: record.lines, defaultLimit });
      } else {
        ok.push({ ...record, defaultLimit, baseline: null });
      }
      continue;
    }

    seen.add(record.path);
    if (record.lines > baseline.limit) {
      overOwnLimit.push({ path: record.path, lines: record.lines, limit: baseline.limit });
    } else if (record.lines <= defaultLimit) {
      shrunkBelowDefault.push({
        path: record.path,
        lines: record.lines,
        limit: baseline.limit,
        defaultLimit,
      });
    } else {
      ok.push({ ...record, defaultLimit, baseline });
      const gap = baseline.limit - record.lines;
      if (gap >= ratchetWarningThreshold) {
        ratchetWarnings.push({ path: record.path, lines: record.lines, limit: baseline.limit, gap });
      }
    }
  }

  // baseline にあるのに今回の走査結果に一度も現れなかった = 削除 / リネーム / 対象外化。
  const missingFiles = [];
  for (const [entryPath, entry] of entries) {
    if (!seen.has(entryPath)) {
      missingFiles.push({ path: entryPath, limit: entry.limit });
    }
  }

  return {
    newOverLimit,
    overOwnLimit,
    shrunkBelowDefault,
    missingFiles,
    ratchetWarnings,
    ratchetWarningThreshold,
    ok,
  };
}
