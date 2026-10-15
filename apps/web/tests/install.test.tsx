import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../src/components/ui';
import { captureInstallPrompt, platformOf } from '../src/lib/install';
import Install from '../src/pages/Install';

/**
 * Audit F-8: installing the app. The browser's install offer is kept for one click; where there is
 * none, the steps for the device the page guessed, and for any other the person picks.
 */

const mount = () => render(<ToastProvider><MemoryRouter><Install /></MemoryRouter></ToastProvider>);
afterEach(() => vi.restoreAllMocks());

describe('Installing the app', () => {
  it('guesses the device from the browser — an iPad that asks for the desktop site included', () => {
    expect(platformOf('Mozilla/5.0 (Linux; Android 14; SM-S918B) Chrome/129', 5)).toBe('android');
    expect(platformOf('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Safari/604.1', 5)).toBe('ios');
    expect(platformOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15', 5)).toBe('ios');
    expect(platformOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/129', 0)).toBe('mac');
    expect(platformOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/129', 0)).toBe('windows');
    expect(platformOf('Mozilla/5.0 (X11; Linux x86_64) Chrome/129', 0)).toBe('linux');
  });

  it('shows the steps for each device, and says so when there is no one-click install', () => {
    mount();
    expect(screen.getByText('این مرورگر دکمهٔ نصب نمی‌دهد؛ گام‌های زیر را دنبال کنید.')).toBeDefined();
    fireEvent.click(screen.getByRole('tab', { name: 'آیفون و آیپد' }));
    expect(screen.getByTestId('install-steps').textContent).toContain('افزودن به صفحهٔ اصلی');
    fireEvent.click(screen.getByRole('tab', { name: 'لینوکس' }));
    expect(screen.getByText('Firefox برنامهٔ وب نصب نمی‌کند؛ برای نصب Chromium را به کار ببرید.')).toBeDefined();
  });

  it('keeps the browser’s offer for one click', async () => {
    captureInstallPrompt();
    const offer = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
      prompt: vi.fn(async () => undefined), userChoice: Promise.resolve({ outcome: 'accepted' as const }),
    });
    window.dispatchEvent(offer);
    expect(offer.defaultPrevented).toBe(true);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'نصب روی این دستگاه' }));
    await waitFor(() => expect(offer.prompt).toHaveBeenCalled());
    expect(await screen.findByText('هیوامیس نصب شد.')).toBeDefined();
  });
});
