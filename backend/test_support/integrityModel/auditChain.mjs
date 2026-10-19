/**
 * Model A — appending to the audit chain.
 *
 * design 'current'  : the design of commit 04c872b / ad2aa3f. A writer checks (at most every `indexRecheckMs`,
 *                     modelled as a per-writer cache that is fresh until it nondeterministically expires) that
 *                     the two unique indexes exist, reads the head from committed state, then inserts head+1.
 *                     A duplicate-key refusal makes it retry (bounded) WITHOUT clearing the cache.
 * design 'head-cas' : the proposed Phase 2 design. One head document {seq, hash, ver}. An append is ONE
 *                     transaction: read the head, then conditionally advance it (first committer wins, i.e. a
 *                     version mismatch aborts) and insert the record. The unique indexes stay as defence in depth.
 *
 * Environment actions: each unique index can be dropped (once). A `legacyWriter` appends the old way (reads the
 * tip, inserts tip+1, never touches the head document).
 *
 * Abstractions (see MODEL-RESULTS.md): a transaction commit is one atomic step (first-committer-wins on the
 * head document); time is only "the cache has expired"; hashes are labels; sizes are tiny and bounded.
 */
import { clone } from './explorer.mjs';

const sortRecords = (records) => records.sort((a, b) => a[0] - b[0] || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0));
const tip = (records) => records[records.length - 1];
const hasDuplicate = (records, column) => new Set(records.map((r) => r[column])).size !== records.length;
const INDEX_NAME = { seq: 'sequenceNumber', prev: 'previousHash' };

/** The database's view of an insert: the unique indexes that currently exist refuse a duplicate. */
function tryInsert(state, [seq, prev, hash]) {
  if (state.idx.seq && state.recs.some((r) => r[0] === seq)) return 'refused: duplicate sequenceNumber';
  if (state.idx.prev && state.recs.some((r) => r[1] === prev)) return 'refused: duplicate previousHash';
  state.recs.push([seq, prev, hash]);
  sortRecords(state.recs);
  return 'ok';
}

export function auditChainModel({ design, writers = 2, drops = ['seq', 'prev'], legacyWriter = false, maxTries = 2, blindHead = false }) {
  const cas = design === 'head-cas';
  const init = {
    recs: [[1, 'G', '1S']],
    idx: { seq: 1, prev: 1 },
    dropped: { seq: 0, prev: 0 },
    head: cas ? { seq: 1, hash: '1S', ver: 1 } : null,
    w: Array.from({ length: writers }, () => ({ st: 'idle', cache: 'fresh', snap: null, tries: 0, res: null })),
    legacy: legacyWriter ? { st: 'idle' } : null,
  };

  const with_ = (state, fn) => { const next = clone(state); fn(next); return next; };

  const actions = (s) => {
    const out = [];
    for (const key of drops) {
      if (s.idx[key] && !s.dropped[key]) {
        out.push([`environment: the unique index on ${INDEX_NAME[key]} is dropped`, with_(s, (n) => { n.idx[key] = 0; n.dropped[key] = 1; })]);
      }
    }
    if (s.legacy && s.legacy.st === 'idle') {
      const last = tip(s.recs);
      const next = clone(s);
      const seq = last[0] + 1;
      const result = tryInsert(next, [seq, last[2], `${seq}L`]);
      next.legacy.st = 'done';
      out.push([`legacy writer: reads the tip (seq ${last[0]}) and inserts seq ${seq} without touching the head document: ${result}`, next]);
    }

    s.w.forEach((w, i) => {
      if (w.st === 'done' || w.st === 'failed') return;

      if (!cas) {
        if (w.st === 'idle' && w.cache === 'fresh') {
          out.push([`w${i}: begins an append; its guard cache says the indexes are healthy, so it checks nothing`, with_(s, (n) => { n.w[i].st = 'checked'; })]);
          out.push([`environment: w${i}'s guard cache expires`, with_(s, (n) => { n.w[i].cache = 'stale'; })]);
        } else if (w.st === 'idle') {
          const next = clone(s);
          const x = next.w[i];
          const missing = ['seq', 'prev'].filter((k) => !next.idx[k]);
          const blocked = missing.filter((k) => hasDuplicate(next.recs, k === 'seq' ? 0 : 1));
          if (blocked.length > 0) {
            x.st = 'failed';
            x.res = 'refused (503 AUDIT_CHAIN_INDEX_UNAVAILABLE), nothing written';
            out.push([`w${i}: guard check finds the ${missing.map((k) => INDEX_NAME[k]).join(' and ')} index missing, cannot rebuild it (data already violates it), refuses to append`, next]);
          } else {
            for (const k of missing) next.idx[k] = 1;
            x.cache = 'fresh';
            x.st = 'checked';
            out.push([`w${i}: guard check ${missing.length ? `rebuilds the missing ${missing.map((k) => INDEX_NAME[k]).join(' and ')} index` : 'finds both indexes present'}`, next]);
          }
        } else if (w.st === 'checked') {
          const head = tip(s.recs);
          out.push([`w${i}: reads the head (seq ${head[0]}) from committed state`, with_(s, (n) => { n.w[i].snap = { seq: head[0], hash: head[2] }; n.w[i].st = 'read'; })]);
        } else if (w.st === 'read') {
          const next = clone(s);
          const x = next.w[i];
          const seq = x.snap.seq + 1;
          const hash = `${seq}w${i}`;
          const result = tryInsert(next, [seq, x.snap.hash, hash]);
          if (result === 'ok') {
            x.st = 'done';
            x.res = { seq, prev: x.snap.hash, hash };
            out.push([`w${i}: inserts seq ${seq} after ${x.snap.hash}: accepted, the caller is told success`, next]);
          } else {
            x.tries += 1;
            x.st = x.tries >= maxTries ? 'failed' : 'idle';
            x.res = x.tries >= maxTries ? '503 AUDIT_CHAIN_CONTENTION, nothing written' : null;
            out.push([`w${i}: inserts seq ${seq} after ${x.snap.hash}: the database ${result}${x.tries >= maxTries ? '; retries exhausted' : '; it retries (the guard cache is NOT cleared)'}`, next]);
          }
        }
        return;
      }

      // head-cas
      if (w.st === 'idle') {
        out.push([`w${i}: begins a transaction and reads the head document (seq ${s.head.seq}, version ${s.head.ver})`, with_(s, (n) => { n.w[i].snap = { seq: s.head.seq, hash: s.head.hash, ver: s.head.ver }; n.w[i].st = 'read'; })]);
      } else if (w.st === 'read') {
        const next = clone(s);
        const x = next.w[i];
        const retry = (why) => { x.tries += 1; x.st = x.tries >= maxTries ? 'failed' : 'idle'; x.res = x.tries >= maxTries ? '503 AUDIT_CHAIN_CONTENTION, nothing written' : null; return `w${i}: commit ${why}; the whole transaction aborts${x.tries >= maxTries ? ', retries exhausted' : ' and is retried from a fresh head read'}`; };
        if (!blindHead && next.head.ver !== x.snap.ver) {
          out.push([retry(`conflicts: the head document is now version ${next.head.ver}, it read ${x.snap.ver}`), next]);
          return;
        }
        const seq = x.snap.seq + 1;
        const hash = `${seq}w${i}`;
        const result = tryInsert(next, [seq, x.snap.hash, hash]);
        if (result !== 'ok') {
          out.push([retry(`fails: the insert is ${result}`), next]);
          return;
        }
        next.head = { seq, hash, ver: next.head.ver + 1 };
        x.st = 'done';
        x.res = { seq, prev: x.snap.hash, hash };
        out.push([`w${i}: commits ${blindHead ? '(head update NOT conditional on the version)' : '(head version unchanged)'}: advances the head to seq ${seq} and inserts the record; the caller is told success`, next]);
      }
    });
    return out;
  };

  const group = (records, column) => {
    const seen = new Map();
    for (const r of records) seen.set(r[column], [...(seen.get(r[column]) || []), r]);
    return [...seen.entries()].find(([, list]) => list.length > 1);
  };
  const fmt = (r) => `(${r[0]}, prev=${r[1]}, ${r[2]})`;

  const invariants = [
    {
      name: 'OneSuccessorPerPredecessor',
      check: (s) => { const dup = group(s.recs, 1); return dup ? `predecessor ${dup[0]} has ${dup[1].length} successors: ${dup[1].map(fmt).join(', ')}` : true; },
    },
    {
      name: 'UniqueSequence',
      check: (s) => { const dup = group(s.recs, 0); return dup ? `sequence ${dup[0]} is held by ${dup[1].length} records: ${dup[1].map(fmt).join(', ')}` : true; },
    },
    {
      name: 'SuccessNeverReportedForForkedPosition',
      check: (s) => {
        for (const [i, w] of s.w.entries()) {
          if (w.st !== 'done') continue;
          const rivals = s.recs.filter((r) => (r[0] === w.res.seq || r[1] === w.res.prev) && r[2] !== w.res.hash);
          if (rivals.length > 0) return `w${i} was told success for (${w.res.seq}, prev=${w.res.prev}) but ${rivals.map(fmt).join(', ')} also claims that position`;
        }
        return true;
      },
    },
  ];
  if (cas) {
    invariants.push({
      name: 'HeadMatchesLastCommittedEntry',
      check: (s) => { const last = tip(s.recs); return s.head.seq === last[0] && s.head.hash === last[2] ? true : `head document says seq ${s.head.seq}/${s.head.hash} but the last committed record is ${fmt(last)}`; },
    });
  }

  const describe = (s) => `records=${s.recs.map(fmt).join(' ')} | indexes seq:${s.idx.seq ? 'yes' : 'DROPPED'} prev:${s.idx.prev ? 'yes' : 'DROPPED'}${s.head ? ` | head=${s.head.seq}@v${s.head.ver}` : ''} | writers=${s.w.map((w, i) => `w${i}:${w.st}${w.cache === 'stale' ? '(stale)' : ''}`).join(' ')}`;
  return { init, actions, invariants, describe };
}
