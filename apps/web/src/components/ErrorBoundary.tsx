import { Component, type ErrorInfo, type ReactNode } from 'react';
import { IconAlert } from './ui';
import { tr } from '../i18n';

/**
 * Catches a render-time exception so one broken page does not blank the whole application.
 *
 * Without this, any throw below <Routes> unmounts the tree and leaves a white screen with no
 * way back — the user cannot even reach the navigation to go somewhere else.
 *
 * Deliberately a class: React has no hook equivalent of componentDidCatch.
 */
interface Props { children: ReactNode }
interface State { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Kept for the browser console; there is no client error reporter to forward to yet.
    console.error('render error', error, info.componentStack);
  }

  private reset = (): void => this.setState({ error: null });

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="grid min-h-[60vh] place-items-center p-6" role="alert">
        <div className="w-full max-w-lg rounded-xl bg-rose-50 p-5 ring-1 ring-inset ring-rose-200">
          <div className="flex items-start gap-2.5">
            <IconAlert className="mt-0.5 size-5 shrink-0 text-rose-600" />
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold text-rose-800">{tr('نمایش این صفحه با خطا مواجه شد')}</h2>
              <p className="mt-1.5 text-xs leading-6 text-rose-700">{tr('اطلاعات شما از دست نرفته است. می‌توانید دوباره تلاش کنید یا به داشبورد برگردید. اگر خطا تکرار شد، متن زیر را به تیم فنی اعلام کنید.')}</p>

              <pre className="ltr mt-3 max-h-32 overflow-auto rounded-lg bg-surface/70 p-2.5 text-[11px] text-rose-900">
                {error.message || String(error)}
              </pre>

              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={this.reset}
                  className="rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-700
                             focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-600"
                >{tr('تلاش دوباره')}</button>
                <button
                  type="button"
                  onClick={() => { window.location.href = '/'; }}
                  className="rounded-lg bg-surface px-3 py-1.5 text-xs font-medium text-rose-700 ring-1 ring-inset ring-rose-300
                             hover:bg-rose-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-600"
                >{tr('بازگشت به داشبورد')}</button>
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="rounded-lg px-3 py-1.5 text-xs text-rose-700 hover:underline
                             focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-600"
                >{tr('بارگذاری مجدد')}</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
