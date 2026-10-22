import type { TunnelService } from '../application/tunnel/tunnel-service.js';
import type { WriteGuardDeps } from '../interface/http/write-guard.js';
import { createPublicAddressProbe } from '../infrastructure/process/cloudflared-tunnel/public-address-probe.js';
import { createHomeJudgementRoutes } from '../interface/http/home-judgement-routes.js';

/** bdboard-hipq.3: 自宅判定 `GET /api/tunnel/at-home` の配線 (inner の catch-all より前に mount する)。 */
export function wireHomeJudgement({ tunnelService, writeAccess }: {
  tunnelService: TunnelService;
  writeAccess: WriteGuardDeps;
}) {
  return createHomeJudgementRoutes({ tunnelService, probe: createPublicAddressProbe(), writeAccess });
}
