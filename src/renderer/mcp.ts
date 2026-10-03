// Settings → "AI agents (MCP) and phone approvals" (item 3). Chrome only: it shows the connection
// command and the server state, and sends the user's choices to main. The bot token goes IN through
// phone:set and never comes back out (phone:state only says whether one is saved).

interface Bridge {
  invoke(channel: string, ...args: unknown[]): Promise<any>;
  on(channel: string, fn: (payload: any) => void): void;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

interface McpState {
  enabled: boolean;
  running: boolean;
  port: number | null;
  command: string;
  hermes: string;
  sessions: Array<{ client: string; version: string }>;
  task: { client: string; status: string } | null;
}

export function initMcpSettings(gb: Bridge): { refresh(): Promise<void> } {
  function paint(s: McpState) {
    $<HTMLInputElement>('mcp-enabled').checked = s.enabled;
    const clients = s.sessions.map((x) => `“${x.client}”`).join(', ');
    $('mcp-status').textContent = s.running
      ? `Serving on 127.0.0.1:${s.port} (loopback only, bearer token in mcp.json, mode 0600).${clients ? ` Connected: ${clients}.` : ' No client connected.'}${s.task ? ` MCP task: ${s.task.status} for “${s.task.client}”.` : ''}`
      : 'Off: nothing is listening.';
    $<HTMLTextAreaElement>('mcp-command').value = s.command;
    $<HTMLTextAreaElement>('mcp-hermes').value = s.hermes;
    $<HTMLButtonElement>('mcp-revoke').disabled = !s.running;
  }
  async function refresh() {
    paint(await gb.invoke('mcp:state'));
    const p = await gb.invoke('phone:state');
    $<HTMLInputElement>('ph-enabled').checked = p.enabled;
    $<HTMLSelectElement>('ph-scope').value = p.scope;
    $<HTMLInputElement>('ph-chat').value = p.chatId;
    $<HTMLInputElement>('ph-token').value = '';
    $<HTMLInputElement>('ph-token').placeholder = p.hasToken ? 'bot token saved (type to replace)' : 'bot token from @BotFather';
    $('ph-msg').textContent = p.enabled ? (p.active ? 'phone approvals on' : 'needs a bot token and your user id') : '';
  }
  $<HTMLInputElement>('mcp-enabled').onchange = async () => {
    paint(await gb.invoke('mcp:set', $<HTMLInputElement>('mcp-enabled').checked));
    $('mcp-msg').textContent = '';
  };
  $('mcp-copy').onclick = async () => {
    await gb.invoke('mcp:copy');
    $('mcp-msg').textContent = 'copied';
  };
  $('mcp-revoke').onclick = async () => {
    paint(await gb.invoke('mcp:revoke'));
    $('mcp-msg').textContent = 'token revoked: connected clients must reconnect (the launcher does this by itself)';
  };
  $('ph-save').onclick = async () => {
    const r = await gb.invoke('phone:set', {
      enabled: $<HTMLInputElement>('ph-enabled').checked,
      scope: $<HTMLSelectElement>('ph-scope').value,
      chatId: $<HTMLInputElement>('ph-chat').value,
      token: $<HTMLInputElement>('ph-token').value,
    });
    if (!r.ok) {
      $('ph-msg').textContent = `not saved: ${r.error}`;
      return;
    }
    await refresh();
    $('ph-msg').textContent = 'saved';
  };
  $('ph-forget').onclick = async () => {
    await gb.invoke('phone:set', { clearToken: true });
    await refresh();
    $('ph-msg').textContent = 'bot token removed';
  };
  $('ph-test').onclick = async () => {
    $('ph-msg').textContent = 'sending…';
    const r = await gb.invoke('phone:test');
    $('ph-msg').textContent = r.ok ? 'test message sent: check Telegram' : `failed: ${r.error}`;
  };
  gb.on('mcp', (s: McpState) => paint(s));
  return { refresh };
}
