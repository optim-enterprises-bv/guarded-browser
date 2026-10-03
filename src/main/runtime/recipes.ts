// Recipes for ONE profile (item 5): record what a normal agent task did, "Save as recipe" after it
// finished, and the Recipes panel (run, parameters, auto steps, rename, delete, export / import).
//
// Recording reads nothing new from the model's side: the agent hands every executed, successful
// action to the recorder (AgentDeps.onExecuted) with the element facts our own snapshot script
// computed. Replay (core/recipe-replay.ts) runs with no model; the runtime gives it the agent task's
// lifecycle (rt.startReplay). MCP tasks are not recorded: the user did not give that task.

import { join } from 'node:path';
import type { TaskResult } from '../../core/agent';
import type { ExecutedAction } from '../../core/agent';
import type { ExtractType, PageInfo } from '../../core/locator';
import { parseDate } from '../../core/locator';
import {
  RecipeRecorder,
  RecipeStore,
  autoRefusal,
  describeStep,
  exportRecipe,
  isReadOnly,
  parseRecipeImport,
  resolveParams,
  type Recipe,
} from '../../core/recipe';
import type { TaintRegistry } from '../../core/taint';
import { WITHHELD, type Snapshot } from '../../core/types';
import type { ElectronDriver } from '../tabs';
import type { Handler } from '../runtime';
import type { RuntimeDeps } from './deps';

const info = (s: Snapshot | null): PageInfo => ({ url: s?.url ?? '', title: s?.title ?? '', heading: s?.heading ?? '' });

export function register(on: (channel: string, fn: Handler) => void, rt: RuntimeDeps) {
  const store = new RecipeStore(join(rt.profileDir, 'recipes.json'));
  /** the last finished task's recording, until it is saved or another task starts */
  let pending: { taskId: string; task: string; recorder: RecipeRecorder } | null = null;
  const audit = (detail: Record<string, unknown>) => rt.audit.write('recipe', detail);

  function view(r: Recipe) {
    return {
      id: r.id,
      name: r.name,
      createdAt: r.createdAt,
      origins: r.origins,
      readOnly: isReadOnly(r),
      params: r.params.map((p) => ({ name: p.name, kind: p.kind, from: p.from, note: p.note, ...(p.kind === 'text' && p.default !== undefined ? { default: p.default } : {}) })),
      steps: r.steps.map((s) => ({ kind: s.kind, text: describeStep(s, r.params), auto: s.auto, autoRefusal: autoRefusal(s, r.params) })),
    };
  }
  const push = () => rt.sendUI('recipes', store.list().map(view));

  /** what a starting agent task records into (runtime.ts startTask) */
  function beginRecording(driver: ElectronDriver, taint: () => TaintRegistry, task: string) {
    pending = null;
    const recorder = new RecipeRecorder((t) => taint().sensitiveIn(t).map((v) => ({ value: v.value, sensitivity: v.sensitivity })));
    return {
      onExecuted: async (ev: ExecutedAction) => {
        let extracted: Array<{ field: string; type: ExtractType; candidate: unknown | null }> | undefined;
        if (ev.extracted) {
          extracted = [];
          for (const [field, v] of Object.entries(ev.extracted).slice(0, 8)) {
            if ((typeof v !== 'number' && typeof v !== 'string') || v === WITHHELD || v === '') continue;
            const type: ExtractType = typeof v === 'number' ? 'number' : /^\d{4}-\d{2}-\d{2}$/.test(v) && parseDate(v) ? 'date' : 'text';
            // the value as the reader returned it, and as a page usually prints a number
            const variants = typeof v === 'number' ? [String(v), v.toFixed(2), v.toLocaleString('en-US'), v.toLocaleString('en-US', { minimumFractionDigits: 2 })] : [v];
            let candidate: unknown | null = null;
            for (const x of [...new Set(variants)]) {
              candidate = await driver.locateText(x);
              if (candidate) break;
            }
            extracted.push({ field, type, candidate });
          }
        }
        recorder.add({ action: ev.action, before: info(ev.before), after: info(ev.after), element: ev.element, value: ev.value, extracted });
      },
      /** the task ended: a finished one with recorded steps can be saved */
      done(r: TaskResult): { steps: number } | null {
        if (r.status !== 'finished' || !recorder.length) return null;
        pending = { taskId: r.taskId, task, recorder };
        return { steps: recorder.length };
      },
    };
  }

  on('recipe:draft', () => {
    if (!pending) return { ok: false, error: 'no finished task to save (only a task that finished can be saved as a recipe)' };
    return { ok: true, taskId: pending.taskId, task: pending.task, steps: pending.recorder.preview(), skipped: pending.recorder.skipped };
  });
  on('recipe:save', (_e, name: unknown) => {
    if (!pending) return { ok: false, error: 'no finished task to save' };
    let recipe: Recipe;
    try {
      recipe = pending.recorder.toRecipe(String(name ?? '') || pending.task.slice(0, 60));
    } catch (e) {
      return { ok: false, error: `the recording could not be saved: ${String((e as Error).message).slice(0, 200)}` };
    }
    const r = store.add(recipe);
    if (!r.ok) return r;
    audit({ what: 'saved', recipe: recipe.id, fromTask: pending.taskId, steps: recipe.steps.length, origins: recipe.origins, params: recipe.params.map((p) => ({ name: p.name, kind: p.kind, stored: p.default !== undefined })) });
    pending = null;
    push();
    return { ok: true, recipe: view(r.recipe) };
  });
  on('recipe:list', () => store.list().map(view));
  on('recipe:rename', (_e, id: unknown, name: unknown) => {
    const ok = store.rename(String(id), name);
    if (ok) push();
    return { ok };
  });
  on('recipe:delete', (_e, id: unknown) => {
    const ok = store.remove(String(id));
    if (ok) {
      audit({ what: 'deleted', recipe: String(id) });
      push();
    }
    return { ok };
  });
  on('recipe:export', (_e, id: unknown) => {
    const r = store.get(String(id));
    return r ? { ok: true, json: exportRecipe(r) } : { ok: false, error: 'no such recipe' };
  });
  on('recipe:import', (_e, text: unknown) => {
    const p = parseRecipeImport(text);
    if (!p.ok) return p;
    const r = store.add(p.recipe);
    if (!r.ok) return r;
    audit({ what: 'imported', recipe: p.recipe.id, steps: p.recipe.steps.length, origins: p.recipe.origins });
    push();
    return { ok: true, recipe: view(r.recipe) };
  });
  on('recipe:auto', (_e, id: unknown, step: unknown, on: unknown) => {
    const r = store.setAuto(String(id), Number(step), on === true);
    if (r.ok) {
      audit({ what: on === true ? 'step set to auto' : 'step set to confirm', recipe: String(id), step: Number(step) + 1 });
      push();
    }
    return r;
  });
  on('recipe:defaults', (_e, id: unknown, values: unknown) => {
    const r = store.setDefaults(String(id), (values ?? {}) as Record<string, unknown>);
    if (r.ok) push();
    return r;
  });
  on('recipe:run', async (_e, id: unknown, values: unknown) => {
    const r = store.get(String(id));
    if (!r) return { ok: false, error: 'no such recipe' };
    if (rt.current) return { ok: false, error: 'a task is already running' };
    const p = resolveParams(r, (values ?? {}) as Record<string, unknown>);
    if (!p.ok) return { ok: false, error: `missing: ${p.missing.join(', ')}`, missing: p.missing };
    try {
      const taskId = await rt.startReplay(r, p.values);
      audit({ what: 'replay started', recipe: r.id, taskId });
      return { ok: true, taskId };
    } catch (e) {
      return { ok: false, error: String((e as Error).message).slice(0, 200) };
    }
  });

  return {
    beginRecording,
    store,
    /** a new task replaces the saveable recording */
    forgetPending() {
      pending = null;
    },
  };
}
