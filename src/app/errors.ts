// Error classification and the global error boundary.
import type { Logger } from '../utils/log.ts';

export type AppErrorKind = 'network' | 'storage' | 'security' | 'platform' | 'navigation' | 'unexpected';

export interface AppError {
  kind: AppErrorKind;
  message: string;
  /** Safe to show to the user (never contains URLs or credentials). */
  userMessage: string;
}

const USER_MESSAGES: Record<AppErrorKind, string> = {
  network: 'The connection failed. Check the network and try again.',
  storage: 'Saved data could not be read or written.',
  security: 'This action is not available on this device.',
  platform: 'A TV function is not available.',
  navigation: 'That screen could not be opened.',
  unexpected: 'Something went wrong.'
};

export function appError(kind: AppErrorKind, message: string): AppError {
  return { kind: kind, message: message, userMessage: USER_MESSAGES[kind] };
}

export function toAppError(e: unknown, kind?: AppErrorKind): AppError {
  const k = kind || 'unexpected';
  if (e && typeof e === 'object' && typeof (e as AppError).kind === 'string' && typeof (e as AppError).userMessage === 'string') {
    return e as AppError;
  }
  const message = e instanceof Error ? e.message : String(e);
  return appError(k, message);
}

/** The global object surface used by the error boundary. Tests pass a fake. */
export interface ErrorTarget {
  onerror: ((msg: unknown, src?: unknown, line?: unknown, col?: unknown, err?: unknown) => boolean | void) | null;
  addEventListener?(type: string, cb: (ev: { reason?: unknown; preventDefault?: () => void }) => void): void;
  removeEventListener?(type: string, cb: (ev: { reason?: unknown; preventDefault?: () => void }) => void): void;
}

/**
 * Installs window.onerror and (where supported) unhandledrejection handlers. Every uncaught error is
 * logged (redacted) and passed to `onError`; the app keeps running. Returns an uninstall function.
 */
export function installErrorBoundary(target: ErrorTarget, log: Logger, onError: (e: AppError) => void): () => void {
  const previous = target.onerror;
  target.onerror = function (msg, _src, _line, _col, err) {
    const e = toAppError(err !== undefined && err !== null ? err : String(msg));
    log.error('uncaught error', { kind: e.kind }, err !== undefined && err !== null ? err : { name: 'Error', message: String(msg) });
    try { onError(e); } catch (x) { /* never throw from the boundary */ }
    return false;
  };
  function onRejection(ev: { reason?: unknown; preventDefault?: () => void }): void {
    const e = toAppError(ev && ev.reason !== undefined ? ev.reason : 'unhandled rejection');
    log.error('unhandled promise rejection', { kind: e.kind }, ev ? ev.reason : undefined);
    try { onError(e); } catch (x) { /* never throw from the boundary */ }
  }
  if (target.addEventListener) {
    target.addEventListener('unhandledrejection', onRejection);
  }
  return function () {
    target.onerror = previous;
    if (target.removeEventListener) {
      target.removeEventListener('unhandledrejection', onRejection);
    }
  };
}
