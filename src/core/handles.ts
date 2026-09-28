// Symbolic handles for reader output (CaMeL-style, v1).
//
// The planner never sees reader STRINGS or ARRAYS. It sees scalar numbers, booleans and null, and
// for every string or array a handle like {{$r1.name}} plus its type and length. A scalar number
// is not free of attacker influence: it can carry ~15 significant digits (a few encoded characters),
// which is far less than a text instruction but not nothing.
// Actions may reference handles in navigate.url / type.text / select.value / finish.answer; code
// substitutes the real values after the planner has decided, and the policy engine sees (and the
// user confirms) the substituted, still-untrusted values.

export const HANDLE_RE = /\{\{\s*\$(r\d+)\.([A-Za-z_][A-Za-z0-9_]{0,40})(?:\[(\d{1,2})\])?\s*\}\}/g;

export interface HandleView {
  handle: string;
  type: 'string' | 'string[]' | 'number[]';
  length: number;
}

export class HandleStore {
  private records = new Map<string, Record<string, unknown>>();
  private n = 0;

  /** Store reader output; return what the planner may see. */
  add(data: Record<string, unknown>): { id: string; view: Record<string, unknown> } {
    const id = `r${++this.n}`;
    this.records.set(id, data);
    const view: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === 'string') view[k] = { handle: `{{$${id}.${k}}}`, type: 'string', length: v.length } satisfies HandleView;
      else if (Array.isArray(v)) {
        view[k] = { handle: `{{$${id}.${k}[i]}}`, type: v.some((x) => typeof x === 'string') ? 'string[]' : 'number[]', length: v.length } satisfies HandleView;
      } else view[k] = v; // scalar number, boolean, null
    }
    return { id, view };
  }

  /** Replace handle references with their values. Unknown handles are left as they are. */
  resolve(text: string): { text: string; used: string[] } {
    const used: string[] = [];
    const out = text.replace(HANDLE_RE, (m, id: string, field: string, idx?: string) => {
      const rec = this.records.get(id);
      if (!rec || !(field in rec)) return m;
      let v = rec[field];
      if (Array.isArray(v)) {
        if (idx === undefined) v = v.join(', ');
        else v = v[Number(idx)];
      }
      if (v === undefined || v === null) return m;
      used.push(`$${id}.${field}${idx !== undefined ? `[${idx}]` : ''}`);
      return String(v);
    });
    return { text: out, used };
  }
}
