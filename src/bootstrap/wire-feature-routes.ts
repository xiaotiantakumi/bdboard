/**
 * bdboard-sso1.86: src/main.ts (composition root) から、mount 直前に残っていた
 * 独立系機能ルーター群 (agent-run / tunnel / update-check / ai-quota / chat) と
 * SPA 静的配信判定の組み立てをまとめて切り出したもの (move only, 挙動変更ゼロ)。
 *
 * それぞれは既存の wire-agent-run.ts / wire-ai-quota-widget.ts / wire-chat.ts /
 * wire-update-check.ts をそのまま呼ぶだけで独立しており、相互依存は無い
 * (main.ts 側の元の呼び出し順をこの関数内でも保つ)。1 ファイルずつに分けるほどの
 * 分岐・状態を持たないため、ここでは「mount 直前の残りの配線」という 1 つの
 * まとまりとして扱う。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ApplicationVersionProvider } from '../application/ports/application-version.js';
import type { BoardCache } from '../application/ports/board-cache.js';
import type { ChatSessionDiscoveryPort } from '../application/ports/chat-session-discovery.js';
import type { CommandRunner } from '../application/ports/command-runner.js';
import type { HarnessContractReaderPort } from '../application/ports/harness-contract-reader.js';
import type { HarnessInjectorPort } from '../application/ports/harness-injector.js';
import type { IssueWriterPort } from '../application/ports/issue-writer.js';
import type { PackRegistryPort } from '../application/ports/pack-registry.js';
import type { StreamingCommandRunner } from '../application/ports/streaming-command-runner.js';
import type { TunnelAccessService } from '../application/tunnel/tunnel-access.js';
import type { TunnelService } from '../application/tunnel/tunnel-service.js';
import type { AiQuotaAlertConfigPort } from '../application/ports/ai-quota-alert-config.js';
import type { AuthMode } from '../interface/http/basic-auth.js';
import type { EventHub } from '../interface/sse/event-hub.js';
import type { WriteGuardDeps } from '../interface/http/write-guard.js';
import { createTunnelRoutes } from '../interface/http/tunnel-routes.js';
import { resolveWebDistDir } from '../infrastructure/web/resolve-web-dist-dir.js';
import { envBool } from './env.js';
import { wireAgentRun } from './wire-agent-run.js';
import { wireUpdateCheck } from './wire-update-check.js';
import { wireAiQuotaWidget } from './wire-ai-quota-widget.js';
import { wireChat } from './wire-chat.js';
import { type StaticSpaDeps } from './mount-routes.js';

export interface WireFeatureRoutesDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly repoRoot: string;
  readonly configFilePath: string;
  readonly cache: BoardCache;
  readonly commandRunner: CommandRunner;
  readonly streamingCommandRunner: StreamingCommandRunner;
  readonly ghPath: string;
  readonly dbPath: string;
  readonly writeAccess: WriteGuardDeps;
  readonly issueWriter: IssueWriterPort;
  readonly packRegistry: PackRegistryPort;
  readonly harnessInjector: HarnessInjectorPort;
  readonly harnessContractReader: HarnessContractReaderPort;
  readonly tunnelService: TunnelService;
  readonly authMode: AuthMode;
  readonly tunnelAccess: TunnelAccessService;
  readonly applicationVersion: ApplicationVersionProvider;
  readonly events: EventHub;
  readonly aiQuotaAlertConfigStore: AiQuotaAlertConfigPort;
  readonly chatSessionDiscovery: ChatSessionDiscoveryPort;
  readonly log?: (message: string) => void;
}

export async function wireFeatureRoutes(deps: WireFeatureRoutesDeps) {
  const log = deps.log ?? console.log;

  const { agentRunSettingsRouter, agentRunRouter, runStore } = await wireAgentRun({
    env: deps.env,
    configFilePath: deps.configFilePath,
    cache: deps.cache,
    commandRunner: deps.commandRunner,
    streamingCommandRunner: deps.streamingCommandRunner,
    ghPath: deps.ghPath,
    writeAccess: deps.writeAccess,
    issueWriter: deps.issueWriter,
    packRegistry: deps.packRegistry,
    harnessInjector: deps.harnessInjector,
    harnessContractReader: deps.harnessContractReader,
  });

  const tunnelRouter = createTunnelRoutes({
    tunnelService: deps.tunnelService,
    authEnabled: deps.authMode.kind === 'enabled',
    access: deps.tunnelAccess,
  });

  const { updateCheckRouter } = wireUpdateCheck({
    env: deps.env,
    applicationVersion: deps.applicationVersion,
  });

  const { aiQuotaRouter, aiQuotaAlertIntervalTimer } = wireAiQuotaWidget({
    env: deps.env,
    aiQuotaDisabled: envBool('BDBOARD_AI_QUOTA_DISABLED'),
    commandRunner: deps.commandRunner,
    events: deps.events,
    aiQuotaAlertConfigStore: deps.aiQuotaAlertConfigStore,
  });

  const { chatRouter, chatCloseables } = wireChat({
    env: deps.env,
    chatDisabled: envBool('BDBOARD_CHAT_DISABLED'),
    cache: deps.cache,
    chatSessionDiscovery: deps.chatSessionDiscovery,
    dbPath: deps.dbPath,
    commandRunner: deps.commandRunner,
    streamingCommandRunner: deps.streamingCommandRunner,
    writeAccess: deps.writeAccess,
  });

  const webDistDir = resolveWebDistDir(deps.repoRoot, deps.env);
  const spaIndexPath = path.join(webDistDir, 'index.html');
  let staticSpa: StaticSpaDeps | undefined;
  if (fs.existsSync(spaIndexPath)) {
    const spaIndexHtml = fs.readFileSync(spaIndexPath, 'utf8');
    log(`Serving static web UI from ${webDistDir}`);
    staticSpa = { webDistDir, spaIndexHtml };
  } else {
    log('web/dist not found; serving API only');
  }

  return {
    agentRunSettingsRouter,
    agentRunRouter,
    runStore,
    tunnelRouter,
    updateCheckRouter,
    aiQuotaRouter,
    aiQuotaAlertIntervalTimer,
    chatRouter,
    chatCloseables,
    staticSpa,
  };
}
