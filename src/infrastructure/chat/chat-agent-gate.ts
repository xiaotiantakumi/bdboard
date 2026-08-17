/**
 * bd-only ではないチャットエージェント(現状は codex / cursor / agy)を有効化するかどうかの
 * 唯一のゲート。値は `BDBOARD_CHAT_AGENTS` 環境変数のカンマ区切り agentId
 * 一覧で、既定(未設定)では空集合 = 何も opt-in されない = codex/cursor は登録されない。
 *
 * 意図的にここには実装していないもの: トンネル経由かどうかによる到達可否の制限。
 * チケット原案は非 bd-only エージェントをトンネル越しには使わせない案も検討したが、
 * bdboard-9a9 の裁定で「チャットエージェントに read/write 権限を与える」設計が
 * 正式に採用されたため、trunk-vs-tunnel の到達可否は既存の
 * createPrivilegedApiGuardMiddleware / isLocalControlRequest (bdboard-cu4/9rz) の
 * 挙動のまま変えない。opt-in さえ済んでいれば、bd-only エージェントと同じ経路・
 * 同じ認可でトンネル越しにも使える(chat-routes.test.ts の
 * bdboard-l1t.4/bdboard-9a9 回帰テストが担保)。
 */
// 現状 opt-in 可能な bd-only ではないエージェントは codex と cursor(bdboard-l1t.5)。
// ここに無い id を指定しても実害は無い(どのエージェントもその id では登録されない
// ため素通りになるだけ)が、タイプミスに誰も気づけないまま「意図したエージェントが
// 有効になっていない」に陥るのを避けるため、未知の id は console.warn で知らせる
// (bdboard-l1t.4 SF7)。
const KNOWN_OPT_IN_AGENT_IDS: ReadonlySet<string> = new Set(['codex', 'cursor', 'agy']);

export function parseChatAgentOptIns(rawEnvValue: string | undefined): ReadonlySet<string> {
  if (rawEnvValue === undefined) {
    return new Set();
  }
  const ids = new Set(
    rawEnvValue
      .split(',')
      .map((part) => part.trim().toLowerCase())
      .filter((part) => part.length > 0),
  );
  for (const id of ids) {
    if (!KNOWN_OPT_IN_AGENT_IDS.has(id)) {
      console.warn(
        `BDBOARD_CHAT_AGENTS: unknown chat agent id "${id}" (known: ${[...KNOWN_OPT_IN_AGENT_IDS].join(', ')})`,
      );
    }
  }
  return ids;
}

export function isChatAgentOptedIn(agentId: string, optIns: ReadonlySet<string>): boolean {
  return optIns.has(agentId);
}
