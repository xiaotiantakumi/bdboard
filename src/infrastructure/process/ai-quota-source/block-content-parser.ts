import type { AiQuotaMetric } from '../../../application/ports/ai-quota-source.js';
import { parseAbsoluteResetAt, parseDurationMs } from './duration-parsing.js';
import type { ParsedBlockContent } from './types.js';

export function parseBlockContent(lines: readonly string[], fetchedAt: Date): ParsedBlockContent {
  let plan: string | undefined;
  let currentGroup: string | undefined;
  let pendingLabel: string | undefined;
  let autoFailed = false;
  let manualOnly = false;
  let detail: string | undefined;
  const metrics: AiQuotaMetric[] = [];

  for (const rawLine of lines) {
    // TUIの枠線が残るCLIもあるため、左右端の罫線だけを除去してから解釈する。
    const line = rawLine.trim().replace(/^[│┃]\s*/, '').replace(/\s*[│┃]$/, '').trim();
    if (line.length === 0) {
      continue;
    }

    // "Account: example-user@gmail.com  [Google AI Pro]" のようなアカウント行は、
    // プラン名だけ拾ってメールアドレス等は一切保持しない。
    const accountWithPlan = line.match(/^Account:.*\[([^\]]+)\]\s*$/i);
    if (accountWithPlan) {
      plan = accountWithPlan[1].trim();
      continue;
    }
    if (/^Account:/i.test(line)) {
      continue;
    }

    const failMatch = line.match(/^\(自動取得に失敗: (.+)\)$/);
    if (failMatch) {
      // 例外本文は将来CLI側がアカウント名やパスを含める可能性があるため保持しない。
      autoFailed = true;
      continue;
    }

    const liveFallbackMatch = line.match(/^\(ライブ取得できず\)\s*確認方法:\s*(.+)$/);
    if (liveFallbackMatch) {
      autoFailed = true;
      detail = `ライブ取得できず。確認方法: ${liveFallbackMatch[1].trim()}`;
      continue;
    }

    const manualMatch = line.match(/^確認方法:\s*(.+)$/);
    if (manualMatch) {
      manualOnly = true;
      detail = `自動取得未対応。確認方法: ${manualMatch[1].trim()}`;
      continue;
    }

    if (line.startsWith('Models within this group:')) {
      continue;
    }

    if (/MODELS$/.test(line) && line === line.toUpperCase()) {
      currentGroup = line;
      continue;
    }

    const usageGroupMatch = line.match(/^Usage limits?(?::\s*(.+))?$/i);
    if (usageGroupMatch) {
      currentGroup = usageGroupMatch[1]?.trim();
      continue;
    }

    const namedLimitGroupMatch = line.match(/^(.+?)\s+limit:?$/i);
    if (
      namedLimitGroupMatch &&
      !/^(?:5h|weekly|hourly)$/i.test(namedLimitGroupMatch[1]) &&
      !/^monthly credit$/i.test(namedLimitGroupMatch[1])
    ) {
      currentGroup = namedLimitGroupMatch[1].trim();
      continue;
    }

    const creditMatch = line.match(/^(Credits|Monthly credit limit):\s*(.+)$/i);
    if (creditMatch) {
      const label = currentGroup ? `${currentGroup} ${creditMatch[1]}` : creditMatch[1];
      metrics.push({ label, valueText: creditMatch[2].trim() });
      continue;
    }

    if (/^\d+(?:\.\d+)?\s+of\s+\d+(?:\.\d+)?\s+credits?\s+used$/i.test(line)) {
      const label = currentGroup ? `${currentGroup} Credits` : 'Credits';
      metrics.push({ label, valueText: line });
      continue;
    }

    if (/Limit Remaining$/i.test(line) || /^(?:5h|weekly|hourly)\s+limit:?$/i.test(line)) {
      const limitLabel = line.replace(/:$/, '');
      pendingLabel = currentGroup ? `${currentGroup} ${limitLabel}` : limitLabel;
      continue;
    }

    // agy: "92% remaining · Refreshes in 88h 21m"
    // codex: "5h limit: 93% left (resets 2:43 PM)"（装飾バーが間に入る場合もある）
    const percentMatch = line.match(/(\d{1,3})%\s*(?:remaining|left)\b/i);
    if (percentMatch) {
      const percentRemaining = Number(percentMatch[1]);
      if (percentRemaining > 100) {
        continue;
      }

      const inlinePrefix = line
        .slice(0, percentMatch.index)
        .replace(/\s*\[[^\]]*\]\s*$/, '')
        .replace(/:\s*$/, '')
        .trim();
      const label =
        pendingLabel ?? (currentGroup ? `${currentGroup} ${inlinePrefix}` : inlinePrefix);
      if (label.length === 0) {
        continue;
      }

      const resetMatch = line.match(/(?:Refreshes|Resets)(?:\s+in)?\s+(.+?)\)?$/i);
      const resetInText = resetMatch?.[1]?.trim();
      const durationMs = resetInText !== undefined ? parseDurationMs(resetInText) : undefined;
      const resetAt =
        durationMs !== undefined
          ? new Date(fetchedAt.getTime() + durationMs)
          : resetInText !== undefined
            ? parseAbsoluteResetAt(resetInText, fetchedAt)
            : undefined;
      metrics.push({
        label,
        percentRemaining,
        ...(resetInText !== undefined ? { resetInText } : {}),
        ...(resetAt !== undefined ? { resetAt } : {}),
      });
      pendingLabel = undefined;
      continue;
    }

    if (/^Quota available$/i.test(line) && pendingLabel !== undefined) {
      metrics.push({ label: pendingLabel, status: 'available' });
      pendingLabel = undefined;
      continue;
    }

    if (/^Quota exhausted$/i.test(line) && pendingLabel !== undefined) {
      metrics.push({ label: pendingLabel, status: 'exhausted' });
      pendingLabel = undefined;
      continue;
    }

    // 未知の行は将来のフォーマット変更に対する耐性のため黙って無視する。
  }

  return {
    ...(plan !== undefined ? { plan } : {}),
    metrics,
    availability:
      metrics.length > 0 ? 'live' : manualOnly && !autoFailed ? 'manual' : 'unavailable',
    ...(detail !== undefined
      ? { detail }
      : autoFailed
        ? { detail: 'ライブ取得に失敗しました。対象CLI内のクォータ画面で確認してください。' }
        : manualOnly
          ? { detail: '自動取得未対応です。対象サービスで手動確認してください。' }
          : metrics.length === 0
            ? { detail: 'このプロバイダの数値メトリクスを取得できませんでした。' }
            : {}),
  };
}
