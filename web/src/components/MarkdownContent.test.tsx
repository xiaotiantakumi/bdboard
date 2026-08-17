import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MarkdownContent } from './MarkdownContent';

describe('MarkdownContent', () => {
  it('renders markdown blocks including code, lists, and external links', () => {
    const markdown = [
      '# Heading',
      '',
      '- first item',
      '- second item',
      '',
      '```ts',
      'const x = 1;',
      '```',
      '',
      '[docs](https://example.com/docs)',
    ].join('\n');

    render(
      <MarkdownContent
        text={markdown}
        isTicketOnBoard={() => false}
        onOpenTicket={() => {}}
      />,
    );

    expect(screen.getByRole('heading', { level: 1, name: 'Heading' })).toBeInTheDocument();
    expect(screen.getByText('first item')).toBeInTheDocument();
    expect(screen.getByText('second item')).toBeInTheDocument();
    expect(screen.getByText('const x = 1;')).toBeInTheDocument();

    const externalLink = screen.getByRole('link', { name: 'docs' });
    expect(externalLink).toHaveAttribute('href', 'https://example.com/docs');
    expect(externalLink).toHaveAttribute('target', '_blank');
    expect(externalLink).toHaveAttribute('rel', 'noreferrer noopener');
  });

  it('does not inject script elements for raw HTML (XSS)', () => {
    const malicious = 'Note: <script>alert(1)</script> stays inert';
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});

    const { container } = render(
      <MarkdownContent
        text={malicious}
        isTicketOnBoard={() => false}
        onOpenTicket={() => {}}
      />,
    );

    expect(container.querySelector('script')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(alertSpy).not.toHaveBeenCalled();
    expect(screen.getByText(/Note:/)).toBeInTheDocument();
    expect(container.innerHTML).not.toMatch(/<script[\s>]/i);

    alertSpy.mockRestore();
  });

  it('renders known bead IDs as buttons and calls onOpenTicket', async () => {
    const user = userEvent.setup();
    const onOpenTicket = vi.fn();

    render(
      <MarkdownContent
        text="Blocked by bdboard-abc.1 until done."
        isTicketOnBoard={(id) => id === 'bdboard-abc.1'}
        onOpenTicket={onOpenTicket}
      />,
    );

    const ticketButton = screen.getByRole('button', { name: 'bdboard-abc.1' });
    expect(ticketButton).toHaveClass('ticket-id-link');
    expect(ticketButton).toHaveClass('markdown-bead-link');

    await user.click(ticketButton);
    expect(onOpenTicket).toHaveBeenCalledWith('bdboard-abc.1');
  });

  it('leaves unknown bead ID-like strings as plain text', () => {
    render(
      <MarkdownContent
        text="Maybe related to bdboard-missing.99 later."
        isTicketOnBoard={() => false}
        onOpenTicket={() => {}}
      />,
    );

    expect(screen.getByText(/bdboard-missing\.99/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'bdboard-missing.99' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'bdboard-missing.99' })).toBeNull();
  });
});
