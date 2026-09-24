// bdboard-sso1.83 第7段: ChatComposer 抽出時に足した、コンポーネント単体の
// レンダリング/操作テスト。子コンポーネント(ChatQuickCommands/ChatInputNotices/
// ChatInputActions)自体は実物をそのまま使い、渡した props が実際の DOM に
// 反映されること・textarea への ref/イベントハンドラの配線が壊れていないことを
// 確認する。
import { createRef } from 'react';
import type { ComponentProps } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChatComposer } from './ChatComposer';

type Props = ComponentProps<typeof ChatComposer>;

function baseProps(overrides: Partial<Props> = {}): Props {
  return {
    formRef: createRef<HTMLFormElement>(),
    inputRef: createRef<HTMLTextAreaElement>(),
    value: '',
    disabled: false,
    onChange: vi.fn(),
    onPaste: vi.fn(),
    onKeyDown: vi.fn(),
    onSubmit: vi.fn((event) => event.preventDefault()),
    hasAttachments: false,
    quickCommands: {
      isSending: false,
      isHistoryPending: false,
      selectedProjectId: 'proj-a',
      onQuickCommand: vi.fn(),
    },
    notices: {
      hasUnresolvedProjectRecovery: false,
      isSending: false,
      attachments: [],
      onRemoveAttachment: vi.fn(),
      attachmentError: null,
      hasUnsupportedAttachments: false,
      selectedAgentUnavailable: false,
      agentUnavailableHintId: null,
    },
    actions: {
      fileInputRef: createRef<HTMLInputElement>(),
      isSending: false,
      chatUnsupported: false,
      onImageFileChange: vi.fn(),
      submitDisabled: false,
      ariaDescribedBy: undefined,
    },
    ...overrides,
  };
}

describe('ChatComposer', () => {
  it('attaches formRef to the <form>, and toggles has-attachments with hasAttachments', () => {
    const formRef = createRef<HTMLFormElement>();
    const { container, rerender } = render(<ChatComposer {...baseProps({ formRef, hasAttachments: false })} />);
    expect(formRef.current).toBe(container.querySelector('form'));
    expect(formRef.current?.className).not.toContain('has-attachments');

    rerender(<ChatComposer {...baseProps({ formRef, hasAttachments: true })} />);
    expect(formRef.current?.className).toContain('has-attachments');
  });

  it('wires the textarea (ref, value, disabled) and forwards onChange/onPaste/onKeyDown', () => {
    const inputRef = createRef<HTMLTextAreaElement>();
    const onChange = vi.fn();
    const onPaste = vi.fn();
    const onKeyDown = vi.fn();
    render(
      <ChatComposer
        {...baseProps({ inputRef, value: 'stage7-marker', disabled: true, onChange, onPaste, onKeyDown })}
      />,
    );
    const textarea = screen.getByLabelText('メッセージ');
    expect(inputRef.current).toBe(textarea);
    expect(textarea).toHaveValue('stage7-marker');
    expect(textarea).toBeDisabled();

    fireEvent.change(textarea, { target: { value: 'x' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onKeyDown).toHaveBeenCalledTimes(1);
    fireEvent.paste(textarea);
    expect(onPaste).toHaveBeenCalledTimes(1);
  });

  it('calls onSubmit when the form is submitted', () => {
    const onSubmit = vi.fn((event) => event.preventDefault());
    const { container } = render(<ChatComposer {...baseProps({ onSubmit })} />);
    const form = container.querySelector('form');
    expect(form).not.toBeNull();
    if (form) fireEvent.submit(form);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('forwards actions props to the real ChatInputActions submit button', () => {
    render(
      <ChatComposer
        {...baseProps({
          actions: {
            fileInputRef: createRef<HTMLInputElement>(),
            isSending: false,
            chatUnsupported: false,
            onImageFileChange: vi.fn(),
            submitDisabled: true,
            ariaDescribedBy: 'stage7-marker-hint',
          },
        })}
      />,
    );
    const submitButton = screen.getByRole('button', { name: '送信' });
    expect(submitButton).toBeDisabled();
    expect(submitButton).toHaveAttribute('aria-describedby', 'stage7-marker-hint');
  });

  it('forwards quickCommands props to the real ChatQuickCommands chips', () => {
    render(
      <ChatComposer
        {...baseProps({
          quickCommands: {
            isSending: true,
            isHistoryPending: false,
            selectedProjectId: 'proj-a',
            onQuickCommand: vi.fn(),
          },
        })}
      />,
    );
    expect(screen.getByRole('group', { name: 'クイックコマンド' })).toBeInTheDocument();
    for (const button of screen.getAllByRole('button', { name: /を入力欄に挿入/ })) {
      expect(button).toBeDisabled();
    }
  });

  it('renders the hint texts', () => {
    render(<ChatComposer {...baseProps()} />);
    expect(screen.getByText(/⌘\/Ctrl \+ Enter で送信/)).toBeInTheDocument();
    expect(screen.getByText(/localStorage には保存されません/)).toBeInTheDocument();
  });
});
