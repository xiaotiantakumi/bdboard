import { describe, expect, it } from 'vitest';
import * as tunnelService from './tunnel-service.js';

/**
 * bdboard-sso1.64: src/application/tunnel/tunnel-service.ts を機能別モジュール
 * (./tunnel-service/*.ts) へ分割した際の、実行時エクスポート面の回帰ガード。
 *
 * このリストは分割前 (分割 PR のベース、origin/main の tunnel-service.ts) から
 * `grep -oE '^export (function|const) [A-Za-z0-9_]+' src/application/tunnel/tunnel-service.ts`
 * で機械的に採取した値エクスポート名 (2件) をそのままハードコードしている
 * (cloudflared-tunnel.ts 分割 #617 / basic-auth.ts 分割 #622 の方式)。
 *
 * 型エクスポート (`export interface` / `export type`) はここでは検証できないため、
 * tunnel-service-type-export-surface.check.ts (dto.ts 分割 #540 の方式) を別途置く。
 */
const EXPECTED_VALUE_EXPORTS = [
  'TUNNEL_AVAILABILITY_RECHECK_MS',
  'createTunnelService',
].sort();

describe('tunnel-service.ts export surface (bdboard-sso1.64 module split regression guard)', () => {
  it('exports exactly the same runtime bindings as the pre-split file', () => {
    const actual = Object.keys(tunnelService).sort();
    expect(actual).toEqual(EXPECTED_VALUE_EXPORTS);
  });
});
