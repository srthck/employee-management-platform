/**
 * Model B — a business mutation, its required audit event, and a client that retries.
 *
 * path 'plain'         : the business write commits, THEN the audit event is appended separately (the payroll
 *                        run-lifecycle and several auth call sites of commit 04c872b). The append may fail or the
 *                        process may crash in between.
 * path 'transactional' : business write + audit event commit in one transaction. A commit may be applied but its
 *                        acknowledgement lost (unknown outcome), in which case the client sees a failure.
 * outbox               : (plain path) the business transaction also writes a durable obligation to append the
 *                        event, so a failed append does not lose it and is not reported as an error.
 * idempotent           : the transaction also reads/writes an operation record keyed by the client's operation id,
 *                        so a retry of the same operation returns the stored result instead of re-executing.
 * idemLookup=false     : (mutation) the record is written but never consulted.
 *
 * One logical operation; the client may send up to `attempts` requests, and a new attempt may start while an
 * earlier one is still running (a timeout). Attempts run concurrently with each other.
 */
import { clone } from './explorer.mjs';

export function businessAuditModel({ path, outbox = false, idempotent = false, idemLookup = true, attempts = 2 }) {
  const init = { biz: 0, evt: 0, obl: 0, idem: 0, sent: 0, success: 0, falseNothingWritten: 0, slots: [] };

  const respond = (n, i, out, falseClaim = false) => {
    n.slots[i] = { ph: 'ended', out };
    if (out === 'success') n.success = 1;
    if (falseClaim && n.biz > 0) n.falseNothingWritten = 1;
  };

  const actions = (s) => {
    const out = [];
    if (s.sent < attempts && !s.success) {
      const n = clone(s);
      n.sent += 1;
      n.slots.push({ ph: 'started', out: null });
      out.push([`client: sends attempt ${n.sent} of the same logical operation${s.slots.some((x) => x.ph !== 'ended') ? ' (an earlier attempt is still running: a timeout)' : ''}`, n]);
    }
    s.slots.forEach((slot, i) => {
      if (slot.ph === 'ended') return;
      const label = `attempt ${i + 1}`;
      if (path === 'transactional') {
        if (slot.ph !== 'started') return;
        const apply = (n) => {
          if (idempotent && idemLookup && n.idem) return false; // stored result returned, nothing re-executed
          n.biz += 1; n.evt += 1;
          if (idempotent) n.idem = 1;
          return true;
        };
        {
          const n = clone(s);
          const executed = apply(n);
          respond(n, i, 'success');
          out.push([`${label}: transaction commits, acknowledgement received${executed ? '' : ' (the operation record already existed: the stored result is returned, nothing re-executed)'}`, n]);
        }
        {
          const n = clone(s);
          const executed = apply(n);
          respond(n, i, 'unknown');
          out.push([`${label}: transaction commits but the acknowledgement is lost (outcome unknown to the client)${executed ? '' : ' [operation record already existed: nothing re-executed]'}`, n]);
        }
        {
          const n = clone(s);
          respond(n, i, 'error-aborted');
          out.push([`${label}: transaction aborts (known, nothing written)`, n]);
        }
        return;
      }
      // plain path
      if (slot.ph === 'started') {
        const n = clone(s);
        n.biz += 1;
        if (outbox) n.obl += 1;
        n.slots[i] = { ph: 'bizDone', out: null };
        out.push([`${label}: business write commits${outbox ? ' together with a durable audit obligation' : ''}`, n]);
      } else if (slot.ph === 'bizDone') {
        {
          const n = clone(s);
          n.evt += 1;
          if (outbox) n.obl -= 1;
          respond(n, i, 'success');
          out.push([`${label}: audit event appended, success returned`, n]);
        }
        {
          const n = clone(s);
          if (outbox) respond(n, i, 'success');
          else respond(n, i, 'error-503-nothing-written', true);
          out.push([outbox
            ? `${label}: audit append fails; the obligation is durable, success is returned and the event will be appended later`
            : `${label}: audit append fails (contention or index refusal): the client is told 503 "Nothing was written; retry"`, n]);
        }
        {
          const n = clone(s);
          respond(n, i, 'unknown');
          out.push([`${label}: the process crashes after the business commit, before the audit append (no response)`, n]);
        }
      }
    });
    return out;
  };

  const invariants = [
    { name: 'NoCommittedCriticalMutationWithoutRequiredAudit', check: (s) => (s.biz <= s.evt + s.obl ? true : `${s.biz} business effect(s) committed but only ${s.evt} audit event(s) and ${s.obl} durable obligation(s)`) },
    { name: 'NoDuplicateLogicalOperation', check: (s) => (s.biz <= 1 ? true : `the one logical operation was applied ${s.biz} times`) },
    { name: 'ErrorsAreTruthful', check: (s) => (s.falseNothingWritten ? 'a client was told "nothing was written" although the business change had committed' : true) },
  ];
  const describe = (s) => `business effects=${s.biz} audit events=${s.evt} obligations=${s.obl} opRecord=${s.idem} | ${s.slots.map((x, i) => `a${i + 1}:${x.ph}${x.out ? `→${x.out}` : ''}`).join(' ') || 'no attempt yet'}`;
  return { init, actions, invariants, describe };
}
