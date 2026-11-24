// Release replacement for dev-hooks.ts: does nothing and imports nothing.
import type { DevToolsContext } from './dev-hooks.ts';

export function installDevTools(ctx: DevToolsContext): void {
  void ctx;
}
