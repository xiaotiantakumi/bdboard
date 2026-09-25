import { useEffect, useRef, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from 'react';
import type { ProjectDto } from '../../api';
import { type ChatAttachment } from './attachments';
import { makeDraftKey } from './draftKey';
import type { UseChatConversationsStateResult } from './useChatConversationsState';
import type { UseChatDraftStateResult } from './useChatDraftState';
import type { UseChatNotificationsResult } from './useChatNotifications';
import type { UseChatThreadListsResult } from './useChatThreadLists';
import type { UseConversationKeyResult } from './useConversationKey';
import type { UseDraftPayloadRegistryResult } from './useDraftPayloadRegistry';
import type { useDraftThreadLauncher } from './useDraftThreadLauncher';

export interface UseTicketContextLaunchParams
  extends Pick<UseConversationKeyResult, 'draftNoncesRef'>,
    Pick<UseChatConversationsStateResult, 'threadModelIdsRef'>,
    Pick<UseChatDraftStateResult, 'conversationInputsRef' | 'conversationAttachmentsRef' | 'draftSeedTextRef'>,
    Pick<UseChatNotificationsResult, 'ticketProjectFallbackNotice' | 'setTicketProjectFallbackNotice'>,
    Pick<UseChatThreadListsResult, 'openThreadIds'>,
    Pick<UseDraftPayloadRegistryResult, 'purgeDraftPayloadKeys'>,
    Pick<
      ReturnType<typeof useDraftThreadLauncher>,
      'pendingPrefillRef' | 'pendingTicketDraftProjectRef' | 'startNewDraftThread'
    > {
  ticketContextToken: number | undefined;
  projects: readonly ProjectDto[];
  initialProjectId: string | undefined;
  initialInput: string | undefined;
  selectedProjectId: string;
  setSelectedProjectId: Dispatch<SetStateAction<string>>;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}

/** 予約中のフォーカスのキャレット位置。'end' はフォーカス時点の textarea.value の末尾。 */
type PendingFocusCaret = number | 'end';

/**
 * bdboard-jlts: 予約中のフォーカスを次のフレームで当てる。予約(pendingFocusRef)は
 * 当てた時点で消費し、effect の cleanup では rAF だけを取り消して予約は残す。StrictMode
 * の二重実行(mount → cleanup → mount)や、フレーム前の projects 変化による張り直しでは、
 * 2回目の実行が「適用済み」の経路を通るので、そこで予約が残っていれば取り直す。
 */
function schedulePendingFocus(
  inputRef: RefObject<HTMLTextAreaElement | null>,
  pendingFocusRef: MutableRefObject<PendingFocusCaret | null>,
): () => void {
  const frameId = requestAnimationFrame(() => {
    const caret = pendingFocusRef.current;
    pendingFocusRef.current = null;
    const textarea = inputRef.current;
    if (caret === null || textarea === null) {
      return;
    }
    textarea.focus();
    const position = caret === 'end' ? textarea.value.length : caret;
    textarea.setSelectionRange(position, position);
  });
  return () => cancelAnimationFrame(frameId);
}

/**
 * bdboard-sso1.83 第14e段: ChatPanel.tsx の ticket-context effect(設計書 §1c の E9)と、
 * それだけが読み書きする appliedTicketContextTokenRef を抜き出したもの。effect は
 * この1つだけで、ChatPanel では元の位置(turn-status 回収 E8 の後、
 * useAgentListAndModelRestore(E10+E11)の前)で呼ぶ。E7(スレッド一覧 effect、
 * chat/useThreadListSync.ts)より後であること: 同期的に startNewDraftThread を呼ぶ
 * ことがある(N1: 1トリガーにつき1回まで)。E6(コールド解決 effect)とは
 * ticketContextToken で排他。
 *
 * 依存配列 [ticketContextToken, projects, purgeDraftPayloadKeys] と eslint-disable は
 * 元のまま(意図は effect 末尾のコメント)。他の値はトリガー時点の最新を読むだけ。
 * ref の種類: appliedTicketContextTokenRef と pendingFocusRef(bdboard-jlts)と pending ref 2つは[正本]、
 * draftNoncesRef / conversationInputsRef / threadModelIdsRef は[render ミラー]、
 * conversationAttachmentsRef は[eager]、draftSeedTextRef は[正本]。
 */
export function useTicketContextLaunch({
  ticketContextToken,
  projects,
  initialProjectId,
  initialInput,
  selectedProjectId,
  setSelectedProjectId,
  inputRef,
  ticketProjectFallbackNotice,
  setTicketProjectFallbackNotice,
  draftNoncesRef,
  conversationInputsRef,
  conversationAttachmentsRef,
  draftSeedTextRef,
  threadModelIdsRef,
  purgeDraftPayloadKeys,
  pendingPrefillRef,
  pendingTicketDraftProjectRef,
  openThreadIds,
  startNewDraftThread,
}: UseTicketContextLaunchParams): void {
  const appliedTicketContextTokenRef = useRef<number | undefined>(undefined);
  const pendingFocusRef = useRef<PendingFocusCaret | null>(null);

  useEffect(() => {
    if (ticketContextToken === undefined) {
      return;
    }
    if (appliedTicketContextTokenRef.current === ticketContextToken) {
      // S3: この token は既に適用済み(targetProjectId を一度確定し、必要なら
      // フォールバックした)。ただし依存配列に `projects` が入っているため、
      // 適用済みの token のままでも projects が変化するたびにこの effect は
      // 再実行される。フォールバック発生時に出した「見つからない」notice を
      // 放置すると、その後(スキャンルート復帰・再読み込み等で)実際に
      // initialProjectId が projects に現れても notice だけが事実と乖離した
      // まま残り続ける。ここで notice を「利用可能になった」旨へ更新して
      // 解消する。selectedProjectId 自体は自動で切り替えない — ユーザーが
      // 入力中のドラフトや送信先(handleSubmit は selectedProjectId 宛)を
      // 勝手に動かさないため。切り替えは既存のプロジェクト select から
      // 手動で行える。
      if (
        ticketProjectFallbackNotice !== null &&
        initialProjectId !== undefined &&
        projects.some((project) => project.id === initialProjectId)
      ) {
        const recoveredName =
          projects.find((project) => project.id === initialProjectId)?.name ??
          initialProjectId;
        setTicketProjectFallbackNotice(
          `チケットのプロジェクト「${recoveredName}」が利用可能になりました。プロジェクト選択から切り替えられます。`,
        );
      }
      // bdboard-jlts: 適用時に予約したフォーカスがまだ当たっていなければ(StrictMode の
      // 二重実行やフレーム前の張り直しで rAF が取り消された)、ここで予約し直す。
      return pendingFocusRef.current === null ? undefined : schedulePendingFocus(inputRef, pendingFocusRef);
    }

    const requestedProjectId = initialProjectId;
    const requestedProjectFound =
      requestedProjectId !== undefined &&
      projects.some((project) => project.id === requestedProjectId);
    const targetProjectId = requestedProjectFound
      ? requestedProjectId
      : selectedProjectId;

    // S1: projects がまだ到着していない間は資格判定ができない。ここで
    // appliedTicketContextTokenRef を進めると、projects が後から来ても
    // 二度とこの token を処理できなくなるので、未適用のまま return する。
    if (projects.length === 0) {
      return;
    }

    // bdboard-r5we: 一覧は届いているがチケットのプロジェクトが見つからず、
    // かつまだ何も選ばれていない。以前はここで projects[0] へ暗黙に倒して
    // いたが、意図しないプロジェクトへ送信される事故につながるため、未選択の
    // まま明示選択を促す。この token はこれ以上解決しようがないので適用済みに
    // する(以後は select の手動選択が対象を決める)。
    if (targetProjectId === '') {
      setTicketProjectFallbackNotice(
        `チケットのプロジェクト(id: ${requestedProjectId ?? '不明'})が見つかりません。`,
      );
      appliedTicketContextTokenRef.current = ticketContextToken;
      // レビュー minor-2: この経路だけ下の focus 処理より前に return するため、
      // 入力欄にフォーカスが当たらなかった。プロジェクトを跨がない(選択は ''
      // のまま)ので、textarea には既にコールドキースペースの文言が出ている。
      // キャレットはその現在値の末尾へ置く。
      pendingFocusRef.current = 'end';
      return schedulePendingFocus(inputRef, pendingFocusRef);
    }
    if (!requestedProjectFound && requestedProjectId !== undefined) {
      const fallbackName =
        projects.find((project) => project.id === targetProjectId)?.name ??
        targetProjectId;
      // S2: handleSubmit は selectedProjectId(=ここでは targetProjectId)宛に
      // 送信するため、「表示しています」だけでは受動的すぎ、チケットの
      // プロンプトが fallback 先プロジェクトのルートに対して実行されることが
      // 伝わらない。送信先が変わっている事実を明示する。
      setTicketProjectFallbackNotice(
        `チケットのプロジェクト(id: ${requestedProjectId})が見つからないため、「${fallbackName}」で開いています。この内容は「${fallbackName}」に対して送信されます。`,
      );
    } else {
      setTicketProjectFallbackNotice(null);
    }
    appliedTicketContextTokenRef.current = ticketContextToken;

    // 104.17: selectedProjectId==='' のコールドウィンドウ中(projects 未到着で
    // ticket-context の解決自体が S1 で足止めされていた間)は、マウント時シード
    // (chat/useChatDraftState.ts の conversationInputs 初期化)が '' キースペース(makeDraftKey('', N)、
    // つまり `new::N` 形式のキー)に積まれており、ユーザーがその間に書きかけた
    // 編集もそこへ乗る。targetProjectId は上の S1 早期 return を通過済みなので
    // 非空が保証されているが、selectedProjectId はこの分岐に入っている時点で
    // 定義上 '' そのもの(非空なら下の MF1 分岐は targetProjectId !==
    // selectedProjectId かどうかに関わらず通常の対象プロジェクト内で処理される)
    // なので、targetProjectId !== selectedProjectId は必ず成立し、下の MF1
    // 分岐で新しい projectId のキースペースへ切り替わる。'' キースペースは
    // 以後二度と currentConversationKey に選ばれない。104.10 の stale-key
    // migration effect は ticketContextToken !== undefined の間をこの分岐用に
    // 意図的に skip しているため、ここで引き継がないとユーザーの編集が
    // silently discard され、'' キーが conversationInputs / draftSeedTextRef の
    // 両方に孤児として残る。「システムがシードした文言のままか(未編集)」の
    // 判定は startNewDraftThread の SF1 と同じパターン(draftSeedTextRef との
    // 比較)を使う。appliedTicketContextTokenRef の上のガードにより、この
    // token に対してこのブロックはちょうど1回しか実行されない(StrictMode の
    // 二重実行でも2回目は早期 return される)ので、ここでの delete は安全。
    let ticketPrefillText = initialInput ?? '';
    // 104.17 Opus レビュー should-fix1: ticketPrefillText がユーザー自身の
    // 編集本文であり、システムのプリフィル文言と偶然一致しているだけの場合に
    // 備え、フラグで明示的に区別する。消化側(startNewDraftThread)はこれを見て
    // draftSeedTextRef への「システムシード」記録を抑止する — 記録してしまうと
    // 次にこの effect が別 token で再実行されたとき、SF1 判定が「未編集」と
    // 誤断してこのユーザー編集を破棄してしまう(probe で実証済み)。
    let ticketPrefillIsUserEdit = false;
    let ticketPrefillModelId: string | undefined;
    let ticketPrefillAttachments: readonly ChatAttachment[] | undefined;
    if (selectedProjectId === '') {
      const coldDraftKey = makeDraftKey('', draftNoncesRef.current[''] ?? 0);
      const coldValue = conversationInputsRef.current[coldDraftKey];
      if (coldValue !== undefined) {
        const coldSeedText = draftSeedTextRef.current[coldDraftKey];
        const coldValueIsEdited = coldValue !== '' && coldValue !== coldSeedText;
        if (coldValueIsEdited) {
          ticketPrefillText = coldValue;
          ticketPrefillIsUserEdit = true;
        }
      }
      const coldModelId = threadModelIdsRef.current[coldDraftKey];
      if (coldModelId !== undefined) {
        ticketPrefillModelId = coldModelId;
      }
      const coldAttachments = conversationAttachmentsRef.current[coldDraftKey];
      if (coldAttachments !== undefined && coldAttachments.length > 0) {
        ticketPrefillAttachments = [...coldAttachments];
      }
      // 104.17 Opus レビュー nit2/nit5: 引き継ぎ対象は「今ライブな nonce の
      // キー」1個だけに限らない。コールドウィンドウ中に「新規スレッド」ボタンや
      // エージェント切替で draftNonces[''] が複数回進んだ場合、古い nonce の
      // キー(例: new::0)が使われなくなった後も conversationInputs /
      // draftSeedTextRef に残り得る。104.10 の stale-key migration effect と
      // 同じ安全側パターン(値の有無に関わらず無条件で削除)に揃え、'' キー
      // スペース(`new::` prefix)にマッチする全キーをここで一括して掃除する。
      const coldKeyPattern = /^new::/;
      // 104.17 nit2/nit5: 対象は「今ライブな nonce のキー」1個に限らないので、
      // '' キースペース(`new::` prefix)に該当する全キーを、値の有無に関わらず
      // 無条件で一括削除する(104.10 の stale-key migration effect と同じ安全側
      // パターン)。対象ストアの列挙は登録簿(applyToDraftPayloadStores)に一本化
      // されているので、ここでストアを1つ書き漏らすことは構造的に起こらない。
      purgeDraftPayloadKeys((key) => coldKeyPattern.test(key));
    }

    // S2/S4-b(MF1/SF1/SF2 一括解消): プリフィルは「対象プロジェクト+文言」だけを
    // pendingPrefillRef に積む。コールドウィンドウ中の画像も同じ意図に含める。
    // 以前はここで draftNoncesRef から次の nonce を
    // 先読み予測し、その予測キーへ直接書き込んでいたが、遅延適用の窓(プロジェクト
    // を跨ぐ場合やスレッド一覧 fetch 未完了の場合、下の分岐で startNewDraftThread
    // が実際に呼ばれるのがこの effect の外・後になるケース)で他の要因により
    // nonce がずれると、予測と実際の採番が食い違って孤児エントリになり得た。
    // 実際にどの nonce のドラフトキーへ適用するかは、nonce を実際に発行する
    // 唯一の場所である startNewDraftThread 側(chat/useDraftThreadLauncher.ts)に一本化する。
    // 104.17: text はコールドウィンドウ中の未編集の initialInput、またはその間に
    // ユーザーが編集していればその編集後の文言(ticketPrefillText)のどちらか。
    // isUserEdit は後者の場合にのみ true(should-fix1、上のコメント参照)。
    pendingPrefillRef.current = {
      projectId: targetProjectId,
      text: ticketPrefillText,
      isUserEdit: ticketPrefillIsUserEdit,
      modelId: ticketPrefillModelId,
      attachments: ticketPrefillAttachments,
    };

    // S4-b: フォーカス+キャレット移動はプリフィル意図の記録直後、分岐より前に置く。
    // 以前はプロジェクトを跨ぐ経路(MF1、直後に return する)より後ろにあり、
    // クロスプロジェクトのチケット起動だけフォーカス処理が実行されなかった。
    // N4: caretPosition は DOM(textarea.value)の現在値ではなく、この
    // effect が確定させた文言の長さから決定的に求める — rAF が実行されるまでの
    // 間に(理論上は)別の入力でテキストエリアの値が変わっていても、この起動が
    // 意図したプリフィル文言の末尾へキャレットを置くことを狙っている。104.17
    // Opus レビュー nit6: ただしプロジェクトを跨ぐ経路(MF1、コールドウィンドウ
    // からの解決を含む)では、rAF 実行時点で textarea.value はまだ空(この
    // effect が起こす setSelectedProjectId/setConversationInputs の反映は
    // 後続のレンダーを待つ)なので、文言の長さへの setSelectionRange は 0 に
    // クランプされ、実質何もしていない。104.17 でコールド
    // ウィンドウ中の編集を引き継いだ場合に ticketPrefillText の長さを使うのも、
    // 上記と同じ理由でこの経路(常にプロジェクトを跨ぐ)では効果が無い —
    // 意図の一貫性のために initialInput ではなく実際に適用される文言の長さを
    // 使っているだけで、挙動そのものは 104.17 以前と変わらない。
    // N5: rAF ハンドルを保持し、コンポーネントがアンマウントされたら
    // cancelAnimationFrame する(useFocusTrap と同じパターン)。bdboard-jlts: cleanup が
    // 取り消すのは rAF だけで、予約(pendingFocusRef)は残す(schedulePendingFocus)。
    pendingFocusRef.current = ticketPrefillText.length;
    const cancelFocus = schedulePendingFocus(inputRef, pendingFocusRef);

    if (targetProjectId !== selectedProjectId) {
      // MF1: プロジェクトを跨ぐ場合、setSelectedProjectId は chat/useThreadListSync.ts の
      // スレッド一覧 fetch effect(E7)を(依存配列の selectedProjectId の変化により)再実行させる。
      // その fetch は解決時に persisted/open[0] を selectedThreadIds に書き込む
      // ため、ここで target プロジェクトが「訪問済み(openThreadIds に値がある)」
      // からといって即座に startNewDraftThread を呼んでしまうと、再実行される
      // fetch の解決が後からそれを上書きしてしまう(既存スレッドへ合流する
      // バグの再現条件)。プロジェクトを跨ぐ場合は必ず pending 経由にし、
      // 実際にドラフトへ切り替えるのは再実行後の fetch 解決(またはその
      // catch)側に一本化する。
      setSelectedProjectId(targetProjectId);
      pendingTicketDraftProjectRef.current = targetProjectId; // 再走する fetch 側で消化させる
      return cancelFocus;
    }

    if (openThreadIds[targetProjectId] !== undefined) {
      // プロジェクトは変わらず、かつ既にスレッド一覧を取得済み(fetch effect が
      // 再実行される見込みが無い) → 競合なく即座に新規ドラフトへ切り替えてよい。
      startNewDraftThread(targetProjectId);
    } else {
      // 初回マウント直後などでスレッド一覧 fetch がまだ完了していない。
      // fetch 完了時に上書きされないよう、pending 意図だけ記録しておく。
      pendingTicketDraftProjectRef.current = targetProjectId;
    }

    return cancelFocus;
    // ticketContextToken の変化(と、S1 で対象未解決だった場合の再評価、および
    // S3 で fallback notice を解消するための projects の変化)だけを起点にする
    // 意図的な依存配列。selectedProjectId / openThreadIds / initialProjectId /
    // initialInput / ticketProjectFallbackNotice はトリガー時点の最新値を
    // 都度読みたいだけであり、それら自体の変化で再実行したくない。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticketContextToken, projects, purgeDraftPayloadKeys]);
}
