import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { AuthProvider } from './lib/auth';
import { ThemeProvider, applyStoredThemeEarly } from './lib/theme';
import { LocaleProvider, applyStoredLocaleEarly } from './lib/locale';
import { ToastProvider } from './components/ui';
import './index.css';

// Before the first paint, so a dark-mode user never sees a flash of the light interface.
applyStoredThemeEarly();
applyStoredLocaleEarly();

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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <LocaleProvider>
          <ThemeProvider>
          <AuthProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </AuthProvider>
        </ThemeProvider>
          </LocaleProvider>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
