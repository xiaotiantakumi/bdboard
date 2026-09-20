// bdboard-sso1.17: chat-routes.ts (1015行) の分割で、GET /api/chat/availability
// と GET /api/chat/agents (設定/エージェント一覧) をここへ切り出した (move only,
// 挙動変更ゼロ)。availabilityCache はこの2ルートでだけ読み書きするので、状態の
// 所有権もこのモジュールへそのまま移した。

import { Hono } from 'hono';
import type { ChatAgentRegistry } from '../../application/chat/chat-agent-registry.js';
import type { ChatAgentPort, ChatAgentAvailability } from '../../application/ports/chat-agent.js';
import type { ChatRateLimiter } from './chat-rate-limit.js';
import { rateLimitedResponse } from './chat-rate-limit.js';
import { type ChatAgentDto, toChatAgentDto } from './dto.js';
import { isLocalBasicAuthRequest } from './local-request.js';

export interface ChatAgentRoutesDeps {
  readonly agents: ChatAgentRegistry;
}

export interface ChatAgentRoutesParams {
  readonly now: () => Date;
  readonly availabilityCacheMs: number;
  /** GET /api/chat/availability のトンネル経由レート制限に使う、composition 側と共有の limiter。 */
  readonly limiter: ChatRateLimiter;
}

export function createChatAgentRoutes(
  deps: ChatAgentRoutesDeps,
  params: ChatAgentRoutesParams,
): Hono {
  const app = new Hono();
  const { now, availabilityCacheMs, limiter } = params;

  // エージェントごとにキャッシュする。GET /api/chat/agents は 1 リクエストで
  // エージェント数ぶんの可用性プローブ (CLI の子プロセス) を起こしうるので、
  // キャッシュが増幅の唯一の歯止め。
  const availabilityCache = new Map<
    string,
    { readonly availability: ChatAgentAvailability; readonly at: number }
  >();

  const cachedAvailability = (
    agentId: string,
    currentMs: number,
  ): ChatAgentAvailability | undefined => {
    const entry = availabilityCache.get(agentId);
    if (entry !== undefined && currentMs - entry.at < availabilityCacheMs) {
      return entry.availability;
    }
    return undefined;
  };

  const probeAvailability = async (
    agent: ChatAgentPort,
    currentMs: number,
  ): Promise<ChatAgentAvailability> => {
    let availability: ChatAgentAvailability;
    try {
      availability = await agent.checkAvailability();
    } catch {
      // ポートが例外を投げたのは「判定できなかった」であって、未認証の証拠ではない。
      availability = 'unknown';
    }
    availabilityCache.set(agent.descriptor.id, { availability, at: currentMs });
    return availability;
  };

  app.get('/api/chat/availability', async (c) => {
    const currentMs = now().getTime();
    const defaultAgent = deps.agents.defaultAgent();
    if (defaultAgent === undefined) {
      return c.json({ availability: 'unavailable' });
    }

    const agentId = defaultAgent.descriptor.id;
    const cached = cachedAvailability(agentId, currentMs);
    if (cached !== undefined) {
      return c.json({ availability: cached });
    }

    if (!isLocalBasicAuthRequest(c)) {
      const decision = limiter.consume();
      if (decision.kind === 'deny') {
        return rateLimitedResponse(c, decision);
      }
    }

    const availability = await probeAvailability(defaultAgent, currentMs);
    return c.json({ availability });
  });

  app.get('/api/chat/agents', async (c) => {
    const currentMs = now().getTime();
    const agents: ChatAgentDto[] = [];

    // 逐次に回す (Promise.all にしない): 1 リクエストで同時に N 個の子プロセスを
    // 起こさないため。キャッシュにより 1 エージェントあたり最大 1 回のプローブ。
    for (const agent of deps.agents.list()) {
      const cached = cachedAvailability(agent.descriptor.id, currentMs);
      const availability =
        cached ?? (await probeAvailability(agent, currentMs));
      agents.push(toChatAgentDto(agent.descriptor, availability));
    }

    return c.json(agents);
  });

  return app;
}
