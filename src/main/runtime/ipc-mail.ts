// Chrome IPC: mail (ticket 37c). A panel in this window, so its handlers sit on the same
// sender-resolved table as every other chrome channel.
// Moved out of runtime.ts unchanged; live runtime state is read through `rt` (getters).

import type { Handler } from '../runtime';
import type { RuntimeDeps } from './deps';

export function register(on: (channel: string, fn: Handler) => void, rt: RuntimeDeps) {
  // ---------- mail (ticket 37c): same sender-resolved table as every other chrome channel ----------
  // The controller is created on first call, so a profile with no mail never opens a store.
  const mailCtrl = () => rt.mail();
  on('mail:state', () => mailCtrl().state());
  on('mail:accounts', () => {
    const st = mailCtrl().state();
    return { accounts: st.accounts, keychain: st.keychain };
  });
  on('mail:folders', (_e, accountId: unknown) => mailCtrl().folders(String(accountId ?? '')));
  on('mail:list', (_e, opts: unknown) => mailCtrl().list((opts ?? {}) as { accountId?: string; folder?: string }));
  on('mail:search', (_e, q: unknown, opts: unknown) => mailCtrl().search(String(q ?? ''), (opts ?? {}) as { accountId?: string }));
  on('mail:message', (_e, id: unknown, opts: unknown) => mailCtrl().message(Number(id), (opts ?? {}) as { markRead?: boolean }));
  // the HTML reading view (src/main/mail/html-view.ts): ids and a rect in, booleans out — never HTML
  on('mail:view-show', (_e, id: unknown) => rt.mailView().show(Number(id) || 0));
  on('mail:view-rect', (_e, r: unknown) => {
    const o = (r ?? null) as { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | null;
    const n = (v: unknown, max: number) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));
    rt.mailView().setRect(o ? { x: n(o.x, 16_384), y: n(o.y, 16_384), width: n(o.width, 16_384), height: n(o.height, 16_384) } : null);
    return { ok: true };
  });
  on('mail:view-load-remote', (_e, id: unknown) => rt.mailView().loadRemote(Number(id) || 0));
  on('mail:sync', (_e, id: unknown) => mailCtrl().sync(String(id ?? '')));
  on('mail:sync-all', () => mailCtrl().syncAll());
  on('mail:flags', (_e, ids: unknown, patch: unknown) => mailCtrl().setFlags(ids, patch));
  on('mail:move', (_e, ids: unknown, to: unknown) => mailCtrl().move(ids, String(to ?? '')));
  on('mail:view-set', (_e, patch: unknown) => mailCtrl().viewSet(patch));
  on('mail:unlock', (_e, pass: unknown) => mailCtrl().unlock(String(pass ?? '')));
  on('mail:secret-state', () => {
    const st = mailCtrl().state();
    return { mode: st.secretMode, locked: st.locked, keychain: st.keychain, warning: st.warning };
  });
  on('mail:secret-mode', (_e, mode: unknown, pass: unknown) => mailCtrl().secretMode(String(mode ?? ''), String(pass ?? '')));
  on('mail:account-save', (_e, input: unknown, secret: unknown) => mailCtrl().saveAccount(input, secret));
  on('mail:account-remove', (_e, id: unknown) => mailCtrl().removeAccount(String(id ?? '')));
  on('mail:account-test', (_e, id: unknown) => mailCtrl().testAccount(String(id ?? '')));
  on('mail:import-scan', (_e, path: unknown) => mailCtrl().importScan(typeof path === 'string' ? path : undefined));
  on('mail:import-apply', (_e, path: unknown, ids: unknown) => mailCtrl().importApply(typeof path === 'string' ? path : undefined, ids));
}
