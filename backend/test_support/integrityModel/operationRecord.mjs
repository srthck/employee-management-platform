/**
 * Model F — the operation-record protocol as IMPLEMENTED in Phase 3 (middleware/idempotency.js, idempotencyService.js,
 * utils/transaction.js), for one logical operation (one Idempotency-Key) and a client that retries with the same key.
 *
 * The record: absent, or { status: IN_PROGRESS | COMPLETED | UNKNOWN, token, committed, expired }.
 * An attempt: started → claimed (holds a token) → its business transaction commits (the record update inside it is
 * conditional on the token and on IN_PROGRESS) → it responds. Nondeterminism: the commit can abort; it can be applied
 * with the acknowledgement lost; the evidence read after a lost acknowledgement can see the marker or miss it (a majority
 * read running ahead of the commit point); the process can crash at any phase; the lock can expire at any moment; the
 * record's TTL can fire at any moment it is eligible. Optionally the handler runs a NESTED transaction that commits on its
 * own before the outer one.
 *
 * Options (each `false` removes one protection, for the sensitivity scenarios):
 *   fence          the in-transaction update requires the attempt's own token (else only IN_PROGRESS)
 *   takeoverCheck  a takeover of an expired lock requires committed = 0
 *   ttlSettledOnly only COMPLETED records can expire (else every record: the index before 2026-11-09)
 *   unknownKept    an unconfirmed commit leaves UNKNOWN (else the key is released as if nothing happened)
 *   nestedRefused  a nested transaction inside a keyed request is refused (else it may commit, unrecorded)
 *   ttlWhileInFlight (boundary) the TTL may fire while an attempt is still in flight, i.e. a request outlives the TTL
 *   trustUnconfirmed (sensitivity) an unconfirmed commit is reported as a success without evidence
 */
import { clone } from './explorer.mjs';

export function operationRecordModel({
  fence = true, takeoverCheck = true, ttlSettledOnly = true, unknownKept = true, nestedRefused = true, ttlWhileInFlight = false, trustUnconfirmed = false, attempts = 2,
} = {}) {
  const init = { biz: 0, sent: 0, rec: null, tokens: 0, ttlFired: 0, slots: [] };

  const actions = (s) => {
    const out = [];
    const push = (label, n) => out.push([label, n]);

    if (s.sent < attempts && !s.slots.some((x) => x.out === 'success')) {
      const n = clone(s);
      n.sent += 1;
      n.slots.push({ ph: 'started', token: null, out: null, nested: false });
      push(`client: sends attempt ${n.sent} with the same key`, n);
    }

    if (s.rec && s.rec.status === 'IN_PROGRESS' && !s.rec.expired) {
      const n = clone(s);
      n.rec.expired = true;
      push('the lock expires', n);
    }

    // Assumption: the TTL (24 h) is longer than any request stays in flight, so it fires only when no attempt is running.
    // A client that never saw a success may still come back afterwards with the same key: that is the case it guards.
    if (s.rec && !s.ttlFired && (ttlWhileInFlight || s.slots.every((x) => x.ph === 'ended')) && (!ttlSettledOnly || s.rec.status === 'COMPLETED')) {
      const n = clone(s);
      n.rec = null;
      n.ttlFired = 1;
      push(`the TTL monitor deletes the ${s.rec.status} record`, n);
    }

    s.slots.forEach((slot, i) => {
      const a = `attempt ${i + 1}`;
      if (slot.ph === 'ended') return;

      if (slot.ph !== 'started') {
        const n = clone(s);
        n.slots[i] = { ...slot, ph: 'ended', out: 'crash' };
        push(`${a}: the process crashes (no response)`, n);
      }

      if (slot.ph === 'started') {
        const n = clone(s);
        if (!s.rec) {
          n.tokens += 1;
          n.rec = { status: 'IN_PROGRESS', token: n.tokens, committed: 0, expired: false };
          n.slots[i] = { ...slot, ph: 'claimed', token: n.tokens };
          push(`${a}: claims the key (new record, token ${n.tokens})`, n);
        } else if (s.rec.status === 'IN_PROGRESS' && s.rec.expired && (!takeoverCheck || s.rec.committed === 0)) {
          n.tokens += 1;
          n.rec = { ...s.rec, token: n.tokens, expired: false };
          n.slots[i] = { ...slot, ph: 'claimed', token: n.tokens };
          push(`${a}: takes over the expired lock (token ${n.tokens})`, n);
        } else {
          n.slots[i] = { ...slot, ph: 'ended', out: `refused-or-replayed(${s.rec.status})` };
          push(`${a}: is answered from the existing ${s.rec.status} record without running`, n);
        }
        return;
      }

      const owns = (st) => st.rec && st.rec.status === 'IN_PROGRESS' && (!fence || st.rec.token === slot.token);

      if (slot.ph === 'claimed') {
        if (!nestedRefused && !slot.nested) {
          const n = clone(s);
          n.biz += 1; // the nested transaction commits on its own; the operation record knows nothing of it
          n.slots[i] = { ...slot, nested: true };
          push(`${a}: a NESTED transaction commits the work on its own (unrecorded)`, n);
        }
        const commitOutcomes = [['acknowledged', 'committed'], ['lost', 'unconfirmed']];
        for (const [ack, ph] of commitOutcomes) {
          const n = clone(s);
          if (owns(s)) {
            n.biz += 1;
            n.rec.committed += 1;
            n.slots[i] = { ...slot, ph, applied: true };
            push(`${a}: its transaction commits (acknowledgement ${ack})`, n);
          } else {
            n.slots[i] = { ...slot, ph: 'aborted' };
            push(`${a}: its transaction aborts: the record no longer matches its token (fenced)`, n);
            break;
          }
        }
        if (owns(s)) {
          const n = clone(s);
          n.slots[i] = { ...slot, ph: 'unconfirmed', applied: false };
          push(`${a}: the connection drops: the commit is never applied and no reply arrives`, n);
        }
        {
          const n = clone(s);
          n.slots[i] = { ...slot, ph: 'aborted' };
          push(`${a}: its transaction aborts (conflict or failure)`, n);
        }
        return;
      }

      const finish = (n, out) => { n.slots[i] = { ...slot, ph: 'ended', out }; };

      if (slot.ph === 'committed') {
        const n = clone(s);
        if (owns(s)) n.rec.status = 'COMPLETED';
        finish(n, 'success');
        push(`${a}: responds 2xx; the record becomes COMPLETED`, n);
        const m = clone(s);
        if (m.rec && m.rec.token === slot.token) m.rec.expired = true; // 5xx after a commit: keep the key, expire the lock
        finish(m, 'error-after-commit');
        push(`${a}: fails after its commit (5xx); the key is kept`, m);
        return;
      }

      if (slot.ph === 'unconfirmed') {
        // The evidence read: the marker is visible (only if the commit was applied), or the read misses it.
        if (slot.applied || trustUnconfirmed) {
          const n = clone(s);
          if (owns(s)) n.rec.status = 'COMPLETED';
          finish(n, 'success');
          push(slot.applied ? `${a}: the evidence read finds the marker: success` : `${a}: success is reported WITHOUT evidence`, n);
        }
        {
          const n = clone(s);
          if (unknownKept) {
            if (n.rec && n.rec.token === slot.token) n.rec.status = 'UNKNOWN';
            push(`${a}: the evidence read misses the marker: 503 COMMIT_OUTCOME_UNKNOWN, record UNKNOWN`, (finish(n, 'unknown'), n));
          } else {
            if (n.rec && n.rec.token === slot.token) n.rec = null;
            push(`${a}: the evidence read misses the marker and the key is RELEASED as if nothing happened`, (finish(n, 'error'), n));
          }
        }
        return;
      }

      if (slot.ph === 'aborted') {
        const n = clone(s);
        // Release only when the durable record says nothing committed under this token.
        if (n.rec && n.rec.token === slot.token && n.rec.status === 'IN_PROGRESS' && n.rec.committed === 0) n.rec = null;
        finish(n, 'error');
        push(`${a}: responds 5xx; the key is released if the record shows nothing committed`, n);
      }
    });
    return out;
  };

  const invariants = [
    { name: 'NoDuplicateLogicalOperation', check: (s) => (s.biz <= 1 ? true : `the one logical operation was applied ${s.biz} times`) },
    {
      name: 'SuccessOnlyIfApplied',
      check: (s) => (s.slots.some((x) => x.out === 'success') && s.biz === 0 ? 'a client was told it succeeded but nothing was applied' : true),
    },
  ];
  const describe = (s) => `applied=${s.biz} record=${s.rec ? `${s.rec.status}/t${s.rec.token}/c${s.rec.committed}${s.rec.expired ? '/expired' : ''}` : 'none'} | ${s.slots.map((x, i) => `a${i + 1}:${x.ph}${x.token ? `(t${x.token})` : ''}${x.out ? `→${x.out}` : ''}`).join(' ') || 'no attempt yet'}`;
  return { init, actions, invariants, describe };
}
