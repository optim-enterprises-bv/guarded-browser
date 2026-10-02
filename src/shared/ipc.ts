// The ONE registry of chrome IPC channels. The chrome preload (src/main/preload.ts) exposes exactly
// these, and main.ts registers exactly these with ipcMain.handle — so a channel can no longer be
// added to one allowlist and forgotten in another (the failure ticket 02 hit: a click that silently
// did nothing, "No handler registered for ...").
//
// Data only, no imports: esbuild inlines this into the sandboxed preload bundle, which cannot
// `require` anything but electron. test/unit/ipc-channels.test.ts holds the registry against the
// handlers that actually exist in runtime.ts and main.ts.

/** Mail (ticket 37c) is a PANEL in the browser window, so its channels are ordinary chrome channels. */
export const MAIL_CHANNELS = [
  'mail:state',
  'mail:accounts',
  'mail:account-save',
  'mail:account-remove',
  'mail:account-test',
  'mail:secret-state',
  'mail:secret-mode',
  'mail:unlock',
  'mail:folders',
  'mail:list',
  'mail:message',
  // the HTML reading view: show a message id (0 = clear), report the reading pane's rect (or null),
  // and the per-message remote-image opt-in. The HTML never crosses this bridge; ids and rects do.
  'mail:view-show',
  'mail:view-rect',
  'mail:view-load-remote',
  'mail:search',
  'mail:view-set',
  'mail:sync',
  'mail:sync-all',
  'mail:flags',
  'mail:move',
  'mail:import-scan',
  'mail:import-apply',
] as const;

/** Profile management: handled in main.ts itself (it spans profiles), still sender-checked. */
export const PROFILE_CHANNELS = ['profiles:list', 'profiles:create', 'profiles:update', 'profiles:open', 'profiles:delete'] as const;

/** Handled by the SENDING window's profile runtime (runtime.ts `handlers` table). */
export const RUNTIME_CHANNELS = [
  'state:get', 'tabs:new', 'tabs:close', 'tabs:reopen', 'tabs:closed-list', 'tabs:guard-state', 'tabs:activate', 'tabs:select', 'tiles:tile', 'tiles:untile', 'tiles:layout', 'tiles:drag', 'tiles:state',
  'tabs:move', 'tabs:duplicate', 'tabs:close-others', 'tabs:close-right', 'tabs:mute',
  'zoom:get', 'zoom:set', 'zoom:step', 'zoom:reset', 'find:start', 'find:stop', 'page:print',
  'downloads:list', 'downloads:action', 'downloads:clear', 'search:get', 'session:info', 'chord',
  // wave 2 (tickets 14-33)
  'bookmarks:set-description', 'bookmarks:set-speeddial', 'bookmarks:sort', 'bookmarks:trash', 'bookmarks:trash-empty', 'bookmarks:trash-restore', 'bookmarks:tree-sorted', 'bundle:dry-run', 'bundle:export', 'bundle:export-file', 'bundle:import', 'bundle:import-file', 'capture:run', 'capture:to-clipboard', 'action:run', 'commands:search', 'extensions:add', 'extensions:enable', 'extensions:list', 'extensions:pick', 'extensions:remove', 'extensions:set-enabled', 'gesture:trail', 'hibernation:set', 'hibernation:state', 'hibernation:sweep', 'keybindings:get', 'keybindings:reset', 'keybindings:save', 'pageactions:get', 'pageactions:set', 'panel:refresh', 'panels:state', 'panels:list', 'panels:add', 'panels:open-current', 'panels:remove', 'panels:close', 'panels:rect', 'panels:show', 'panels:show-view', 'profiles:create-ephemeral', 'rail:set', 'reader:open', 'sessions:delete', 'sessions:export', 'sessions:list', 'sessions:rename', 'sessions:restore', 'sessions:save', 'stacks:close', 'stacks:collapse', 'stacks:color', 'stacks:create', 'stacks:dissolve', 'stacks:list', 'stacks:rename', 'status:set', 'tabstrip:set', 'translate:run', 'translate:set', 'translate:state', 'workspaces:create', 'workspaces:delete', 'workspaces:list', 'workspaces:rename', 'workspaces:switch',
  'nav:go', 'nav:back', 'nav:forward', 'nav:reload', 'agent:preview', 'agent:start', 'agent:stop', 'confirm:answer', 'egress:allow',
  'settings:get', 'settings:save', 'audit:recent', 'reputation:refresh', 'appearance:get', 'appearance:save', 'theme:import', 'theme:import-file', 'theme:export-file',
  'history:list', 'history:delete', 'history:delete-range', 'history:clear-on-exit', 'history:open', 'bookmarks:tree', 'bookmarks:add', 'bookmarks:add-current', 'bookmarks:add-folder', 'bookmarks:update', 'bookmarks:remove', 'bookmarks:move', 'bookmarks:search', 'bookmarks:set-bar', 'bookmarks:is-bookmarked', 'bookmarks:open', 'bookmarks:import', 'bookmarks:import-file', 'bookmarks:export', 'bookmarks:export-file', 'suggest', 'favicon:get', 'chrome:insets', 'chrome:overlay',
  ...MAIL_CHANNELS,
] as const;

/** Everything the chrome renderer may `invoke`. */
export const INVOKE_CHANNELS: readonly string[] = [...RUNTIME_CHANNELS, ...PROFILE_CHANNELS];

/** Everything main may push to the chrome renderer (`gb.on`). Mail is request/response: no mail text is ever pushed. */
export const EVENT_CHANNELS = [
  'state', 'tabs', 'agent:update', 'agent:done', 'confirm:request', 'confirm:clear', 'audit', 'egress', 'fallback', 'reputation', 'geometry', 'appearance', 'site-accent', 'profiles', 'profiles:show-manager', 'bookmarks', 'closed-tabs', 'downloads', 'zoom', 'find:result', 'session:crashed', 'shortcut', 'panels', 'panels:list', 'page:contextmenu', 'stacks', 'workspaces', 'sessions', 'keybindings', 'translate', 'extensions', 'tabstrip', 'gesture', 'history', 'mail',
] as const;
