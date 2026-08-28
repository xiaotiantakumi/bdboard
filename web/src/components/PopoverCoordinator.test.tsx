import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { PopoverCoordinatorProvider, useExclusivePopover } from './PopoverCoordinator';

function Popover({ id, label }: { id: string; label: string }) {
  const [open, setOpen] = useState(false);
  const containerRef = useExclusivePopover(id, open, setOpen);
  return (
    <div ref={containerRef}>
      <button type="button" onClick={() => setOpen(!open)}>
        {label}を開閉
      </button>
      {open && <div role="dialog" aria-label={`${label}の中身`} />}
    </div>
  );
}

describe('useExclusivePopover', () => {
  it('closes on Escape', async () => {
    const user = userEvent.setup();
    render(<Popover id="a" label="A" />);

    await user.click(screen.getByRole('button', { name: 'Aを開閉' }));
    expect(screen.getByRole('dialog', { name: 'Aの中身' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Aの中身' })).not.toBeInTheDocument();
  });

  it('closes when clicking outside the container', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <Popover id="a" label="A" />
        <button type="button">外側</button>
      </div>,
    );

    await user.click(screen.getByRole('button', { name: 'Aを開閉' }));
    expect(screen.getByRole('dialog', { name: 'Aの中身' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '外側' }));
    expect(screen.queryByRole('dialog', { name: 'Aの中身' })).not.toBeInTheDocument();
  });

  it('stays open while clicking inside the container', async () => {
    const user = userEvent.setup();
    render(<Popover id="a" label="A" />);

    await user.click(screen.getByRole('button', { name: 'Aを開閉' }));
    await user.click(screen.getByRole('dialog', { name: 'Aの中身' }));

    expect(screen.getByRole('dialog', { name: 'Aの中身' })).toBeInTheDocument();
  });

  it('keeps at most one popover open under a provider', async () => {
    const user = userEvent.setup();
    render(
      <PopoverCoordinatorProvider>
        <Popover id="a" label="A" />
        <Popover id="b" label="B" />
      </PopoverCoordinatorProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Aを開閉' }));
    expect(screen.getByRole('dialog', { name: 'Aの中身' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Bを開閉' }));
    expect(screen.getByRole('dialog', { name: 'Bの中身' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Aの中身' })).not.toBeInTheDocument();
  });

  it('works without a provider (each popover independent)', async () => {
    const user = userEvent.setup();
    render(<Popover id="a" label="A" />);

    await user.click(screen.getByRole('button', { name: 'Aを開閉' }));
    expect(screen.getByRole('dialog', { name: 'Aの中身' })).toBeInTheDocument();
  });
});
