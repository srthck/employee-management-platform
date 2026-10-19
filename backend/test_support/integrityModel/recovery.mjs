/**
 * Model C — purging a pending snapshot while a run can be retried, with a leased maintenance lock.
 *
 * Entities: one PayrollRun {status, rev}, one PayrollSnapshot {present, ever}, one lock {owner, token, expired}
 * and `workers` purge workers. `ever` is "authoritative finalization evidence exists for this snapshot" (e.g.
 * finalization audit events); the snapshot's own status field is deliberately NOT the evidence, because raw
 * writes can corrupt it.
 *
 * A worker: acquire the lock → read run and snapshot in one transaction snapshot → decide eligibility →
 * commit (an atomic step that aborts when a document in its WRITE SET changed since the read).
 *
 * Switches (all true = the proposed Phase 4 protocol; all false = the design of commit 04c872b):
 *   writeRun        : the purge transaction also writes the run, so a concurrent change to it conflicts
 *   checkEvidence   : eligibility also requires that no finalization evidence exists
 *   fence           : the commit also writes the lock document conditional on the worker's token, so a
 *                     superseded owner conflicts
 * init 'orphan'            : run FAILED, snapshot PENDING, no evidence — a genuine orphan
 * init 'finalized-corrupted': run FAILED, snapshot PENDING, evidence EXISTS — a previously finalized snapshot whose
 *                             status fields were flipped by raw writes
 *
 * Environment: the lease expires (once); the application retries a FAILED run (FAILED → PROCESSING, touches only
 * the run, once).
 */
import { clone } from './explorer.mjs';

export function recoveryModel({ init: initKind, writeRun = false, checkEvidence = false, fence = false, workers = 2 }) {
  const init = {
    run: { status: 'FAILED', rev: 1 },
    snap: { present: 1, ever: initKind === 'finalized-corrupted' ? 1 : 0 },
    lock: { owner: null, token: 0, expired: 1 },
    env: { expiries: 0, retries: 0 },
    w: Array.from({ length: workers }, () => ({ st: 'idle', tok: 0, seen: null })),
    purges: [],
  };

  const actions = (s) => {
    const out = [];
    if (s.lock.owner !== null && !s.lock.expired && s.env.expiries < 1) {
      const n = clone(s); n.lock.expired = 1; n.env.expiries += 1;
      out.push(['environment: the lock lease expires (the holder is not told)', n]);
    }
    if (s.run.status === 'FAILED' && s.env.retries < 1) {
      const n = clone(s); n.run.status = 'PROCESSING'; n.run.rev += 1; n.env.retries += 1;
      out.push(['application: the run is retried, FAILED → PROCESSING (this touches only the run document)', n]);
    }
    s.w.forEach((w, i) => {
      if (w.st === 'idle' && (s.lock.owner === null || s.lock.expired)) {
        const n = clone(s);
        n.lock = { owner: i, token: s.lock.token + 1, expired: 0 };
        n.w[i].st = 'locked'; n.w[i].tok = n.lock.token;
        out.push([`worker ${i}: acquires the lock (token ${n.lock.token})${s.lock.owner !== null ? ` — taking over an expired lease from worker ${s.lock.owner}` : ''}`, n]);
      } else if (w.st === 'locked') {
        const n = clone(s);
        const eligible = s.snap.present && s.run.status === 'FAILED' && (!checkEvidence || !s.snap.ever);
        n.w[i].seen = { runRev: s.run.rev, runStatus: s.run.status, snapPresent: s.snap.present };
        n.w[i].st = eligible ? 'read' : 'skipped';
        out.push([`worker ${i}: reads run (${s.run.status}, rev ${s.run.rev}) and snapshot (${s.snap.present ? 'present' : 'absent'}${s.snap.ever ? ', finalization evidence exists' : ''}) → ${eligible ? 'ELIGIBLE' : 'refuses'}`, n]);
      } else if (w.st === 'read') {
        const n = clone(s);
        const conflict = !n.snap.present
          || (writeRun && n.run.rev !== w.seen.runRev)
          || (fence && n.lock.token !== w.tok);
        if (conflict) {
          n.w[i].st = 'conflict';
          out.push([`worker ${i}: commit conflicts (a document in its write set changed since it read) → aborted, nothing deleted`, n]);
        } else {
          n.snap.present = 0;
          if (writeRun) n.run.rev += 1;
          n.purges.push({ by: i, tok: w.tok, lockTok: n.lock.token, runStatus: n.run.status, ever: n.snap.ever });
          n.w[i].st = 'done';
          out.push([`worker ${i}: commit succeeds → the snapshot is DELETED (run is ${n.run.status} at this moment, lock token is ${n.lock.token}, worker holds ${w.tok})`, n]);
        }
      }
    });
    return out;
  };

  const invariants = [
    { name: 'NoPurgeAfterEligibilityChanges', check: (s) => { const p = s.purges.find((x) => x.runStatus !== 'FAILED'); return p ? `worker ${p.by} deleted the snapshot while the run was ${p.runStatus}, after deciding on a FAILED run` : true; } },
    { name: 'NoPurgeOfEverFinalized', check: (s) => { const p = s.purges.find((x) => x.ever); return p ? `worker ${p.by} deleted a snapshot for which finalization evidence exists` : true; } },
    { name: 'ExpiredOwnerCannotDelete', check: (s) => { const p = s.purges.find((x) => x.tok !== x.lockTok); return p ? `worker ${p.by} deleted with token ${p.tok} after the lock had moved on to token ${p.lockTok}` : true; } },
  ];
  const describe = (s) => `run=${s.run.status}@rev${s.run.rev} snapshot=${s.snap.present ? 'present' : 'deleted'}${s.snap.ever ? '(finalized-before)' : ''} lock=owner:${s.lock.owner === null ? '-' : s.lock.owner} token:${s.lock.token}${s.lock.expired ? '(expired)' : ''} | ${s.w.map((w, i) => `w${i}:${w.st}`).join(' ')}`;
  return { init, actions, invariants, describe };
}
