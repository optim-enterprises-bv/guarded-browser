// UI preload: a narrow, allowlisted bridge. Only the agent-panel UI gets it; web pages never do.
import { contextBridge, ipcRenderer } from 'electron';

const INVOKE = new Set([
  'state:get', 'tabs:new', 'tabs:close', 'tabs:reopen', 'tabs:closed-list', 'tabs:guard-state', 'tabs:activate', 'tabs:select', 'tiles:tile', 'tiles:untile', 'tiles:layout', 'tiles:drag', 'tiles:state', 'nav:go', 'nav:back', 'nav:forward', 'nav:reload',
  'tabs:move', 'tabs:duplicate', 'tabs:close-others', 'tabs:close-right', 'tabs:mute',
  'zoom:get', 'zoom:set', 'zoom:step', 'zoom:reset', 'find:start', 'find:stop', 'page:print',
  'downloads:list', 'downloads:action', 'downloads:clear', 'search:get', 'session:info', 'page:contextmenu', 'chord',
  // wave 2 (tickets 14-33)
  'bookmarks:set-description', 'bookmarks:set-speeddial', 'bookmarks:sort', 'bookmarks:trash', 'bookmarks:trash-empty', 'bookmarks:trash-restore', 'bookmarks:tree-sorted', 'bundle:dry-run', 'bundle:export', 'bundle:export-file', 'bundle:import', 'bundle:import-file', 'capture:run', 'capture:to-clipboard', 'action:run', 'commands:search', 'extensions:add', 'extensions:enable', 'extensions:list', 'extensions:pick', 'extensions:remove', 'extensions:set-enabled', 'gesture:trail', 'hibernation:set', 'hibernation:state', 'hibernation:sweep', 'keybindings:get', 'keybindings:reset', 'keybindings:save', 'pageactions:get', 'pageactions:set', 'panel:refresh', 'panels:state', 'panels:list', 'panels:add', 'panels:open-current', 'panels:remove', 'panels:close', 'panels:rect', 'panels:show', 'panels:show-view', 'profiles:create-ephemeral', 'rail:set', 'reader:open', 'sessions:delete', 'sessions:export', 'sessions:list', 'sessions:rename', 'sessions:restore', 'sessions:save', 'stacks:close', 'stacks:collapse', 'stacks:color', 'stacks:create', 'stacks:dissolve', 'stacks:list', 'stacks:rename', 'status:set', 'tabstrip:set', 'translate:run', 'translate:set', 'translate:state', 'workspaces:create', 'workspaces:delete', 'workspaces:list', 'workspaces:rename', 'workspaces:switch',
  'agent:preview', 'agent:start', 'agent:stop', 'confirm:answer', 'egress:allow', 'settings:get', 'settings:save', 'audit:recent', 'reputation:refresh', 'appearance:get', 'appearance:save', 'theme:import', 'theme:import-file', 'theme:export-file',
  'profiles:list', 'profiles:create', 'profiles:update', 'profiles:open', 'profiles:delete',
  'history:list', 'history:delete', 'history:delete-range', 'history:clear-on-exit', 'history:open', 'bookmarks:tree', 'bookmarks:add', 'bookmarks:add-current', 'bookmarks:add-folder', 'bookmarks:update', 'bookmarks:remove', 'bookmarks:move', 'bookmarks:search', 'bookmarks:set-bar', 'bookmarks:is-bookmarked', 'bookmarks:open', 'bookmarks:import', 'bookmarks:import-file', 'bookmarks:export', 'bookmarks:export-file', 'suggest', 'favicon:get', 'chrome:insets', 'chrome:overlay',
 // mail, ticket 37c: a panel in this window, so its channels live on the chrome bridge
 'mail:state', 'mail:accounts', 'mail:account-save', 'mail:account-remove', 'mail:account-test',
 'mail:secret-state', 'mail:secret-mode', 'mail:unlock', 'mail:folders', 'mail:list', 'mail:message',
 'mail:search', 'mail:view-set', 'mail:sync', 'mail:sync-all', 'mail:flags', 'mail:move',
 'mail:import-scan', 'mail:import-apply',
 ]);
const EVENTS = new Set(['state', 'tabs', 'agent:update', 'agent:done', 'confirm:request', 'confirm:clear', 'audit', 'egress', 'fallback', 'reputation', 'geometry', 'appearance', 'site-accent', 'profiles', 'profiles:show-manager', 'bookmarks', 'closed-tabs', 'downloads', 'zoom', 'find:result', 'session:crashed', 'shortcut', 'panels', 'panels:list', 'page:contextmenu', 'stacks', 'workspaces', 'sessions', 'keybindings', 'translate', 'extensions', 'tabstrip', 'gesture', 'history', 'mail']);

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
