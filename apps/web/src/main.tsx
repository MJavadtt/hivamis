import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import ApprovePublic from './pages/ApprovePublic';
import { AuthProvider } from './lib/auth';
import { ThemeProvider, applyStoredThemeEarly } from './lib/theme';
import { LocaleProvider, applyStoredLocaleEarly } from './lib/locale';
import { ToastProvider } from './components/ui';
import './index.css';

// Before the first paint, so a dark-mode user never sees a flash of the light interface.
applyStoredThemeEarly();
applyStoredLocaleEarly();

/**
 * The service worker caches the shell and the form catalogue so the app opens, and a form can
 * be filled, where there is no signal (roadmap #19). Registration is deliberately silent and
 * non-blocking: a browser that refuses it simply gets the online-only app.
 */
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      // A 401/403 is a definitive answer, not a transient failure — don't retry those.
      retry: (failureCount, error) => {
        const status = (error as { status?: number })?.status;
        if (status && status >= 400 && status < 500) return false;
        return failureCount < 2;
      },
    },
  },
});

/** A client's approval link (roadmap #35) is a page of its own: no sign-in, no session, no shell. */
const approvalToken = /^\/approve\/([\w-]{20,100})\/?$/.exec(window.location.pathname)?.[1] ?? null;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <LocaleProvider>
          <ThemeProvider>
          {approvalToken ? <ApprovePublic token={approvalToken} /> : (
          <AuthProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </AuthProvider>
          )}
        </ThemeProvider>
          </LocaleProvider>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
