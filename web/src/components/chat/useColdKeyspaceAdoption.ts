import { useCallback, useEffect, type Dispatch, type SetStateAction } from 'react';
import type { ProjectDto } from '../../api';
import { makeDraftKey } from './draftKey';
import { resolveInitialProjectId } from './projectSelection';
import type { UseChatDraftStateResult } from './useChatDraftState';
import type { UseChatNotificationsResult } from './useChatNotifications';
import type { UseConversationKeyResult } from './useConversationKey';
import type { UseDraftPayloadRegistryResult } from './useDraftPayloadRegistry';

export interface UseColdKeyspaceAdoptionParams
  extends Pick<UseConversationKeyResult, 'draftNoncesRef' | 'setDraftNonces'>,
    Pick<UseChatDraftStateResult, 'conversationInputsRef' | 'conversationAttachmentsRef'>,
    Pick<UseDraftPayloadRegistryResult, 'migrateDraftPayloadKey'>,
    Pick<UseChatNotificationsResult, 'setTicketProjectFallbackNotice'> {
  projects: readonly ProjectDto[];
  initialProjectId: string | undefined;
  ticketContextToken: number | undefined;
  selectedProjectId: string;
  setSelectedProjectId: Dispatch<SetStateAction<string>>;
}

export interface UseColdKeyspaceAdoptionResult {
  handleProjectSelectChange: (nextProjectId: string) => void;
}

/**
 * bdboard-sso1.83 第14c段: ChatPanel.tsx から「'' キースペース(プロジェクト未解決中
 * のドラフト)を実プロジェクトのキースペースへ移す」側を抜き出したもの。
 * adoptProjectFromColdKeyspace と、それを呼ぶ2つの入口(プロジェクト select の
 * handleProjectSelectChange と、projects 到着時のコールド解決 effect = 設計書 §1c の
 * E6)を持つ。effect は E6 の1つだけで、ChatPanel では元の adopt の位置(E5 の
 * onProjectIdChange effect の直後、E7 のスレッド一覧 effect の直前)で呼ぶ。
 * E6 は ticket-context effect(E9)と排他(ticketContextToken で分岐)。
 *
 * 読み取り方式は元のまま: draftNoncesRef / conversationInputsRef /
 * conversationAttachmentsRef は[render ミラー](同じバッチの保留中の更新は
 * 見えない)、nonce の bump は「ref から計算して updater に埋め込む」混成(N1)、
 * 各ストアの移送は登録簿(migrateDraftPayloadKey)の関数型更新。
 */
export function useColdKeyspaceAdoption({
  projects,
  initialProjectId,
  ticketContextToken,
  selectedProjectId,
  setSelectedProjectId,
  draftNoncesRef,
  setDraftNonces,
  conversationInputsRef,
  conversationAttachmentsRef,
  migrateDraftPayloadKey,
  setTicketProjectFallbackNotice,
}: UseColdKeyspaceAdoptionParams): UseColdKeyspaceAdoptionResult {
  // bdboard-r5we: '' キースペース(プロジェクト未解決中のドラフト)から
  // 実プロジェクトのキースペースへ移す処理。従来は projects 到着時の
  // effect だけが呼んでいたが、暗黙フォールバック廃止により「ユーザーが
  // select で初めてプロジェクトを選ぶ」経路でも同じ移行が必要になったため、
  // 両者で共有する。ロジックは移動のみで変更していない。
  const adoptProjectFromColdKeyspace = useCallback(
    (resolved: string) => {
      // projects 未解決中(selectedProjectId==='')でも draftNonces[''] は進み得る:
      // 「新規スレッド」ボタン(handleNewThread、selectedProjectId!=='' でゲート
      // されていない)や、エージェント select の変更(handleAgentChange、agents の
      // ロードだけで表示されうる)がどちらも startNewDraftThread('') を呼べる。
      // ここで移行元キーを makeDraftKey('', 0) に固定すると、その間に nonce が
      // 進んでいた場合に本物のライブ入力キー(例: new::1)を見逃し、移行が
      // 空振りしてドラフトが消失/古い文言に巻き戻る。draftNoncesRef.current['']
      // (無ければ 0)を都度読んで、実際に今使われているキーを特定する。
      const coldNonce = draftNoncesRef.current[''] ?? 0;
      const staleKey = makeDraftKey('', coldNonce);
      // レビュー major-2: 「持ち込むドラフトに中身があるか」の判定は呼び出し側では
      // なくここで行う。オプション引数にすると、渡し忘れた呼び出し元(projects
      // 到着 effect)にだけドラフト消失が残る。中身があるなら、直後に再走する
      // スレッド一覧 fetch の自動選択(isExplicitDraftStillSelected が false だと
      // 既存スレッドを選んでドラフトを画面から追い出す)に負けないよう必ず bump
      // する。trim はしない — 移送側の破棄条件も `=== ''` なので、片方だけ trim
      // すると空白だけのドラフトで移送と保護がちぐはぐになる。
      const coldHasContent =
        (conversationInputsRef.current[staleKey] ?? '') !== '' ||
        (conversationAttachmentsRef.current[staleKey]?.length ?? 0) > 0;
      // bdboard-ysu(Opus レビュー SF2): coldNonce > 0 は「projects 未解決の
      // コールドウィンドウ中に、ユーザーが '' キースペースで明示的に新規ドラフト
      // 操作(新規スレッド/エージェント切替)を行った」ことを意味する。この事実を
      // resolved 側の draftNonces へ引き継がないと、ChatPanel.tsx の project-sync
      // effect(E7)の「nonce>0 かつ選択が undefined」ガード(SF1 コメント参照)が resolved
      // プロジェクトの初回 fetch 開始時点でこれを検出できず、fetch が既存
      // スレッドで解決した瞬間にこのドラフト選択が上書きされてしまう(チケットの
      // 症状そのもの、実測で確認済み)。targetNonce は「実際にこの移行後の
      // 文言が書き込まれる資格キーの nonce」でもあるため、bump は
      // targetKey を計算する前に確定させる — 後から bump すると、
      // draftKey(resolved) が指す「現在のドラフトキー」の nonce と、実際に
      // 文言を書き込んだキーの nonce がずれて、移行したはずの文言が孤児になる
      // (currentConversationKey が別の nonce を指してしまう)。'' キースペース
      // の nonce 残骸は二度と読まれないので、bump と同じ setDraftNonces 呼び出し
      // でまとめて掃除する。
      // bdboard-r5we: coldNonce が 0(ユーザーは本文を打っただけで、新規スレッド
      // /エージェント切替はしていない)でも、中身のあるドラフトを持ち込むなら
      // 同じ保護が要る。手動でプロジェクトを選んだ経路(handleProjectSelectChange)
      // と projects 到着 effect の両方が同じ判定を通る。
      let targetNonce = draftNoncesRef.current[resolved] ?? 0;
      if (coldNonce > 0 || coldHasContent) {
        targetNonce += 1;
        const bumpedTargetNonce = targetNonce;
        setDraftNonces((prev) => {
          const next: Record<string, number> = { ...prev, [resolved]: bumpedTargetNonce };
          delete next[''];
          return next;
        });
      }
      const targetKey = makeDraftKey(resolved, targetNonce);

      // レビュー minor-7 / N5・N6(bdboard-r5we): 本文・添付・添付エラー・モデル選択・
      // シード記録は同じ会話キーで持つので、必ず全部まとめて移送する。移送規則は
      // 「移送元が空なら捨てるだけ」「移送先に既に中身があれば上書きしない」
      // 「いずれにせよ移送元キーは必ず消す」で全ストア共通。ストアごとの
      // 「空」の定義(空文字を空とみなすか等)だけが違い、それは登録簿側
      // (applyToDraftPayloadStores)が各ストアに紐付けて1箇所で宣言している。
      // シード記録を引き継げなかった場合に「記録が無い」=常に「ユーザーが編集した」
      // 扱いへ倒れるのも従来どおり安全側。
      migrateDraftPayloadKey(staleKey, targetKey);

      setSelectedProjectId(resolved);
    },
    // bdboard-sso1.83 第14c段: フックの引数になったことで exhaustive-deps が
    // draftNoncesRef / setDraftNonces / setSelectedProjectId も要求するので加えた。
    // どれも useRef のオブジェクトか useState の setter で参照は変わらない(E6 の
    // 依存配列の前提。useColdKeyspaceAdoption.test.tsx で確認している)。
    [
      migrateDraftPayloadKey,
      conversationInputsRef,
      conversationAttachmentsRef,
      draftNoncesRef,
      setDraftNonces,
      setSelectedProjectId,
    ],
  );

  const handleProjectSelectChange = useCallback(
    (nextProjectId: string) => {
      if (nextProjectId === '') return;
      setTicketProjectFallbackNotice(null);
      if (selectedProjectId === '') {
        // 未選択状態で書きかけた本文/添付を、選んだプロジェクトのキースペースへ
        // 引き継ぐ(引き継がないと選択した瞬間にドラフトが消える)。
        adoptProjectFromColdKeyspace(nextProjectId);
        return;
      }
      setSelectedProjectId(nextProjectId);
    },
    [adoptProjectFromColdKeyspace, selectedProjectId, setTicketProjectFallbackNotice, setSelectedProjectId],
  );

  useEffect(() => {
    // ticketContextToken が定義されている場合は、ChatPanel.tsx の ticket-context
    // effect(E9)が projects の遅延到着を処理するため、ここでは通常のチャット
    // 起動だけを扱う。
    if (ticketContextToken !== undefined) return;
    if (selectedProjectId !== '') return;
    const resolved = resolveInitialProjectId(projects, initialProjectId);
    if (resolved === '') return;

    adoptProjectFromColdKeyspace(resolved);
  }, [
    projects,
    initialProjectId,
    selectedProjectId,
    ticketContextToken,
    adoptProjectFromColdKeyspace,
  ]);

  return { handleProjectSelectChange };
}
