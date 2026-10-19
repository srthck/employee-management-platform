/**
 * Model D — historical hashes versus a legacy backfill.
 * Model E — the database/filesystem boundary of a destructive recovery step.
 */
import { clone } from './explorer.mjs';

// ──────────────────────────────── Model D ────────────────────────────────

const H = (prev, id, seq) => `H(${prev},${id},${seq})`;

/**
 * Two records are already chained (A, B). One record L predates the chain. `legacyIsOlder` says whether L is older
 * than the chain tail (it sorts before A) or newer.
 *  design 'old' : the startup backfill of commit 04c872b — re-sequences and re-hashes EVERY record in createdAt order.
 *  design 'new' : the Phase 0 explicit migration — fills only unchained records, and REFUSES when one sorts at or
 *                 before the chain tail.
 */
export function legacyBackfillModel({ design, legacyIsOlder }) {
  const a = { id: 'A', t: 2, seq: 1, hash: H('G', 'A', 1) };
  const b = { id: 'B', t: 3, seq: 2, hash: H(a.hash, 'B', 2) };
  const l = { id: 'L', t: legacyIsOlder ? 1 : 4, seq: null, hash: null };
  const init = { recs: [a, b, l], original: { A: a.hash, B: b.hash }, ran: 0, outcome: null };

  const actions = (s) => {
    if (s.ran) return [];
    const n = clone(s);
    n.ran = 1;
    const tailT = Math.max(...n.recs.filter((r) => r.seq !== null).map((r) => r.t));
    if (design === 'old') {
      n.recs.sort((x, y) => x.t - y.t);
      let prev = 'G';
      n.recs.forEach((r, i) => { r.seq = i + 1; r.hash = H(prev, r.id, r.seq); prev = r.hash; });
      n.outcome = 'filled';
      return [['startup: backfillLegacyChain re-sequences and re-hashes every record in createdAt order', n]];
    }
    if (n.recs.some((r) => r.seq === null && r.t <= tailT)) {
      n.outcome = 'refused';
      return [['operator: the explicit migration refuses (an unchained record sorts before the chain tail); nothing is written', n]];
    }
    let prev = n.recs.filter((r) => r.seq !== null).sort((x, y) => y.seq - x.seq)[0].hash;
    let seq = Math.max(...n.recs.map((r) => r.seq ?? 0));
    for (const r of n.recs.filter((x) => x.seq === null).sort((x, y) => x.t - y.t)) { seq += 1; r.seq = seq; r.hash = H(prev, r.id, seq); prev = r.hash; }
    n.outcome = 'filled';
    return [['operator: the explicit migration fills only the unchained record, after the tail', n]];
  };
  const invariants = [
    { name: 'HistoricalHashesRemainStable', check: (s) => { const moved = s.recs.find((r) => s.original[r.id] && r.hash !== s.original[r.id]); return moved ? `stored hash of already-chained record ${moved.id} changed from ${s.original[moved.id]} to ${moved.hash}` : true; } },
  ];
  const describe = (s) => `${s.recs.map((r) => `${r.id}(t${r.t},${r.seq === null ? 'unchained' : `seq${r.seq}`})`).join(' ')} outcome=${s.outcome ?? 'not run'}`;
  return { init, actions, invariants, describe };
}

// ──────────────────────────────── Model E ────────────────────────────────

/**
 * Purge with a before-image file. The file's data is durable only after fsync(file); its NAME (the directory
 * entry) is durable only after fsync(directory) — the conservative POSIX reading of fsync(2), which says fsync of a
 * file does not necessarily persist its directory entry. The operating system may also flush the directory on its
 * own at any time (nondeterministic), which is why a missing directory fsync yields an intermittent loss, not a
 * deterministic one. Power loss happens at most once, at any time, and discards everything not durable.
 *  dirFsync=false : the design of commit 04c872b (file fsync only)
 *  dirFsync=true  : the proposed protocol (directory fsync before the database transaction)
 *  atomicCommit=false : the non-transactional fallback (REQUIRE_TRANSACTIONS=false on a standalone server): the delete and
 *                   its audit event are two separate writes, so power loss can fall between them
 */
export function evidenceBoundaryModel({ dirFsync, atomicCommit = true }) {
  const init = { ph: 'start', file: { created: 0, written: 0, fsynced: 0, dirDurable: 0 }, db: { deleted: 0, audit: 0 }, crashed: 0 };
  const actions = (s) => {
    const out = [];
    const step = (label, fn) => { const n = clone(s); fn(n); out.push([label, n]); };
    if (!s.crashed) {
      step('environment: power loss — everything not durable is discarded', (n) => { n.crashed = 1; });
      if (s.file.created && !s.file.dirDurable) step('environment: the operating system happens to flush the directory entry', (n) => { n.file.dirDurable = 1; });
      if (s.ph === 'start') step('tool: creates the before-image file', (n) => { n.file.created = 1; n.ph = 'created'; });
      else if (s.ph === 'created') step('tool: writes the before-image', (n) => { n.file.written = 1; n.ph = 'written'; });
      else if (s.ph === 'written') step('tool: fsync(file)', (n) => { n.file.fsynced = 1; n.ph = dirFsync ? 'fileSynced' : 'ready'; });
      else if (s.ph === 'fileSynced') step('tool: fsync(directory)', (n) => { n.file.dirDurable = 1; n.ph = 'ready'; });
      else if (s.ph === 'ready' && atomicCommit) step('tool: the database transaction commits — the snapshot is deleted and the audit event written together', (n) => { n.db.deleted = 1; n.db.audit = 1; n.ph = 'done'; });
      else if (s.ph === 'ready') step('tool: deletes the snapshot (its own write; no transaction)', (n) => { n.db.deleted = 1; n.ph = 'deleted'; });
      else if (s.ph === 'deleted') step('tool: appends the audit event (a separate write)', (n) => { n.db.audit = 1; n.ph = 'done'; });
    }
    return out;
  };
  const durable = (f) => f.created && f.written && f.fsynced && f.dirDurable;
  const invariants = [
    { name: 'EvidenceDurableBeforeDelete', check: (s) => (s.crashed && s.db.deleted && !durable(s.file) ? 'after power loss the snapshot is deleted and audited but the before-image is not durable (the file contents may be, its directory entry is not)' : true) },
    { name: 'NoDeleteWithoutAudit', check: (s) => (s.crashed && s.db.deleted && !s.db.audit ? 'after power loss the snapshot is deleted but its audit event was never written' : true) },
  ];
  const describe = (s) => `phase=${s.ph} file[created:${s.file.created} written:${s.file.written} fsynced:${s.file.fsynced} dirDurable:${s.file.dirDurable}] db[deleted:${s.db.deleted} audit:${s.db.audit}]${s.crashed ? ' POWER-LOSS' : ''}`;
  return { init, actions, invariants, describe };
}
