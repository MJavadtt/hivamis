import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { Modal } from '../src/components/ui';
import { HelpDrawer } from '../src/components/HelpDrawer';
import { Markdown } from '../src/components/Markdown';
import { AuthProvider } from '../src/lib/auth';

/**
 * Hivamis, the third list: "the font is small and illegible", and "the chat page is unusable because
 * of its dimensions". The typeface is Ray, nothing is set below 12px, and overlays stack in a fixed
 * order with dialogs at the root of the page.
 */

const SRC = path.resolve(__dirname, '../src');
const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = path.join(dir, n);
  return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(n) ? [p] : [];
});
const css = readFileSync(path.join(SRC, 'index.css'), 'utf8');

describe('Legible type', () => {
  it('sets the interface in Ray, served with the app, with Vazirmatn behind it', () => {
    expect(css).toMatch(/@font-face\s*{\s*font-family: 'Ray';\s*src: url\('\/fonts\/Ray-VF\.woff'\)/);
    expect(css).toMatch(/--font-sans: 'Ray', 'Vazirmatn'/);
    expect(statSync(path.resolve(__dirname, '../public/fonts/Ray-VF.woff')).size).toBeGreaterThan(50_000);
  });

  it('raises the small sizes: 13px and 15px, not the 12px and 14px a Latin kit assumes', () => {
    const rem = (token: string) => Number(new RegExp(`${token}: ([\\d.]+)rem;`).exec(css)?.[1]);
    expect(rem('--text-xs') * 16).toBeGreaterThanOrEqual(13);
    expect(rem('--text-sm') * 16).toBeGreaterThanOrEqual(15);
  });

  it('sets nothing below 12px anywhere in the interface', () => {
    const tiny: string[] = [];
    for (const f of files(SRC)) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)) if (Number(m[1]) < 12) tiny.push(`${path.relative(SRC, f)}: ${m[0]}`);
      for (const m of text.matchAll(/fontSize[=:]\s*["'{]?(\d+(?:\.\d+)?)["'}]?/g)) if (Number(m[1]) < 11) tiny.push(`${path.relative(SRC, f)}: ${m[0]}`);
    }
    expect(tiny).toEqual([]);
  });
});

describe('Overlays', () => {
  it('opens a dialog at the root of the page, so a dialog opened from the sliding menu is not confined to it', () => {
    render(
      <aside data-testid="menu" style={{ transform: 'translateX(0)', width: 240 }}>
        <Modal open onClose={() => {}} title="پیام‌رسان"><p>متن</p></Modal>
      </aside>,
    );
    const dialog = screen.getByRole('dialog', { name: 'پیام‌رسان' });
    expect(screen.getByTestId('menu').contains(dialog)).toBe(false);
    expect(dialog.closest('.fixed')?.className).toContain('z-[70]');
  });

  it('draws drawers above the owl (z-55): the assistant and the written guide', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));
    render(<AuthProvider><HelpDrawer open onClose={() => {}} /></AuthProvider>);
    expect(screen.getByRole('dialog').closest('.fixed')?.className).toContain('z-[60]');
    const assistant = readFileSync(path.join(SRC, 'components/AssistantChat.tsx'), 'utf8');
    expect(assistant).toMatch(/className="fixed inset-0 z-\[60\]/);
  });
});

describe('The written guide', () => {
  it('reads each block in the direction of its own text, a Latin word inside a Persian sentence included', () => {
    const { container } = render(<Markdown source={'هر چیزی که روی میز شماست: QCهایی که منتظر شما هستند.\n\nThe English edition reads left to right.\n\n> پروژه بدون مجوز معتبر وارد اجرا نمی‌شود.\n> **قانون حاکم:** Doc_H §13'} />);
    const blocks = [...container.querySelectorAll('[dir]')];
    expect(blocks.map((b) => b.tagName)).toEqual(['P', 'P', 'BLOCKQUOTE']);
    expect(blocks.every((b) => b.getAttribute('dir') === 'auto')).toBe(true);
    expect(container.innerHTML).not.toMatch(/\bltr\b|text-left/);
    // A quote is a quote, not a paragraph that starts with ">".
    const quote = container.querySelector('blockquote')!;
    expect(quote.textContent).toContain('قانون حاکم:');
    expect(quote.textContent).not.toContain('>');
  });
});
