import { describe, expect, it } from 'vitest';
import * as cloudflaredTunnel from './cloudflared-tunnel.js';

/**
 * bdboard-sso1.54: src/infrastructure/process/cloudflared-tunnel.ts を機能別モジュール
 * (./cloudflared-tunnel/*.ts) へ分割した際の、実行時エクスポート面の回帰ガード。
 *
 * このリストは分割前 (分割 PR のベース、main の cloudflared-tunnel.ts) から
 * `grep -oE '^export (function|const) [A-Za-z0-9_]+' src/infrastructure/process/cloudflared-tunnel.ts`
 * で機械的に採取した値エクスポート名 (4件) をそのままハードコードしている
 * (ai-quota-source.ts 分割 #605 / ps-process-scanner.ts 分割 #611 の方式)。
 *
 * 型エクスポート (`export interface` / `export type`) はここでは検証できないため、
 * cloudflared-tunnel-type-export-surface.check.ts (dto.ts 分割 #540 の方式) を別途置く。
 */
const EXPECTED_VALUE_EXPORTS = [
  'STARTUP_OUTPUT_BUFFER_MAX_BYTES',
  'resolveDefaultTunnelLogFilePath',
  'appendStartupOutputBuffer',
  'createCloudflaredTunnel',
].sort();

describe('cloudflared-tunnel.ts export surface (bdboard-sso1.54 module split regression guard)', () => {
  it('exports exactly the same runtime bindings as the pre-split file', () => {
    const actual = Object.keys(cloudflaredTunnel).sort();
    expect(actual).toEqual(EXPECTED_VALUE_EXPORTS);
  });
});
