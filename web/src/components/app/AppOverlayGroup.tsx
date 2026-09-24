import { AppTicketDetailOverlay, type AppTicketDetailOverlayProps } from './AppTicketDetailOverlay';
import { AppSessionListOverlay, type AppSessionListOverlayProps } from './AppSessionListOverlay';
import { AppShortcutsOverlay, type AppShortcutsOverlayProps } from './AppShortcutsOverlay';
import { AppHelpOverlay, type AppHelpOverlayProps } from './AppHelpOverlay';
import { AppSearchOverlay, type AppSearchOverlayProps } from './AppSearchOverlay';
import { AppTunnelOverlay, type AppTunnelOverlayProps } from './AppTunnelOverlay';
import { AppChatOverlay, type AppChatOverlayProps } from './AppChatOverlay';

export interface AppOverlayGroupProps {
  ticketDetail: AppTicketDetailOverlayProps;
  sessionList: AppSessionListOverlayProps;
  shortcuts: AppShortcutsOverlayProps;
  help: AppHelpOverlayProps;
  search: AppSearchOverlayProps;
  tunnel: AppTunnelOverlayProps;
  chat: AppChatOverlayProps;
}

/**
 * bdboard-62p4 第4段。App.tsx の return 末尾に並んでいた7つの状態を
 * 持たないオーバーレイ (AppTicketDetailOverlay 〜 AppChatOverlay、いずれも
 * bdboard-sso1.13 で切り出し済み) を、AppHeader.tsx / AppViewContent.tsx と
 * 同じ手法(関心ごとにまとめたオブジェクトを渡す)でまとめた組み立て役。
 *
 * 各オーバーレイ自体の props 型 (AppXxxOverlayProps) をそのまま
 * `ticketDetail`/`sessionList`/... の型として再利用しているため、渡す値・
 * prop 名は元の App.tsx から一切変えていない — ただ7回の個別 JSX 呼び出しを
 * 1回のグループ呼び出しにまとめただけ。各オーバーレイ自身の開閉ガード
 * (`if (!open) return null`) はそれぞれの実装内に残っているので、ここでは
 * 早期 return を追加していない。
 */
export function AppOverlayGroup({
  ticketDetail,
  sessionList,
  shortcuts,
  help,
  search,
  tunnel,
  chat,
}: AppOverlayGroupProps) {
  return (
    <>
      <AppTicketDetailOverlay {...ticketDetail} />
      <AppSessionListOverlay {...sessionList} />
      <AppShortcutsOverlay {...shortcuts} />
      <AppHelpOverlay {...help} />
      <AppSearchOverlay {...search} />
      <AppTunnelOverlay {...tunnel} />
      <AppChatOverlay {...chat} />
    </>
  );
}
