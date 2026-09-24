import type { ChatPanelControllerParams } from './chatPanelTypes';
import { useChatPanelAgentAndLauncher } from './useChatPanelAgentAndLauncher';
import { useChatPanelComposer } from './useChatPanelComposer';
import { useChatPanelStores } from './useChatPanelStores';
import { useChatPanelSync } from './useChatPanelSync';

/**
 * bdboard-sso1.83 第15b段: ChatPanel.tsx のフック配線(元の 99〜714 行目、JSX より前の
 * すべてのフック呼び出しと派生値)を1つの組み立てフックにまとめたもの。
 * TicketDetailPanel の useTicketDetailController(bdboard-sso1.5)と App の
 * useAppController(bdboard-62p4)と同じ「controller フック + 表示」の形。
 *
 * 配線は行数の都合で4つの区間フックに分け、元の並びのまま順に呼ぶ:
 * 1. useChatPanelStores(元 99〜305 行目): state を持つフック群
 * 2. useChatPanelAgentAndLauncher(元 306〜441 行目): H1、E1、H2、パネル幅と最大化、
 *    ドラフトの登録簿と起動、H3〜H5
 * 3. useChatPanelSync(元 442〜615 行目): 派生値と E3〜E13
 * 4. useChatPanelComposer(元 616〜714 行目): E14/E15、送信、クイックコマンド
 * 区間の中身は元の行をそのまま移したもので、つなげると元のフック呼び出し列と
 * 一字一句同じ順になる(設計書 §1c の登録順は変わらない。ChatPanel が先に呼ぶ
 * useRef 群も元どおり最初)。前の区間の戻り値は params に spread して次の区間へ渡す。
 * 同じ名前を2つの区間が返すことはない(組み立て時に確認済み)ので、spread で値が
 * 上書きされることはない。
 *
 * 設計書 §2 第15段の注意どおり、このフックは配線をまとめるだけの層で、ロジックは
 * 持たない(ロジックは第4〜14段で作った関心別のフックの側にある)。
 */
export function useChatPanelController(params: ChatPanelControllerParams) {
  const stores = useChatPanelStores(params);
  const agentAndLauncher = useChatPanelAgentAndLauncher({ ...params, ...stores });
  const sync = useChatPanelSync({ ...params, ...stores, ...agentAndLauncher });
  const composer = useChatPanelComposer({ ...params, ...stores, ...agentAndLauncher, ...sync });
  return { ...stores, ...agentAndLauncher, ...sync, ...composer };
}
