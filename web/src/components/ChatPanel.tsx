import { useRef } from 'react';
import { PlatformLimitationNotice } from './PlatformLimitationNotice';
import { SidePanelResizeHandle } from '../hooks/useResizableSidePanel';
export { formatThreadUpdatedAt } from './chat/threads';
import { ChatThreadDrawer } from './chat/ChatThreadDrawer';
import { ChatSettingsPanel } from './chat/ChatSettingsPanel';
import { ChatMessageList } from './chat/ChatMessageList';
import { ChatProjectBar } from './chat/ChatProjectBar';
import { ChatThreadSwitcher } from './chat/ChatThreadSwitcher';
import { ChatComposer } from './chat/ChatComposer';
import { ChatPanelHeader } from './chat/ChatPanelHeader';
import type { ChatPanelProps } from './chat/chatPanelTypes';
import { useChatPanelController } from './chat/useChatPanelController';
import { buildChatPanelViewModel } from './chat/chatPanelViewModel';

export function ChatPanel(props: ChatPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const threadDrawerRef = useRef<HTMLDivElement>(null);
  const threadDrawerCloseButtonRef = useRef<HTMLButtonElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  // bdboard-sso1.83 第15b段: JSX より前のフック配線は chat/useChatPanelController.ts
  // (と4つの区間フック)へ移した。フックの呼び出し順は、上の useRef 群 → controller の
  // 中の元の並び、で変わらない。DOM の ref はここで作って渡すだけで、controller の
  // 戻り値には含めない(chat/chatPanelTypes.ts 参照)。
  const controller = useChatPanelController({
    ...props,
    panelRef,
    closeButtonRef,
    threadDrawerRef,
    threadDrawerCloseButtonRef,
    messagesRef,
    inputRef,
    formRef,
  });
  const { requestClose, chatPanel, isChatPanelMaximized } = controller;
  // bdboard-sso1.83 第15c段: 子へ渡す props(スレッド一覧ドロワーの行を含む)は
  // chat/chatPanelViewModel.ts で子ごとのオブジェクトにまとめる。ref だけは下の JSX で
  // 直接渡す。
  const vm = buildChatPanelViewModel(controller, props);

  return (
    <div className="overlay" onClick={requestClose} role="presentation">
      <div
        ref={panelRef}
        className={`detail-panel chat-panel resizable-side-panel${chatPanel.isResizing ? ' is-resizing' : ''}${isChatPanelMaximized ? ' is-maximized' : ''}`}
        style={{ width: isChatPanelMaximized ? '100%' : `${chatPanel.width}px` }}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="chat-panel-title"
      >
        {!isChatPanelMaximized && (
          <SidePanelResizeHandle label="チャットパネルの幅を変更" panel={chatPanel} />
        )}
        <ChatPanelHeader {...vm.header} closeButtonRef={closeButtonRef} />

        <ChatProjectBar {...vm.projectBar} />

        <ChatThreadSwitcher {...vm.threadSwitcher} />
        <ChatThreadDrawer
          {...vm.threadDrawer}
          drawerRef={threadDrawerRef}
          closeButtonRef={threadDrawerCloseButtonRef}
        />

        <ChatSettingsPanel {...vm.settings} />

        {/* 送信して初めて 501 に気付く、では遅い (bdboard-70z.9)。 */}
        <PlatformLimitationNotice feature="chat" />

        <ChatMessageList {...vm.messageList} messagesRef={messagesRef} />

        <ChatComposer
          {...vm.composer}
          formRef={formRef}
          inputRef={inputRef}
          actions={{ ...vm.composerActions, fileInputRef }}
        />
      </div>
    </div>
  );
}
