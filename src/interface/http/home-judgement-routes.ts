import { Hono } from 'hono';
import type { PublicAddressProbe, PublicAddresses } from '../../application/ports/public-address-probe.js';
import type { TunnelService } from '../../application/tunnel/tunnel-service.js';
import { isLocalBasicAuthRequest, isLocalControlRequest } from './local-request.js';
import { createPrivilegedApiGuardMiddleware, type WriteGuardDeps } from './write-guard.js';

/**
 * Cloudflare の接続元 IP とトンネルの公開 IP を照合し、自宅判定を返す。
 * IP アドレスそのものはログにもレスポンスにも出さない。
 */
export const AT_HOME_PATH = '/api/tunnel/at-home';

function ipv4Mapped(address: string): string | null {
  const match = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})(?:%[^%]+)?$/i.exec(address);
  if (!match) return null;
  const octets = match[1].split('.').map(Number);
  return octets.every((octet) => octet <= 255) ? octets.join('.') : null;
}

function ipv6Prefix(address: string): string | null {
  if (!address.includes(':')) return null;
  const bare = address.split('%', 1)[0].toLowerCase();
  if (ipv4Mapped(bare) !== null) return null;
  let value = bare;
  const embeddedV4 = /(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  if (embeddedV4) {
    const octets = embeddedV4[1].split('.').map(Number);
    if (!octets.every((octet) => octet <= 255)) return null;
    value = value.slice(0, -embeddedV4[1].length) + ((octets[0] << 8) | octets[1]).toString(16) + ':' + ((octets[2] << 8) | octets[3]).toString(16);
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 2
    ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
    : left;
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.slice(0, 4).map((group) => Number.parseInt(group, 16).toString(16)).join(':');
}

export function judgeHome(clientAddress: string | null, known: PublicAddresses): 'yes' | 'no' | 'unknown' {
  if (known.ipv4 === null && known.ipv6 === null) return 'unknown';
  if (clientAddress === null) return 'no';
  if (known.ipv4 !== null && clientAddress === known.ipv4) return 'yes';
  const clientMappedV4 = ipv4Mapped(clientAddress);
  if (clientMappedV4 !== null && known.ipv4 !== null && clientMappedV4 === known.ipv4) return 'yes';
  const knownMappedV4 = known.ipv6 === null ? null : ipv4Mapped(known.ipv6);
  if (knownMappedV4 !== null && clientAddress === knownMappedV4) return 'yes';
  const clientPrefix = ipv6Prefix(clientAddress);
  if (clientPrefix !== null && known.ipv6 !== null && clientPrefix === ipv6Prefix(known.ipv6)) return 'yes';
  return 'no';
}

export function createHomeJudgementRoutes(deps: {
  readonly tunnelService: Pick<TunnelService, 'getState'>;
  readonly probe: PublicAddressProbe;
  readonly writeAccess: WriteGuardDeps;
}): Hono {
  const app = new Hono();
  const guard = createPrivilegedApiGuardMiddleware(deps.writeAccess);
  app.use(AT_HOME_PATH, guard);
  app.use(`${AT_HOME_PATH}/*`, guard);
  app.get(AT_HOME_PATH, async (c) => {
    if (isLocalBasicAuthRequest(c) || isLocalControlRequest(c)) return c.json({ home: 'yes' as const });
    const state = deps.tunnelService.getState();
    if (state.kind !== 'on') return c.json({ home: 'unknown' as const });
    const known = await deps.probe.probe(state.url);
    return c.json({ home: judgeHome(c.req.header('cf-connecting-ip') ?? null, known) });
  });
  return app;
}
