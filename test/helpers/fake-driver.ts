// In-memory browser for agent-loop unit tests. Records every outward effect.
import type { ActionOutcome, BrowserDriver } from '../../src/core/agent';
import type { Guard, Snapshot, SnapshotElement } from '../../src/core/types';

export interface FakePage {
  title: string;
  text: string;
  elements: SnapshotElement[];
}

export class FakeDriver implements BrowserDriver {
  url = 'about:blank';
  navigations: string[] = [];
  submissions: Array<{ action: string; fields: Record<string, string> }> = [];
  fields: Record<string, string> = {};

  constructor(private readonly pages: Record<string, FakePage>) {}

  private page(): FakePage {
    return this.pages[this.url] ?? { title: 'Not found', text: '404', elements: [] };
  }
  private el(ref: string) {
    return this.page().elements.find((e) => e.ref === ref);
  }
  currentUrl() {
    return this.url;
  }
  async navigate(url: string): Promise<ActionOutcome> {
    this.navigations.push(url);
    this.url = url;
    this.fields = {};
    return { ok: true };
  }
  async snapshot(): Promise<Snapshot> {
    return { url: this.url, title: this.page().title, elements: this.page().elements };
  }
  async pageText() {
    return this.page().text;
  }
  async click(ref: string): Promise<ActionOutcome> {
    const e = this.el(ref);
    if (!e) return { ok: false, detail: 'no such element' };
    if (e.href) return this.navigate(e.href);
    if (e.isSubmit) return this.submit(ref);
    return { ok: true };
  }
  async type(ref: string, text: string): Promise<ActionOutcome> {
    const e = this.el(ref);
    if (!e) return { ok: false, detail: 'no such element' };
    this.fields[e.name] = text;
    return { ok: true };
  }
  async select(ref: string, value: string) {
    return this.type(ref, value);
  }
  async scroll(): Promise<ActionOutcome> {
    return { ok: true };
  }
  async submit(ref: string): Promise<ActionOutcome> {
    const e = this.el(ref);
    this.submissions.push({ action: e?.formAction ?? this.url, fields: { ...this.fields } });
    return { ok: true };
  }
  async formFields() {
    return Object.entries(this.fields).map(([name, value]) => ({ name, value }));
  }
}

/** Deterministic keyword guard for unit tests (the real model is tested in guard.test.ts). */
export class KeywordGuard implements Guard {
  status() {
    return 'ready' as const;
  }
  statusDetail() {
    return 'keyword test guard';
  }
  async classify(texts: string[]) {
    return texts.map((text) => {
      const flagged = /ignore (all )?previous instructions/i.test(text);
      return { text, score: flagged ? 0.99 : 0.01, flagged };
    });
  }
}
