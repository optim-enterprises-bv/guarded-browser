// UI preload: a narrow, allowlisted bridge. Only the agent-panel UI gets it; web pages never do.
import { contextBridge, ipcRenderer } from 'electron';

const INVOKE = new Set([
  'state:get', 'tabs:new', 'tabs:close', 'tabs:activate', 'nav:go', 'nav:back', 'nav:forward', 'nav:reload',
  'agent:preview', 'agent:start', 'agent:stop', 'confirm:answer', 'egress:allow', 'settings:get', 'settings:save', 'audit:recent', 'reputation:refresh',
]);
const EVENTS = new Set(['state', 'tabs', 'agent:update', 'agent:done', 'confirm:request', 'confirm:clear', 'audit', 'egress', 'fallback', 'reputation']);

contextBridge.exposeInMainWorld('gb', {
  invoke: (channel: string, ...args: unknown[]) => {
    if (!INVOKE.has(channel)) throw new Error(`channel not allowed: ${channel}`);
    return ipcRenderer.invoke(channel, ...args);
  },
  on: (channel: string, fn: (payload: unknown) => void) => {
    if (!EVENTS.has(channel)) throw new Error(`event not allowed: ${channel}`);
    ipcRenderer.on(channel, (_e, payload) => fn(payload));
  },
});
