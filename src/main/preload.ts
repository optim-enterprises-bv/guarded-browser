// UI preload: a narrow, allowlisted bridge. Only the agent-panel UI gets it; web pages never do.
import { contextBridge, ipcRenderer } from 'electron';
import { EVENT_CHANNELS, INVOKE_CHANNELS } from '../shared/ipc';

// The allowlists come from the single channel registry (bundled into this preload by esbuild).
const INVOKE = new Set<string>(INVOKE_CHANNELS);
const EVENTS = new Set<string>(EVENT_CHANNELS);

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
