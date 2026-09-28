// Prompt-injection guard: ProtectAI deberta-v3-base-prompt-injection-v2 on CPU via transformers.js.
// Probabilistic: it reduces what reaches the models, it is not the security boundary.

import { WITHHELD, type Guard, type GuardVerdict } from './types';

/**
 * Chunk size in characters. Small chunks stop an injection from being diluted by surrounding
 * benign text (measured on the fixtures: 1000-char chunks missed 2/10 injections, 200 missed 0/10).
 */
export const CHUNK_CHARS = 200;

/** Split text into chunks of at most CHUNK_CHARS, preferring line / sentence boundaries.
 *  Whitespace is collapsed: the model scores the same text very differently with raw newlines. */
export function chunkText(text: string, max = CHUNK_CHARS): string[] {
  const pieces = text.split(/(?<=[.!?\n])\s+/).flatMap((p) => {
    const out: string[] = [];
    for (let i = 0; i < p.length; i += max) out.push(p.slice(i, i + max));
    return out;
  });
  const chunks: string[] = [];
  let cur = '';
  for (const p of pieces) {
    if (cur && cur.length + p.length + 1 > max) {
      chunks.push(cur);
      cur = '';
    }
    cur = cur ? `${cur} ${p}` : p;
  }
  if (cur.trim()) chunks.push(cur);
  return chunks.map((c) => c.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

type Classifier = (texts: string[], opts?: Record<string, unknown>) => Promise<Array<{ label: string; score: number }>>;

export interface GuardOptions {
  model: string;
  threshold: number;
  threads: number;
  cacheDir?: string;
  enabled: boolean;
}

export class TransformersGuard implements Guard {
  private classifier: Classifier | null = null;
  private state: 'ready' | 'loading' | 'unavailable' | 'disabled';
  private detail = '';
  private loading: Promise<void> | null = null;
  private cache = new Map<string, number>();

  constructor(private readonly opts: GuardOptions) {
    this.state = opts.enabled ? 'loading' : 'disabled';
    this.detail = opts.enabled ? 'loading model' : 'guard disabled in settings';
  }

  status() {
    return this.state;
  }

  statusDetail() {
    return this.detail;
  }

  /** Load the model. Never throws: on failure the guard is marked unavailable. */
  load(): Promise<void> {
    if (!this.opts.enabled) return Promise.resolve();
    this.loading ??= (async () => {
      try {
        const tf = await import('@huggingface/transformers');
        if (this.opts.cacheDir) tf.env.cacheDir = this.opts.cacheDir;
        tf.env.allowLocalModels = false;
        const pipe = await tf.pipeline('text-classification', this.opts.model, {
          dtype: 'fp32',
          device: 'cpu',
          session_options: { intraOpNumThreads: this.opts.threads, interOpNumThreads: 1 },
        });
        this.classifier = pipe as unknown as Classifier;
        this.state = 'ready';
        this.detail = `${this.opts.model} (threshold ${this.opts.threshold})`;
      } catch (e) {
        this.state = 'unavailable';
        this.detail = `guard unavailable: ${(e as Error).message.slice(0, 300)}`;
      }
    })();
    return this.loading;
  }

  async classify(texts: string[]): Promise<GuardVerdict[]> {
    if (this.state === 'loading') await this.load();
    const clf = this.classifier;
    if (!clf) return texts.map((text) => ({ text, score: -1, flagged: false }));
    const todo = [...new Set(texts.filter((t) => t.trim() && !this.cache.has(t)))];
    for (let i = 0; i < todo.length; i += 16) {
      const batch = todo.slice(i, i + 16);
      const out = await clf(batch, { truncation: true, max_length: 512 } as Record<string, unknown>);
      const arr = Array.isArray(out) ? out : [out];
      batch.forEach((t, j) => {
        const r = (Array.isArray(arr[j]) ? (arr[j] as unknown as Array<{ label: string; score: number }>)[0] : arr[j]) ?? { label: 'SAFE', score: 1 };
        const score = /INJECTION/i.test(r.label) ? r.score : 1 - r.score;
        if (this.cache.size > 5000) this.cache.clear();
        this.cache.set(t, score);
      });
    }
    return texts.map((text) => {
      const score = text.trim() ? this.cache.get(text) ?? 0 : 0;
      return { text, score, flagged: score >= this.opts.threshold };
    });
  }
}

export interface Screened {
  text: string;
  flaggedChunks: number;
  maxScore: number;
  verdicts: GuardVerdict[];
  guardStatus: string;
}

/** Screen a long text: chunk it, replace flagged chunks with the withheld placeholder. */
export async function screenText(guard: Guard, text: string): Promise<Screened> {
  const chunks = chunkText(text);
  const verdicts = await guard.classify(chunks);
  const out = verdicts.map((v) => (v.flagged ? WITHHELD : v.text)).join('\n');
  return {
    text: out,
    flaggedChunks: verdicts.filter((v) => v.flagged).length,
    maxScore: Math.max(0, ...verdicts.map((v) => v.score)),
    verdicts,
    guardStatus: guard.status(),
  };
}

/** A guard that never flags anything (used when the guard is disabled or for tests). */
export class NullGuard implements Guard {
  constructor(private readonly reason = 'guard disabled') {}
  status() {
    return 'disabled' as const;
  }
  statusDetail() {
    return this.reason;
  }
  async classify(texts: string[]) {
    return texts.map((text) => ({ text, score: -1, flagged: false }));
  }
}
