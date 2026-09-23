import { describe, expect, it } from 'vitest';
import * as chat from './chat';

/**
 * bdboard-sso1.69: web/src/api/chat.ts を機能別モジュール (./chat/*.ts) へ分割した際の、
 * 実行時エクスポート面の回帰ガード。
 *
 * このリストは分割前 (分割 PR のベース、main の chat.ts) から
 * `grep -oE '^export (class|function|async function|const) [A-Za-z0-9_]+' web/src/api/chat.ts`
 * で機械的に採取した値エクスポート名 (13件) をそのままハードコードしている
 * (nextUpRunLoop.ts 分割 #614 の方式)。
 *
 * 型エクスポート (`export type` / `export interface`) はここでは検証できないため、
 * chat-type-export-surface.check.ts (dto.ts 分割 #540 の方式) を別途置く。
 */
const EXPECTED_VALUE_EXPORTS = [
  'ChatStreamEndedWithoutResultError',
  'acknowledgeChatTurn',
  'adoptDiscoveredChatSession',
  'deleteChatThread',
  'fetchChatAgents',
  'fetchChatAvailability',
  'fetchChatSessionMessages',
  'fetchChatThreads',
  'fetchChatTurnStatus',
  'fetchDiscoveredChatSessions',
  'postChatMessage',
  'postChatMessageStream',
  'updateChatThread',
].sort();

describe('chat.ts export surface (bdboard-sso1.69 module split regression guard)', () => {
  it('exports exactly the same runtime bindings as the pre-split file', () => {
    const actual = Object.keys(chat).sort();
    expect(actual).toEqual(EXPECTED_VALUE_EXPORTS);
  });
});
