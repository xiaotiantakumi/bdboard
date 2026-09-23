// bdboard-sso1.83 第5段: ChatPanel.test.tsx から複数ファイルで使う fixture builder /
// render ヘルパーを move-only で切り出したもの。手本: sso1.85 の
// HygienePanel-test-support.tsx。本文(関数の中身・型・定数値・ロジック)は変えて
// いない — 元ファイルのトップレベル宣言に `export` を付け、ESLint max-lines の
// 200行上限に収めるため改行位置のみ詰めた(末尾カンマの省略等、意味的な差分はない)。
//
// vi.mock はファイル単位でホイストされるため、ここには置かない(各テストファイル側に
// 個別に持つ)。このファイル自体は vi.mock を宣言しないので、消費側の vi.mock 実行前後の
// どちらでインポートされても安全。
import { fireEvent, render, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import type { ChatAgentDto, ProjectDto } from '../api';
import { ChatPanel } from './ChatPanel';

export function makeProjectDto(overrides: Partial<ProjectDto> & Pick<ProjectDto, 'id'>): ProjectDto {
  return {
    name: overrides.name ?? overrides.id,
    rootPath: `/projects/${overrides.id}`,
    prefixes: ['bdboard'],
    sessionCount: 0,
    activeSessionCount: 0,
    incompleteTicketCount: 0,
    sessions: [],
    ...overrides,
  };
}

export const PROJECT_A = makeProjectDto({ id: 'proj-a', name: 'Project Alpha' });
export const PROJECT_B = makeProjectDto({ id: 'proj-b', name: 'Project Beta' });

export const CLAUDE_AGENT: ChatAgentDto = {
  id: 'claude', label: 'Claude', models: [{ id: 'sonnet', label: 'Sonnet' }],
  experimental: false, capability: 'bd-only', availability: 'available',
  supportsStreaming: false, supportsImages: false,
};

export const CODEX_IMAGE_AGENT: ChatAgentDto = {
  id: 'codex', label: 'Codex', models: [{ id: 'gpt-5', label: 'GPT-5' }],
  experimental: false, capability: 'bd-only', availability: 'available',
  supportsStreaming: false, supportsImages: true,
};

export const EXAMPLE_AGENT: ChatAgentDto = {
  id: 'example-agent', label: 'Example Agent', models: [{ id: 'fast', label: 'Fast' }],
  experimental: false, capability: 'bd-only', availability: 'available',
  supportsStreaming: false, supportsImages: false,
};

export const AGY_AGENT: ChatAgentDto = {
  id: 'agy', label: 'Antigravity', models: [{ id: 'gemini', label: 'Gemini' }],
  experimental: true, capability: 'bd-only', availability: 'available',
  supportsStreaming: false, supportsImages: false,
};

export const READS_PROJECT_AGENT: ChatAgentDto = {
  id: 'reads-project-agent', label: 'Reads Project Agent',
  models: [{ id: 'sonnet', label: 'Sonnet' }],
  experimental: false, capability: 'reads-project', availability: 'available',
  supportsStreaming: false, supportsImages: false,
};

export const STREAMING_AGENT: ChatAgentDto = {
  ...CLAUDE_AGENT,
  supportsStreaming: true,
};

export const IMAGE_STREAMING_AGENT: ChatAgentDto = {
  ...CODEX_IMAGE_AGENT,
  supportsStreaming: true,
};

export function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function getChatMessagePostCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(
    ([url, init]) =>
      url === '/api/chat/message' &&
      (init as RequestInit | undefined)?.method === 'POST',
  );
}

export function parseChatMessageBody(fetchMock: ReturnType<typeof vi.fn>, callIndex = -1): Record<string, unknown> {
  const calls = getChatMessagePostCalls(fetchMock);
  const target = calls.at(callIndex);
  if (target === undefined) {
    throw new Error(`No chat message POST at index ${callIndex}`);
  }
  const init = target[1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

export function pasteFiles(target: HTMLElement, files: readonly File[]) {
  fireEvent.paste(target, {
    clipboardData: {
      files,
    },
  });
}

export function makeFileList(files: readonly File[]): FileList {
  const fileList = {
    length: files.length,
    item: (index: number) => files[index] ?? null,
    [Symbol.iterator]: function* () { for (const file of files) { yield file; } },
  } as FileList;
  files.forEach((file, index) => {
    Object.defineProperty(fileList, index, { value: file, enumerable: true });
  });
  return fileList;
}

export function selectFiles(input: HTMLInputElement, files: readonly File[]) {
  fireEvent.change(input, { target: { files: makeFileList(files) } });
}

export function getImageFileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[type="file"]');
  if (!(input instanceof HTMLInputElement)) {
    throw new Error('Image file input not found');
  }
  return input;
}

export function makeImageFile(name: string, type: string = 'image/png', contents: string | number = 'image'): File {
  const body = typeof contents === 'number' ? new ArrayBuffer(contents) : contents;
  return new File([body], name, { type });
}

export function openChatSettings(container: HTMLElement) {
  const details = container.querySelector('.chat-panel-settings');
  if (details instanceof HTMLDetailsElement && !details.open) {
    const summary = details.querySelector('summary');
    if (summary !== null) {
      fireEvent.click(summary);
    }
  }
}

// Chat Redesign 1b: 旧タブ帯(role="tab")はスレッド切替ボタン1つ+縦ドロワーに
// 置き換わった。以下はドロワー操作を統一する共通ヘルパー。個々のテストが
// container.querySelector を直書きしないようにするため、必ずこれらを介する。
export function openThreadDrawer(container: HTMLElement) {
  if (container.querySelector('#chat-thread-drawer') !== null) {
    return;
  }
  const toggle = container.querySelector('.chat-thread-switcher-toggle');
  if (!(toggle instanceof HTMLButtonElement)) {
    throw new Error('chat-thread-switcher-toggle button not found');
  }
  fireEvent.click(toggle);
}

export function getThreadDrawer(container: HTMLElement): HTMLElement {
  const drawer = container.querySelector('#chat-thread-drawer');
  if (!(drawer instanceof HTMLElement)) {
    throw new Error('Thread drawer is not open. Call openThreadDrawer(container) first.');
  }
  return drawer;
}

// スレッド行の「選択」ボタン(開いている行・閉じた行どちらも)をドロワー越しに押す。
// タブ切替・閉じたスレッドの再開の両方をこれ1つで代替する。
export async function selectThreadFromDrawer(container: HTMLElement, user: ReturnType<typeof userEvent.setup>, threadTitle: string) {
  openThreadDrawer(container);
  const drawer = getThreadDrawer(container);
  await user.click(await within(drawer).findByRole('button', { name: threadTitle }));
}

// 行の「⋯」メニューを開き、以後の menuitem 操作に使うメニュー要素を返す。
// メニューはリネーム/ピン留め/削除等のクリックでも(確認2段階を除き)閉じるので、
// 複数操作を連続で行う場合は都度呼び直すこと。
export async function openThreadDrawerItemMenu(container: HTMLElement, user: ReturnType<typeof userEvent.setup>, threadTitle: string): Promise<HTMLElement> {
  openThreadDrawer(container);
  const drawer = getThreadDrawer(container);
  const menuName = `スレッド「${threadTitle}」の操作メニュー`;
  const existingMenu = within(drawer).queryByRole('menu', { name: menuName });
  if (existingMenu !== null) {
    return existingMenu;
  }
  await user.click(
    await within(drawer).findByRole('button', { name: `スレッド「${threadTitle}」の操作` }),
  );
  return within(drawer).getByRole('menu', { name: menuName });
}

export function renderChatPanel(
  projects: readonly ProjectDto[] = [PROJECT_A, PROJECT_B],
  options: {
    initialProjectId?: string;
    initialInput?: string;
    ticketContextToken?: number;
    onProjectIdChange?: (projectId: string) => void;
    leaveSettingsCollapsed?: boolean;
    isTicketOnBoard?: (ticketId: string) => boolean;
    onOpenTicket?: (ticketId: string) => void;
  } = {},
) {
  const onClose = vi.fn();
  const onOpenTicket = options.onOpenTicket ?? vi.fn();
  const isTicketOnBoard = options.isTicketOnBoard ?? (() => false);
  const rendered = render(
    <ChatPanel
      projects={projects} initialProjectId={options.initialProjectId}
      initialInput={options.initialInput} ticketContextToken={options.ticketContextToken}
      onProjectIdChange={options.onProjectIdChange} isTicketOnBoard={isTicketOnBoard}
      onOpenTicket={onOpenTicket} onClose={onClose}
    />,
  );
  if (!options.leaveSettingsCollapsed) {
    openChatSettings(rendered.container);
  }
  return { onClose, onOpenTicket, isTicketOnBoard, ...rendered };
}

