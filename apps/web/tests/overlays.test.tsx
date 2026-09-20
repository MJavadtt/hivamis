import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { Button, Modal } from '../src/components/ui';

/**
 * Overlay behaviour that a mouse user never notices and a keyboard user cannot work around:
 * Escape, focus returning to whatever opened it, and Tab staying inside.
 */
function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>باز کردن</button>
      <Modal open={open} onClose={() => setOpen(false)} title="گفتگوی آزمایشی"
        footer={<Button onClick={() => setOpen(false)}>تأیید</Button>}>
        <input aria-label="ورودی" />
      </Modal>
    </>
  );
}

describe('Modal', () => {
  it('carries the dialog role and its title', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('باز کردن'));
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBe('گفتگوی آزمایشی');
  });

  it('closes on Escape', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('باز کردن'));
    expect(screen.queryByRole('dialog')).not.toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('returns focus to the control that opened it', async () => {
    render(<Harness />);
    const opener = screen.getByText('باز کردن');
    opener.focus();
    fireEvent.click(opener);
    // Focus moves into the dialog...
    await vi.waitFor(() => expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document, { key: 'Escape' });
    // ...and comes back out when it closes, rather than landing on <body>.
    await vi.waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('moves focus inside on open rather than leaving it on the page behind', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('باز کردن'));
    await vi.waitFor(() => {
      expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
    });
  });

  it('keeps the page behind from scrolling while it is open', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('باز کردن'));
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.body.style.overflow).toBe('');
  });
});
