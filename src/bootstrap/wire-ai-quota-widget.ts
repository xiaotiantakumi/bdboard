/**
 * bdboard-sso1.14: src/main.ts (composition root) から AI クォータ
 * ウィジェット領域の配線を切り出したもの (move only, 挙動変更ゼロ)。
 *
 * BDBOARD_AI_QUOTA_DISABLED による無効化・`ai-quota` ソース/サービス・
 * しきい値超過通知の定期チェック・ルーターの組み立てを担う。
 */
import type { Hono } from 'hono';
import type { CommandRunner } from '../application/ports/command-runner.js';
import type { EventHub } from '../interface/sse/event-hub.js';
import type { AiQuotaAlertConfigPort } from '../application/ports/ai-quota-alert-config.js';
import { createNodeAiQuotaSource } from '../infrastructure/index.js';
import { createAiQuotaService } from '../application/ai-quota/get-ai-quota.js';
import { createAiQuotaThresholdPublisher } from '../application/ai-quota/ai-quota-threshold-alerts.js';
import { createAiQuotaRoutes } from '../interface/http/ai-quota-routes.js';
import { resolveAiQuotaAlertThresholdPercent } from '../domain/ai-quota-alert-thresholds.js';
import { envInt, envString } from '../infrastructure/env.js';

export interface WireAiQuotaWidgetDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly aiQuotaDisabled: boolean;
  readonly commandRunner: CommandRunner;
  readonly events: EventHub;
  readonly aiQuotaAlertConfigStore: AiQuotaAlertConfigPort;
  readonly log?: (message: string) => void;
  readonly logError?: (message: string) => void;
}

export interface WireAiQuotaWidgetResult {
  readonly aiQuotaRouter: Hono | undefined;
  readonly aiQuotaAlertIntervalTimer: ReturnType<typeof setInterval> | undefined;
}

export function wireAiQuotaWidget(deps: WireAiQuotaWidgetDeps): WireAiQuotaWidgetResult {
  const log = deps.log ?? console.log;
  const logError = deps.logError ?? console.error;

  if (deps.aiQuotaDisabled) {
    log('AI quota widget: disabled');
    return { aiQuotaRouter: undefined, aiQuotaAlertIntervalTimer: undefined };
  }

  const aiQuotaSource = createNodeAiQuotaSource(deps.commandRunner, {
    command: envString(deps.env, 'BDBOARD_AI_QUOTA_PATH', 'ai-quota'),
    timeoutMs: envInt(deps.env, 'BDBOARD_AI_QUOTA_TIMEOUT_MS', 70_000),
  });
  const aiQuotaService = createAiQuotaService({
    source: aiQuotaSource,
    now: () => new Date(),
    ttlMs: envInt(deps.env, 'BDBOARD_AI_QUOTA_CACHE_MS', 5 * 60_000),
  });
  const aiQuotaRouter = createAiQuotaRoutes({ aiQuotaService });

  const aiQuotaThresholdPublisher = createAiQuotaThresholdPublisher();
  // SSE購読者がいない間は`ai-quota`の実プローブ(pty経由、agy/codexを順に叩き最大50秒強)を
  // 起動しない — 誰も見ていないヘッダウィジェットのために常時稼働サーバー上で永久に
  // ptyプローブを回し続けていた問題(bdboard-uopj)。購読者がいる間だけ通常の
  // getSnapshot()(必要ならfetchを起動)を使い、いない間はpeekSnapshot()でキャッシュ
  // 参照のみに留める(キャッシュが無ければ何もしない)。
  const checkAiQuotaThresholds = async (): Promise<void> => {
    try {
      const state =
        deps.events.subscriberCount() > 0
          ? await aiQuotaService.getSnapshot()
          : aiQuotaService.peekSnapshot();
      if (state === null || state.kind !== 'ok') {
        return;
      }
      const config = await deps.aiQuotaAlertConfigStore.read();
      const thresholdPercent = resolveAiQuotaAlertThresholdPercent(config);
      const occurredAt = new Date();
      for (const payload of aiQuotaThresholdPublisher.collectBreaches(
        state.providers,
        thresholdPercent,
        occurredAt,
      )) {
        deps.events.publish({ name: 'notification', data: payload });
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logError(`AI quota threshold check error: ${detail}`);
    }
  };
  void checkAiQuotaThresholds();
  const aiQuotaAlertIntervalTimer = setInterval(
    () => void checkAiQuotaThresholds(),
    envInt(deps.env, 'BDBOARD_AI_QUOTA_ALERT_INTERVAL_MS', 60_000),
  );

  log('AI quota widget: enabled');

  return { aiQuotaRouter, aiQuotaAlertIntervalTimer };
}
