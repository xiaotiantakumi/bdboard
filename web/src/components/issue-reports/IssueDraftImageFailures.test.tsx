import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { expectNoA11yViolations } from '../../test/axe';
import { IssueDraftImageFailures, type IssueDraftImageFailureItem } from './IssueDraftImageFailures';

const FAILURES: readonly IssueDraftImageFailureItem[] = [
  { label: '2 枚目「image.png」', reason: '画像が大きすぎます (1 枚 10 MiB まで)。' },
  { label: '3 枚目「image.png」', reason: '送っていません (上と同じ原因で、残りの画像は送るのをやめました)。' },
];

function setup(props: { failures?: readonly IssueDraftImageFailureItem[]; sending?: boolean } = {}) {
  const onRetry = vi.fn();
  const onOpen = vi.fn();
  const view = render(
    <IssueDraftImageFailures failures={props.failures ?? FAILURES} sending={props.sending ?? false} onRetry={onRetry} onOpen={onOpen} />,
  );
  return { view, onRetry, onOpen, user: userEvent.setup() };
}

describe('IssueDraftImageFailures (bdboard-4y8q.6.9)', () => {
  it('says the draft was created and which images did not attach, each with its reason', () => {
    setup();
    expect(screen.getByRole('alert')).toHaveTextContent('下書きは作れましたが、次の画像は付けられませんでした。');
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('2 枚目「image.png」: 画像が大きすぎます (1 枚 10 MiB まで)。');
    expect(items[1]).toHaveTextContent('3 枚目「image.png」: 送っていません');
  });

  it('tells that the title and description are saved', () => {
    setup();
    expect(screen.getByText('題名と説明は下書きに保存されています。')).toBeInTheDocument();
  });

  it('offers no way to send the report again: no fields and no 送る button', () => {
    setup();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: '送る' })).toBeNull();
    expect(screen.queryByLabelText('画像のファイルを選ぶ')).toBeNull();
  });

  it('is a labelled region whose heading takes the focus so the result is read out', () => {
    setup();
    expect(screen.getByRole('region', { name: '画像の送信結果' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '下書きを作りました' })).toHaveFocus();
  });

  it('moves the focus back to the heading when the list of failures is renewed', () => {
    const { view, onRetry, onOpen } = setup();
    screen.getByRole('button', { name: '下書きを開く' }).focus();
    expect(screen.getByRole('button', { name: '下書きを開く' })).toHaveFocus();
    view.rerender(
      <IssueDraftImageFailures failures={[FAILURES[1]]} sending={false} onRetry={onRetry} onOpen={onOpen} />,
    );
    expect(screen.getByRole('heading', { name: '下書きを作りました' })).toHaveFocus();
  });

  it('does not steal the focus on a re-render with the same list', () => {
    const { view, onRetry, onOpen } = setup();
    screen.getByRole('button', { name: '下書きを開く' }).focus();
    view.rerender(<IssueDraftImageFailures failures={FAILURES} sending onRetry={onRetry} onOpen={onOpen} />);
    expect(screen.getByRole('heading', { name: '下書きを作りました' })).not.toHaveFocus();
  });

  // bdboard-8zwi: 送り直しても同じ画像が同じ理由で落ちると、alert の文は前と同じ。読み上げは変化のないものを読まないので、
  // 結果が新しくなるたびに alert の要素を作り直して、新しい alert として読ませる。
  it('renews the alert element when the list of failures is renewed, even when the sentence is the same', () => {
    const { view, onRetry, onOpen } = setup();
    const first = screen.getByRole('alert');
    view.rerender(
      <IssueDraftImageFailures failures={[...FAILURES]} sending={false} onRetry={onRetry} onOpen={onOpen} />,
    );
    const second = screen.getByRole('alert');
    expect(second).not.toBe(first);
    expect(first).not.toBeInTheDocument();
    expect(second).toHaveTextContent('下書きは作れましたが、次の画像は付けられませんでした。');
  });

  it('keeps the same alert element on a re-render with the same list (the sending toggle is not a new result)', () => {
    const { view, onRetry, onOpen } = setup();
    const first = screen.getByRole('alert');
    view.rerender(<IssueDraftImageFailures failures={FAILURES} sending onRetry={onRetry} onOpen={onOpen} />);
    expect(screen.getByRole('alert')).toBe(first);
  });

  // 狭い幅で 44px にする規則 (styles/issue-reports.css) は、この class を目印にする。規則そのものは index.css.issueDraftImageTouchTarget.test.ts が見る。
  it('puts both buttons in the container that the 44px narrow-width rule targets', () => {
    setup();
    const actions = document.querySelector('.issue-draft-image-failure-actions');
    expect(actions).not.toBeNull();
    expect(actions).toContainElement(screen.getByRole('button', { name: '付かなかった画像をもう一度送る' }));
    expect(actions).toContainElement(screen.getByRole('button', { name: '下書きを開く' }));
  });

  it('calls onRetry from the retry button and onOpen from the open button', async () => {
    const { user, onRetry, onOpen } = setup();
    await user.click(screen.getByRole('button', { name: '付かなかった画像をもう一度送る' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '下書きを開く' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('reaches both buttons with the keyboard alone', async () => {
    const { user, onRetry, onOpen } = setup();
    await user.tab();
    expect(screen.getByRole('button', { name: '付かなかった画像をもう一度送る' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onRetry).toHaveBeenCalledTimes(1);
    await user.tab();
    expect(screen.getByRole('button', { name: '下書きを開く' })).toHaveFocus();
    await user.keyboard(' ');
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('disables both buttons and shows 送信中… while the failed images are being sent again', () => {
    setup({ sending: true });
    expect(screen.getByRole('button', { name: '送信中…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '下書きを開く' })).toBeDisabled();
  });

  it('has no accessibility violations', async () => {
    const { view } = setup();
    await expectNoA11yViolations(view.container);
  });
});
