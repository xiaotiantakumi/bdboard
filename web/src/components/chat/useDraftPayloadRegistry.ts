import { useCallback } from 'react';
import {
  applyTransformToAllDraftPayloadStores,
  isNeverEmpty,
  migrateKeyInRecord,
  purgeKeysInRecord,
  type DraftPayloadStoreTransform,
} from '../conversationKeyspace';
import type { UseChatConversationsStateResult } from './useChatConversationsState';
import type { UseChatDraftStateResult } from './useChatDraftState';

export interface UseDraftPayloadRegistryParams
  extends Pick<UseChatDraftStateResult, 'draftApplicators'>,
    Pick<UseChatConversationsStateResult, 'setThreadModelIds'> {}

export interface UseDraftPayloadRegistryResult {
  applyToDraftPayloadStores: (transform: DraftPayloadStoreTransform) => void;
  migrateDraftPayloadKey: (from: string, to: string) => void;
  purgeDraftPayloadKeys: (matches: (key: string) => boolean) => void;
}

/**
 * bdboard-sso1.83 第14a段: ChatPanel.tsx から「ドラフト積載物」ストアの登録簿
 * (applyToDraftPayloadStores と、それを使う migrateDraftPayloadKey /
 * purgeDraftPayloadKeys)を move-only で抜き出したもの。effect は持たない
 * (useCallback だけ)。呼び出し位置は元の applyToDraftPayloadStores の位置。
 *
 * 参照安定性: 返す3関数は chat/useColdKeyspaceAdoption.ts の
 * adoptProjectFromColdKeyspace(→ E6 の
 * 依存配列)と E9(ticket-context effect)の依存配列に入っている。参照が毎レンダー
 * 変わると両 effect が入力のたびに再実行されるので、依存配列には
 * draftApplicators オブジェクトではなく個々の関数を並べる(下のコメント参照)。
 * 同じ理由で、引数の setThreadModelIds と draftApplicators の各関数は呼び出し側で
 * 参照が安定していること(ChatPanel では useState の setter と useCallback)。
 * 毎レンダー作り直すラッパーを渡すと E6/E9 が入力のたびに再実行される。
 *
 * bdboard-c1pw / bdboard-ru4d: 会話キーで索かれる「ドラフト積載物」ストアの
 * 単一の登録簿。会話キーの再割り当て(migrateDraftPayloadKey)と、'' キースペース
 * の一括破棄(purgeDraftPayloadKeys)は、どちらも必ずこの1箇所の列挙を通る。
 * DRAFT_PAYLOAD_STORE_NAMES 型により applicators の網羅性も tsc で強制される。
 * 新しい会話キー付きストアを足すときは conversationKeyspace.ts の正本に追加し、
 * ここと3再割り当てサイト(chat/useDraftThreadLauncher.ts の handleAgentChange / startNewDraftThread、
 * chat/useChatSendCommits.ts の commitSuccess)の引き継ぎ選択も更新すること。
 *
 * 意図的な非対象: conversations / historyLoadedFor / streamingReply。
 * conversations / historyLoadedFor は「サーバーのセッション状態」側。
 * streamingReply は bdboard-1qoe で会話キーでスコープした Record になり形は
 * draft payload ストアと同じだが、これはクライアントが受信中のストリーム
 * バッファであり、ドラフトの「積載物」(未送信の入力/添付) ではないため対象に
 * 含めない — sendKey は selectedProjectId==='' の間は chat/useChatSubmit.ts の
 * submit が早期 return するため '' キースペースに入ることが無く、かつ
 * 各送信は自分の finally で自分のキーを必ず clearStreamingReplyForKey する
 * ので、ここで移送/掃除しなくても取り残されない。2つの呼び出し
 * サイト(chat/useColdKeyspaceAdoption.ts の adoptProjectFromColdKeyspace による
 * コールドキースペースからの移送・ChatPanel.tsx の
 * ticket-context effect の '' キースペースの掃除)では元々どちらも
 * 移送されていない。ここに含めると挙動が変わる。
 */
export function useDraftPayloadRegistry({
  draftApplicators,
  setThreadModelIds,
}: UseDraftPayloadRegistryParams): UseDraftPayloadRegistryResult {
  const applyToDraftPayloadStores = useCallback(
    (transform: DraftPayloadStoreTransform) => {
      applyTransformToAllDraftPayloadStores(
        {
          conversationInputs: draftApplicators.conversationInputs,
          conversationAttachments: draftApplicators.conversationAttachments,
          attachmentErrors: draftApplicators.attachmentErrors,
          threadModelIds: (t) => setThreadModelIds((prev) => t(prev, isNeverEmpty)),
          draftSeedText: draftApplicators.draftSeedText,
        },
        transform,
      );
    },
    // bdboard-sso1.83 第2段(依存配列の変更理由): 以前はここに
    // updateConversationAttachments(ChatPanel ローカルの useCallback、常に
    // 参照安定)を1つ挙げるだけだった。今は4つとも draftApplicators.*
    // (useChatDraftState.ts 内で useCallback により個別にメモ化された関数)を
    // 直接使う。draftApplicators オブジェクト自体は毎レンダー新しいオブジェクト
    // リテラルなので、それを丸ごと依存配列に入れると
    // applyToDraftPayloadStores(→ migrateDraftPayloadKey/purgeDraftPayloadKeys
    // → chat/useColdKeyspaceAdoption.ts のコールドウィンドウ effect の依存配列)が毎レンダー再生成され、
    // その effect が意図せず再実行されるようになってしまう。個々のプロパティ
    // (conversationInputs/conversationAttachments/attachmentErrors/
    // draftSeedText)はそれぞれ安定した参照を返すので、それらだけを列挙して
    // 元の安定性を保つ(useChatDraftState.test.tsx に参照安定性の検証テストを
    // 追加済み)。
    // bdboard-sso1.83 第14a段: フックの引数になったことで exhaustive-deps が
    // setThreadModelIds も要求するので加えた(useState の setter で常に安定。
    // 参照安定性は useDraftPayloadRegistry.test.tsx で確認している)。
    [
      draftApplicators.conversationInputs,
      draftApplicators.conversationAttachments,
      draftApplicators.attachmentErrors,
      draftApplicators.draftSeedText,
      setThreadModelIds,
    ],
  );

  const migrateDraftPayloadKey = useCallback(
    (from: string, to: string) => {
      applyToDraftPayloadStores((record, isEmpty) =>
        migrateKeyInRecord(record, from, to, isEmpty),
      );
    },
    [applyToDraftPayloadStores],
  );

  const purgeDraftPayloadKeys = useCallback(
    (matches: (key: string) => boolean) => {
      applyToDraftPayloadStores((record) => purgeKeysInRecord(record, matches));
    },
    [applyToDraftPayloadStores],
  );

  return { applyToDraftPayloadStores, migrateDraftPayloadKey, purgeDraftPayloadKeys };
}
