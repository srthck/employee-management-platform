# Integrity claims ledger

Purpose: one place that says, for each integrity claim about the audit chain, payroll transactions and snapshot recovery, **what establishes it** and **what does not**. A claim is never upgraded without new evidence. Where another document disagrees with this ledger, this ledger wins.

Boundaries that apply to everything here: production statutory wage calculation, legal mappings and activation remain **NO-GO**; the Phase 1D scaffold is untouched and not connected; no stored audit hash or finalized snapshot is rewritten; the audit chain is **tamper-evident, not tamper-proof**.

## Evidence classes

| Class | Meaning |
|---|---|
| `DB_ENFORCED` | The database refuses the violating write (unique index, document write conflict, transaction), independent of application code |
| `SOURCE_ENFORCED` | Application code prevents it; a different caller or a direct database client could bypass it |
| `DIRECTLY_TESTED` | A test in this repository executes the scenario against a real MongoDB replica set and asserts persisted state |
| `SIMULATED` | Tested with an in-process stand-in for a fault (named in the test title); not a real server fault |
| `REPORT_ONLY` | Stated by a report or log; not re-executed against the exact source |
| `CONFIG_DEPENDENT` | Holds only under a stated runtime configuration |
| `ASSUMPTION` | Believed, not established |
| `UNVERIFIED` | Not tested, not established |

## Immutable evidence (do not edit)

The independent adversarial review of commit `04c872b878055974a128a99e914d867e7a1830e1` (parent `2dfddaf8fc77f303af831fdbcbd8db8d485b7fde`), 2026-10-18/19, kept outside the repository at `payguard-evidence/independent-audit-2026-10-18/`:

| File | sha256 |
|---|---|
| `FINAL_REPORT.md` | `5f2cfa0993e9b68880549796e7764fd7af414fbd65436e2b2fa05e2273d0daad` |
| `baseline_repo_state.txt` | `dd7e843a234715b71bc9f6beba4ceae4af773be476e7fe8b83753b97b70e600e` |
| `L6A_structured_and_skeptics.json` | `ad5209907cbc77ffc1101b6019a39019d55d3303fb1924757ecff47d328e1356` |
| `reports/L0` … `L9` (lane write-ups) | per-file hashes recorded in the program evidence directory |

Its verdict was **CONDITIONAL PASS**. Independence limit: the code under review was written in the same Claude session; the review used ten fresh-context lane agents, and its per-finding skeptic stage ran only for lane L6A.

Program evidence for the remediation phases lives outside the repository at `payguard-evidence/integrity-program-2026-10-19/` (preflight baseline, pre-fix reproductions under `probes/phase0/`, test and mutation logs, the mutation script and its result). It contains no secrets and is never committed.

## Findings and their status

| ID | Finding (audit severity) | Status after Phase 0 | Closing phase |
|---|---|---|---|
| F-01 | Guard compares key+unique only; 10 s blind cache; fork committed and success reported when both guards absent/ineffective (MEDIUM, HIGH under C1) | **OPEN** | 2 |
| F-02 | Purge transaction reads the run but never writes it: `FAILED→PROCESSING` retry slips through (MEDIUM) | **CONTAINED** (the purge no longer exists) — not fixed | 4 |
| F-03 | `ORPHAN_PENDING` ignores finalization history; a flipped, previously finalized snapshot is purgeable (MEDIUM) | **CONTAINED** (no apply) — classification still informational only | 4 |
| F-04 | Ambiguous commit surfaces as raw HTTP 500, no "outcome unknown" marker (MEDIUM) | **OPEN** | 3 |
| F-05 | "Nothing was written; retry" wording wrong for post-commit plain audit callers; business state can commit without its event at 4 payroll + 3 auth sites (MEDIUM) | **OPEN** | 3 |
| F-06 | Guard invisible to readiness; failed build uncached and run in requests (MEDIUM) | **PARTLY**: readiness now reports the transaction policy; guard visibility/caching **OPEN** | 2, 7 |
| F-07 | `backfillLegacyChain` ran at every startup, re-sealed chained history, not crash-safe (MEDIUM) | **RESOLVED** (Phase 0) — startup never writes; explicit, preflighted, digest-bound command | 0 |
| F-08 | Transaction opt-out honoured for any `NODE_ENV` ≠ `production`; destructive tool inherited the fallback (MEDIUM) | **RESOLVED** (Phase 0) — two-boundary policy; destructive tools need real transactions | 0 |
| F-09 | Tail truncation undetectable; doc claimed deletions detected (MEDIUM) | **OPEN** (doc corrected) | 5 |
| F-10 | Test evidence overstated (33/33 mutants not shown for the committed test file; 100-way test serialized; no absent-guard concurrency test; no commit-ambiguity test) (MEDIUM) | **OPEN** (new Phase 0 mutation result below is exact for Phase 0 only) | 6 |

Lower-severity audit findings (dry run created collections; post-commit failure reported as failure; no directory fsync; lease not fenced; collision classifier matches message text; empty `--company ""` widened scope; etc.) are tracked in the lane reports. Of these, **dry-run collection creation** and **scope widening / argument parsing** are resolved in Phase 0; the purge-specific ones (reporting, fsync, lease, evidence) are moot while apply does not exist and return as requirements of Phase 4.

## Phase 0 claims

Commit: see Git history (`Contain unsafe audit recovery and startup migration paths`). Test file `backend/test_integrity_phase0.js` (26 tests) and updated group C of `backend/test_audit_hardening.js` (36 tests in the file).

| # | Claim | Class | Mechanism | Evidence |
|---|---|---|---|---|
| P0-1 | Destructive snapshot recovery cannot be run: `--apply` exits 1 before any database access, whatever else is passed | `SOURCE_ENFORCED`, `DIRECTLY_TESTED` | `reconcile-payroll-snapshots.mjs` refuses `--apply` before `mongoose.connect`; `purgeOrphans()` throws unconditionally | hardening group C: CLI against an unreachable database is refused in < 5 s without a connection error; exported function refuses a perfect request and perfect scan; mutants R01–R03, R07–R10 killed |
| P0-2 | The recovery tool and its library contain no write-capable operation | `SOURCE_ENFORCED`, `DIRECTLY_TESTED` | the deletion, evidence and lock code was removed | hardening group C: a source scan for insert/update/delete/replace/bulk/index/collection/transaction calls finds none; the only file write is the exclusive-create report |
| P0-3 | A dry run changes no document, collection or index and creates no file | `DIRECTLY_TESTED` | connection opened with `autoIndex:false, autoCreate:false`; no write path exists | hardening group C compares every collection's contents and index names before/after; Phase 0 test E runs the CLI on a brand-new empty database for three argument forms and asserts the listing stays empty; mutant R04 (autoCreate on) killed. The pre-fix defect (10 empty collections created) is reproduced in `probes/phase0/prefix_repro_output.txt` |
| P0-4 | Arguments are parsed strictly: unknown, positional, duplicated, blank, valueless, malformed ids and `--flag=value` are refused; no environment variable enables a mode | `SOURCE_ENFORCED`, `DIRECTLY_TESTED` | `scripts/lib/cliArgs.mjs` | hardening group C (14 refusals incl. hostile environment); migration CLI tests (12 refusals); mutants A01–A04, R06 killed |
| P0-5 | The non-transactional fallback is honoured only for `NODE_ENV` exactly `development`/`test` **and** a loopback-only `MONGO_URI` **and** an explicit `REQUIRE_TRANSACTIONS=false`; every other combination is strict | `SOURCE_ENFORCED`, `DIRECTLY_TESTED` | `src/config/transactionPolicy.js` (pure), consumed by `config/environment.js` | Phase 0 test A: 4 accepted and 27 refused combinations, the real config module loaded in child processes; mutants T01–T07 killed. Pre-fix: staging/`Production`/`prod`/typo all honoured the opt-out (`probes/phase0/prefix_repro_output.txt`) |
| P0-6 | Destructive tools need real MongoDB transactions regardless of configuration; ordinary requests refuse without them | `SOURCE_ENFORCED`, `SIMULATED` | `assertRealTransactions()`; `purgeOrphans()` reports `TRANSACTIONS_UNAVAILABLE` | Phase 0 test A with a **stubbed** `hello` reply (named in the title; no real standalone server was used); mutant T08 killed |
| P0-7 | Readiness reports the transaction policy and fails when required transactions are unavailable; readiness changes and the policy at startup are logged as structured entries | `DIRECTLY_TESTED` | `app.js` `/api/ready`, `server.js` startup log | Phase 0 test A (stubbed standalone → 503, policy fields) and test B (real `server.js` child process: policy in readiness; ignored opt-out logged with the reason); mutants T09, T10, S03 killed |
| P0-8 | Normal startup never changes audit history; records that predate the chain are only reported | `DIRECTLY_TESTED` | `server.js` no longer calls any migration; `auditService.backfillLegacyChain` was removed | Phase 0 test B: the real server started on a mixed legacy history leaves every audit document byte-identical and logs `unchainedRecords: 2`; mutants S01, S02 killed. Pre-fix: the old function re-sealed already-chained records or crashed with E11000 (`probes/phase0/prefix_repro*.txt`) |
| P0-9 | The explicit legacy-chain migration only fills records that have no chain fields, never modifies a chained record, refuses unsafe history, is bound to the reviewed plan digest and the named database, resumes after interruption, and enumerates every record it would change | `DIRECTLY_TESTED`, `SIMULATED` (interruption, competing writer) | `auditService.planLegacyBackfill/applyLegacyBackfill`, `scripts/audit-chain-legacy-backfill.mjs` | Phase 0 tests C and D: exact deterministic plan, byte-identical chained prefix, 10 preflight refusals with structured findings, digest binding, replay refusal, conditional fill; mutants B01–B12 and C01–C05 killed. **Not run against any real historical data** |

### Mutation result (exact files)

44 hand-written defects against the Phase 0 mechanisms (transaction policy 10, startup 3, recovery tool 10, argument parsing 4, migration planning/apply 12, migration CLI 5): **44 killed, 0 survived, 0 pattern-not-found**, executed once against these exact files (every file restored and verified by hash after each mutant; all twelve hashes re-checked equal after the run):

| File | sha256 |
|---|---|
| `backend/src/config/transactionPolicy.js` | `b37645d62885ca4a924d63475babc7557a59bdafee5e78899502abe864666990` |
| `backend/src/config/environment.js` | `64a7269a3a5af1b406e59fb537ccbcc4ad4d14387662bbd4adf97962e32ac372` |
| `backend/src/utils/transaction.js` | `580856d6ea137ad77afb9302e0a22f8582a64788371c9ff8d351cca766d50499` |
| `backend/src/app.js` | `4353c10c3031669a3c5cabdaa08b9ae3bcea3eeec244e180a7c9a8d6a3f096df` |
| `backend/server.js` | `dd47750405f659bc5a1518cae6675d40229b0ec9e545aa6117a42d46a12d2566` |
| `backend/src/services/auditService.js` | `4b2cbe6c13ff348df0dae693b6e532cda1dd90c90491ab39d8cc387580476ead` |
| `backend/scripts/lib/snapshotReconciliation.mjs` | `a30eeb4db821daa6bc49c748e8b57e68ee1ef83b2884054df666250b7eff310e` |
| `backend/scripts/reconcile-payroll-snapshots.mjs` | `ba4d00d0f40ab33ceb5613f5cd72e272f23d00a927222f8c91ab6f25ba52e620` |
| `backend/scripts/audit-chain-legacy-backfill.mjs` | `415d2f2b7123e6fe32d082adf70a612ec9dc614df28a6f863d8191460578dc21` |
| `backend/scripts/lib/cliArgs.mjs` | `7d3c1045147a4f18df3e5503244acc865b922eb0409304910b873a63ea4c52e2` |
| `backend/test_integrity_phase0.js` | `8f88323510caf3ba34fdd339590437b8ad4d92f3f480a2c8288634cce84d046b` |
| `backend/test_audit_hardening.js` | `ed705e33dfef79bea56bca2f871bd8239ff549223043a9e50979b7ceaf4ead13` |

This result is exact for these files and for Phase 0 mechanisms only. It says nothing about earlier mutation counts; F-10 stays open.

## Phase 0 residual risks and limits

1. **Loopback is not proof of a local database.** An SSH tunnel or port forward to a remote or production database appears as `127.0.0.1`. The loopback boundary raises the bar (a remote URI never gets the fallback) but cannot detect a tunnel. `ASSUMPTION`: operators do not tunnel production to localhost with `NODE_ENV=development` and `REQUIRE_TRANSACTIONS=false`.
2. **The policy is read once, at module load, from the process environment.** Changing the environment of a running process has no effect; a deployment that sets `NODE_ENV=production` (exact) is strict regardless of the flag.
3. **The migration has not been run against real historical data**, only against fixtures and disposable databases. Its refusals are conservative by design (an unchained record older than the chain tail is refused rather than re-sealing history); a real database may therefore be refused until investigated.
4. **Chained records are verified by the same hash payload as before.** Phase 0 does not add an independent audit-hash test vector or change verification (Phase 5). Malformed chained records now produce a structured migration finding, but `verifyAuditChain` itself still throws on a garbage `createdAt` (open, Phase 5).
5. **Everything not listed under Phase 0 claims is unchanged from the audit's status**, including F-01 (a fork is still committable when both unique indexes are absent or ineffective) and F-04/F-05 (business state can still commit before its audit event at the non-transactional call sites). **The system-level audit-integrity gate remains closed.**
6. **A standalone server was never used.** Behaviour on a real standalone `mongod` is `SIMULATED` (stubbed `hello`).
7. **Single-node replica set only.** Failover/stepdown is `UNVERIFIED`.
8. **One unexplained intermittent failure in the full suite.** Of four valid full-suite runs on the Phase 0 files, three were 978/978 green (two consecutive: runs 3 and 4) and one had a single failure: `test_wave2.js` "bank accounts are versioned and masked…" stalled 49 s and then failed with `fetch failed / ECONNRESET`, where it normally takes ~100–250 ms. The MongoDB log shows no slow operation on that database; `test_wave2.js` run alone passed 8 of 8 (~100 ms); the Phase 0 diff does not touch the request or audit-append path. The cause is **not established** (candidates: host stall, or the in-process audit queue/transaction interaction described in audit findings L2-F07/L3-F02, which Phase 2 and 3 rework). It is recorded here rather than dismissed. Two earlier full-suite runs were invalid because the local replica set had stopped (logs kept as `INVALID_db_down_*`).

## Documentation corrected in Phase 0

`docs/AUDIT-CHAIN-AND-SNAPSHOT-RECOVERY.md` no longer claims: a re-check "after any collision" (not implemented); that a dropped index can only fork "in principle" (it forked in three independent reproductions); that deletions are detected (tail truncation is not); that a dry run "writes nothing" without the collection-creation fix; that the purge race's worst outcome is a skipped record (false for run status); a working apply mode; or a lease that makes overlapping applies safe. Each corrected statement is marked *(corrected)* in that document.

## Next phase

Phase 1 (model the invariants) — entry criteria: Phase 0 committed, claims above unchanged, full backend suite green twice on the Phase 0 commit. Phase 4 (rebuild recovery) must not begin before Phase 2 and Phase 3 are complete, and apply stays disabled until all twelve Phase 4 release gates pass independently.
