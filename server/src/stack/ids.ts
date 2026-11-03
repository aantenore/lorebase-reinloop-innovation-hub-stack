// Run and session ids reach reinloop, which accepts only 1-128 characters of [A-Za-z0-9_.-] (not starting with a dot).
import { createHash } from 'node:crypto';

export const MAX_RUN_ID = 128;
const SAFE_RUN_ID = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/;
const HEAD_KEPT = 48;

export const isSafeRunId = (id: unknown): id is string => typeof id === 'string' && SAFE_RUN_ID.test(id);

const digest = (s: string, n: number): string => createHash('sha256').update(s).digest('hex').slice(0, n);

/** One id component made safe: other characters become '-'; a changed component gets a short digest so two names never merge. */
export function safePart(part: string | number): string {
  const s = String(part);
  const safe = s.replace(/[^A-Za-z0-9_.-]/g, '-').replace(/^\.+/, (m) => '-'.repeat(m.length)) || '-';
  return safe === s ? safe : `${safe}-${digest(s, 6)}`;
}

/**
 * A run id from its components, joined with '.'. The leading components (`head`) are made safe and, when the whole
 * would pass the limit, shortened to a prefix plus a digest of the full head; the unique `tail` is always kept whole.
 */
export function runIdFrom(head: ReadonlyArray<string | number>, tail: string): string {
  const t = safePart(tail);
  let h = head.map(safePart).join('.');
  if (h.length + 1 + t.length > MAX_RUN_ID) {
    const room = Math.max(0, Math.min(HEAD_KEPT, MAX_RUN_ID - t.length - 1 - 13));
    h = `${h.slice(0, room)}-${digest(h, 12)}`;
  }
  return `${h}.${t}`;
}
