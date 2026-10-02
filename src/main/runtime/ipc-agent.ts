// Chrome IPC: the agent task, confirmations and the per-task egress allowance.
// Moved out of runtime.ts unchanged; live runtime state is read through `rt` (getters).

import type { ConfirmOutcome } from '../../core/types';
import type { Handler } from '../runtime';
import type { RuntimeDeps } from './deps';

export function register(on: (channel: string, fn: Handler) => void, rt: RuntimeDeps) {
  const { handlers, previewOrigins, startTask, stopTask } = rt;
  on('agent:preview', (_e, text: string) => previewOrigins(String(text)));
  on('agent:start', (_e, text: string, origins?: string[]) => startTask(String(text), Array.isArray(origins) ? origins.map(String) : undefined));
  // asked synchronously by the tab preload at document start: is an agent task driving this tab?
  handlers['tab:agent-active'] = (e) => !!rt.current && rt.current.tab.wc === e.sender;
  on('agent:stop', () => stopTask());
  on('confirm:answer', (_e, id: string, outcome: ConfirmOutcome) => {
    if (['approve', 'deny', 'stop'].includes(outcome)) rt.broker.answer(id, outcome);
    if (outcome === 'stop') stopTask();
  });
  on('egress:allow', (_e, host: string) => {
    if (!rt.current) return;
    rt.egress.allowHost(host);
    rt.audit.write('egress', { taskId: rt.current.task.id, layer: 'proxy', decision: 'allow', host, method: '-', reason: 'user allowed host for this task' });
  });
}
