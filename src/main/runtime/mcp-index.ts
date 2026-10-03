// userData/mcp.json (item 3): the loopback URL and bearer token of every open profile that serves
// MCP, for the stdio launcher (src/mcp-stdio.ts). Written 0600 by main.ts; removed when no profile
// serves MCP. No Electron here, so it is unit-tested with the launcher.

import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFile } from '../../core/persist';

export interface McpIndexEntry {
  profileId: string;
  profile: string;
  url: string;
  token: string;
}

export function writeMcpIndex(userData: string, entries: McpIndexEntry[]) {
  const file = join(userData, 'mcp.json');
  if (!entries.length) {
    if (existsSync(file)) rmSync(file, { force: true });
    return;
  }
  atomicWriteFile(file, JSON.stringify({ version: 1, pid: process.pid, servers: entries }, null, 2) + '\n', { mode: 0o600 });
}
