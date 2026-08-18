import type { CommandRunner } from '../../application/ports/command-runner.js';
import type {
  AiQuotaMetric,
  AiQuotaProviderSnapshot,
  AiQuotaSource,
  AiQuotaSourceResult,
} from '../../application/ports/ai-quota-source.js';

// `ai-quota all` は自動取得対象の agy と codex を順番に probe する。両方の ready + panel
// 時間を合わせると50秒強になり得るため、プロセス終了処理の余裕も含めて広めに取る。
const DEFAULT_TIMEOUT_MS = 70_000;
const DEFAULT_COMMAND = 'ai-quota';

export interface NodeAiQuotaSourceOptions {
  readonly command?: string;
  /** 既定は `all`。登録済みの全プロバイダについて、ライブ値または確認方法を取得する。 */
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
}

interface ProviderBlock {
  readonly header: string;
  readonly lines: readonly string[];
}

interface ParsedBlockContent {
  readonly plan?: string;
  readonly metrics: readonly AiQuotaMetric[];
  readonly availability: AiQuotaProviderSnapshot['availability'];
  /** `ai-quota` が出した確認方法だけを保持し、probe例外の原文は返さない。 */
  readonly detail?: string;
}

function extractProviderBlocks(stdout: string): readonly ProviderBlock[] {
  const blocks: ProviderBlock[] = [];
  let current: { header: string; lines: string[] } | null = null;

  for (const rawLine of stdout.split('\n')) {
    if (rawLine.startsWith('## ')) {
      if (current !== null) {
        blocks.push(current);
      }
      current = { header: rawLine.slice(3).trim(), lines: [] };
      continue;
    }

    if (current === null) {
      continue;
    }

    // ブロック本文は常に2スペース以上のインデント付きで出力される。インデント無しの
    // 行(例: "ほかの連携AI（確認方法）:")に当たったら、そこでブロックのスコープを抜ける。
    if (rawLine.length > 0 && !rawLine.startsWith(' ')) {
      blocks.push(current);
      current = null;
      continue;
    }

    current.lines.push(rawLine);
  }

  if (current !== null) {
    blocks.push(current);
  }

  return blocks;
}

function parseHeader(header: string): {
  readonly id: string;
  readonly label: string;
  readonly vendor?: string;
} {
  const separator = ' — ';
  const sepIndex = header.indexOf(separator);
  if (sepIndex === -1) {
    return { id: header.trim(), label: header.trim() };
  }

  const id = header.slice(0, sepIndex).trim();
  const rest = header.slice(sepIndex + separator.length).trim();

  const vendorMatch = rest.match(/^(.+)\s\(([^()]+)\)$/);
  if (vendorMatch) {
    return { id, label: vendorMatch[1].trim(), vendor: vendorMatch[2].trim() };
  }

  return { id, label: rest };
}

function parseDurationMs(text: string): number | undefined {
  const re = /(\d+)\s*(d|h|m|s)\b/gi;
  let match: RegExpExecArray | null;
  let totalMs = 0;
  let found = false;

  while ((match = re.exec(text)) !== null) {
    found = true;
    const value = Number(match[1]);
    const unit = match[2].toLowerCase();
    const unitMs =
      unit === 'd' ? 86_400_000 : unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : 1_000;
    totalMs += value * unitMs;
  }

  return found ? totalMs : undefined;
}

function parseAbsoluteResetAt(text: string, fetchedAt: Date): Date | undefined {
  const match = text.match(
    /^(\d{1,2}):(\d{2})\s*(AM|PM)(?:\s+on\s+([A-Za-z]{3})\s+(\d{1,2}))?$/i,
  );
  if (!match) {
    return undefined;
  }

  let hour = Number(match[1]) % 12;
  if (match[3].toUpperCase() === 'PM') {
    hour += 12;
  }
  const minute = Number(match[2]);
  const monthNames = [
    'jan',
    'feb',
    'mar',
    'apr',
    'may',
    'jun',
    'jul',
    'aug',
    'sep',
    'oct',
    'nov',
    'dec',
  ];
  const month = match[4]?.toLowerCase();
  const monthIndex = month === undefined ? fetchedAt.getMonth() : monthNames.indexOf(month);
  if (monthIndex < 0) {
    return undefined;
  }

  const day = match[5] === undefined ? fetchedAt.getDate() : Number(match[5]);
  const resetAt = new Date(fetchedAt.getFullYear(), monthIndex, day, hour, minute, 0, 0);
  if (Number.isNaN(resetAt.getTime())) {
    return undefined;
  }

  if (resetAt.getTime() <= fetchedAt.getTime()) {
    if (match[4] === undefined) {
      resetAt.setDate(resetAt.getDate() + 1);
    } else {
      resetAt.setFullYear(resetAt.getFullYear() + 1);
    }
  }
  return resetAt;
}

function parseBlockContent(lines: readonly string[], fetchedAt: Date): ParsedBlockContent {
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

export function parseAiQuotaOutput(
  stdout: string,
  fetchedAt: Date,
): readonly AiQuotaProviderSnapshot[] {
  const blocks = extractProviderBlocks(stdout);
  const providers: AiQuotaProviderSnapshot[] = [];

  for (const block of blocks) {
    const { id, label, vendor } = parseHeader(block.header);
    const content = parseBlockContent(block.lines, fetchedAt);

    providers.push({
      id,
      label,
      ...(vendor !== undefined ? { vendor } : {}),
      ...(content.plan !== undefined ? { plan: content.plan } : {}),
      availability: content.availability,
      ...(content.detail !== undefined ? { detail: content.detail } : {}),
      metrics: content.metrics,
    });
  }

  return providers;
}

export function createNodeAiQuotaSource(
  commandRunner: CommandRunner,
  options?: NodeAiQuotaSourceOptions,
): AiQuotaSource {
  const command = options?.command ?? DEFAULT_COMMAND;
  const args = options?.args ?? ['all'];
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async fetch(): Promise<AiQuotaSourceResult> {
      const result = await commandRunner.run(command, args, { timeoutMs });
      const fetchedAt = new Date();

      if (result.exitCode !== 0) {
        // stderr/stdout はCLIや環境によってローカルパス・アカウント情報を含み得るため、
        // APIへ伝播させない。
        throw new Error(`ai-quota exited with code ${result.exitCode}`);
      }

      const providers = parseAiQuotaOutput(result.stdout, fetchedAt);
      if (providers.length === 0) {
        throw new Error('ai-quota returned no provider data');
      }
      return { fetchedAt, providers };
    },
  };
}
