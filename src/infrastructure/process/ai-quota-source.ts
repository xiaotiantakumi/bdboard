import type { CommandRunner } from '../../application/ports/command-runner.js';
import type {
  AiQuotaMetric,
  AiQuotaProviderSnapshot,
  AiQuotaSource,
  AiQuotaSourceResult,
} from '../../application/ports/ai-quota-source.js';

// agyの自動取得(pty経由でTUIの/quotaを叩く)はready 8s + panel 12s程度かかる。将来
// AUTO_DEFAULTにプロバイダが増えても余裕を持たせるため広めに取ってある。
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_COMMAND = 'ai-quota';

export interface NodeAiQuotaSourceOptions {
  readonly command?: string;
  /** 既定は引数なし(bare)呼び出し。AUTO_DEFAULT([agy])だけを高速に取得し、
   *  それ以外は「確認方法」の案内テキストになる(構造化データとしては無視される)。 */
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
  /** プロバイダ側のprobeが例外を投げた場合の原文メッセージ(ツール由来、機密は含まれない想定) */
  readonly errorMessage?: string;
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

function parseBlockContent(lines: readonly string[], fetchedAt: Date): ParsedBlockContent {
  let plan: string | undefined;
  let currentGroup: string | undefined;
  let pendingLabel: string | undefined;
  let errorMessage: string | undefined;
  const metrics: AiQuotaMetric[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
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
      errorMessage = failMatch[1];
      continue;
    }

    if (/^\(ライブ取得できず\)/.test(line) || /^確認方法:/.test(line)) {
      // 手動確認のみのプロバイダ、またはauto probeがライブ取得できなかった場合。
      // 数値データが無いのでメトリクスとしては扱わない。
      continue;
    }

    if (line.startsWith('Models within this group:')) {
      continue;
    }

    if (/MODELS$/.test(line) && line === line.toUpperCase()) {
      currentGroup = line;
      continue;
    }

    if (/Limit Remaining$/i.test(line)) {
      pendingLabel = currentGroup ? `${currentGroup} ${line}` : line;
      continue;
    }

    const percentMatch = line.match(
      /^(\d{1,3})%\s*remaining(?:\s*·\s*Refreshes in\s*(.+))?$/i,
    );
    if (percentMatch && pendingLabel !== undefined) {
      const percentRemaining = Number(percentMatch[1]);
      const resetInText = percentMatch[2]?.trim();
      const durationMs = resetInText !== undefined ? parseDurationMs(resetInText) : undefined;
      metrics.push({
        label: pendingLabel,
        percentRemaining,
        ...(resetInText !== undefined ? { resetInText } : {}),
        ...(durationMs !== undefined
          ? { resetAt: new Date(fetchedAt.getTime() + durationMs) }
          : {}),
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
    ...(errorMessage !== undefined ? { errorMessage } : {}),
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

    // errorMessage(自動取得に失敗)、または数値メトリクスが1つも取れなかった(=手動確認のみ)
    // プロバイダはウィジェットに出す情報が無いので結果から除外する。
    if (content.errorMessage !== undefined || content.metrics.length === 0) {
      continue;
    }

    providers.push({
      id,
      label,
      ...(vendor !== undefined ? { vendor } : {}),
      ...(content.plan !== undefined ? { plan: content.plan } : {}),
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
  const args = options?.args ?? [];
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async fetch(): Promise<AiQuotaSourceResult> {
      const result = await commandRunner.run(command, args, { timeoutMs });
      const fetchedAt = new Date();

      if (result.exitCode !== 0) {
        const detail = (result.stderr || result.stdout || '').trim().slice(0, 500);
        throw new Error(
          `ai-quota exited with code ${result.exitCode}${detail.length > 0 ? `: ${detail}` : ''}`,
        );
      }

      const providers = parseAiQuotaOutput(result.stdout, fetchedAt);
      return { fetchedAt, providers };
    },
  };
}
