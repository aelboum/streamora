// Runs `then` at once when the content is not adult or nothing is locked; otherwise asks for the
// parental PIN first (pin-dialog, mode verify) and runs `then` after it was entered correctly.
import type { Router } from '../navigation/router.ts';
import type { Parental } from '../services/parental.ts';
import type { PinDialogParams } from './pin-dialog.ts';

export function isLocked(parental: Parental | null | undefined, adult: boolean): boolean {
  return adult && !!parental && parental.locked();
}

export function withParental(nav: Router, parental: Parental | null | undefined, adult: boolean, reason: string, then: () => void): void {
  if (!isLocked(parental, adult)) {
    then();
    return;
  }
  const pp: PinDialogParams = { mode: 'verify', reason: reason, onDone: then };
  nav.openOverlay('pin-dialog', pp as unknown as Record<string, unknown>);
}
