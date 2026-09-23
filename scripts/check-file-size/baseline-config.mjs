// scripts/check-file-size.mjs から切り出した baseline 設定の読み込みと検証
// (fail-closed: 形式不正は「無視」ではなく実行不能)。bdboard-sso1.58: move-only 分割。
import path from 'node:path';

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveInt(value) {
  return Number.isInteger(value) && value > 0;
}

/** baseline エントリ1件の形式検証。壊れていれば理由の配列を返す (空 = 妥当)。 */
export function validateEntryShape(entry, index) {
  const errors = [];
  const where = `entries[${index}]`;
  if (!isPlainObject(entry)) {
    return [`${where} はオブジェクトである必要があります`];
  }
  const { path: entryPath, limit, reason } = entry;
  if (typeof entryPath !== 'string' || entryPath.length === 0) {
    errors.push(`${where}.path は空でない文字列にしてください`);
  } else if (entryPath.includes('\\')) {
    errors.push(`${where}.path (${entryPath}) はバックスラッシュを含めず POSIX 区切りで書いてください`);
  } else if (entryPath !== path.posix.normalize(entryPath) || entryPath.startsWith('/')) {
    errors.push(`${where}.path (${entryPath}) は正規化された相対パスにしてください`);
  }
  if (!isPositiveInt(limit)) {
    errors.push(`${where}.limit (${String(limit)}) は正の整数にしてください`);
  }
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    errors.push(`${where}.reason は空にできません (中身を見て書いた実態の説明が要る)`);
  }
  return errors;
}

/**
 * baseline JSON テキストを検証・構造化する。エントリの重複パスも fail-closed 対象。
 * 返り値の entries は Map<posix path, {limit, reason}>。
 */
export function parseBaselineConfig(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`baseline JSON の構文が壊れています (${error.message})`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error('baseline JSON はトップレベルがオブジェクトである必要があります');
  }
  const errors = [];
  const { defaultLimits, ratchetWarningThreshold, entries } = parsed;
  if (!isPlainObject(defaultLimits) || !isPositiveInt(defaultLimits.nonTest) || !isPositiveInt(defaultLimits.test)) {
    errors.push('defaultLimits.nonTest / defaultLimits.test は正の整数にしてください');
  }
  if (!isPositiveInt(ratchetWarningThreshold)) {
    errors.push('ratchetWarningThreshold は正の整数にしてください');
  }
  if (!Array.isArray(entries)) {
    errors.push('entries は配列である必要があります');
  }

  const entryMap = new Map();
  if (Array.isArray(entries)) {
    entries.forEach((entry, index) => {
      const entryErrors = validateEntryShape(entry, index);
      if (entryErrors.length > 0) {
        errors.push(...entryErrors);
        return;
      }
      if (entryMap.has(entry.path)) {
        errors.push(`entries に ${entry.path} が重複しています`);
        return;
      }
      entryMap.set(entry.path, { limit: entry.limit, reason: entry.reason });
    });
  }

  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }

  return {
    defaultLimits: { nonTest: defaultLimits.nonTest, test: defaultLimits.test },
    ratchetWarningThreshold,
    entries: entryMap,
  };
}
