import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { ErrorBoundary } from '../src/components/ErrorBoundary';

function Boom({ fail }: { fail: boolean }): React.ReactElement {
  if (fail) throw new Error('صفحه شکست');
  return <p>محتوای سالم</p>;
}

describe('ErrorBoundary', () => {
  it('renders its children when nothing throws', () => {
    render(<ErrorBoundary><Boom fail={false} /></ErrorBoundary>);
    expect(screen.getByText('محتوای سالم')).toBeDefined();
  });

  /** Without this, a throw below <Routes> blanks the page and leaves no way back. */
  it('shows a recoverable message instead of a blank page', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<ErrorBoundary><Boom fail /></ErrorBoundary>);

    expect(screen.getByRole('alert')).toBeDefined();
    expect(screen.getByText('نمایش این صفحه با خطا مواجه شد')).toBeDefined();
    // The message is surfaced so the user has something to report.
    expect(screen.getByText('صفحه شکست')).toBeDefined();
    // And there is a way out, not just an apology.
    expect(screen.getByText('تلاش دوباره')).toBeDefined();
    expect(screen.getByText('بازگشت به داشبورد')).toBeDefined();
    spy.mockRestore();
  });

  it('recovers when the cause is gone', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    function Harness() {
      const [fail, setFail] = useState(true);
      return (
        <>
          <button onClick={() => setFail(false)}>رفع مشکل</button>
          <ErrorBoundary><Boom fail={fail} /></ErrorBoundary>
        </>
      );
    }
    render(<Harness />);
    expect(screen.getByRole('alert')).toBeDefined();

    fireEvent.click(screen.getByText('رفع مشکل'));
    fireEvent.click(screen.getByText('تلاش دوباره'));
    expect(screen.getByText('محتوای سالم')).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
    spy.mockRestore();
  });
});
