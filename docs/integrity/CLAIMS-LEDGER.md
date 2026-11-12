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
| F-01 | Guard compares key+unique only; 10 s blind cache; fork committed and success reported when both guards absent/ineffective (MEDIUM, HIGH under C1) | **ADDRESSED in Phase 2 for writers that follow the head protocol** (the guard and its cache are gone; the head document, not the indexes, arbitrates). **OPEN for writers outside the protocol** (a head-unaware writer that fakes `headVersion` while the unique indexes are ineffective forks the chain and is found only by `verifyAuditChain`; pinned by a test). Production activation needs the cutover | 2 |
| F-02 | Purge transaction reads the run but never writes it: `FAILED→PROCESSING` retry slips through (MEDIUM) | **CONTAINED** (the purge no longer exists) — not fixed | 4 |
| F-03 | `ORPHAN_PENDING` ignores finalization history; a flipped, previously finalized snapshot is purgeable (MEDIUM) | **CONTAINED** (no apply exists). The new read-only inspection (`payrollSnapshotRecoveryService`) classifies a snapshot with finalization audit evidence as `FINALIZED` whatever its status says (`DIRECTLY_TESTED`, P3-9); nothing can act on the classification | 4 |
| F-04 | Ambiguous commit surfaces as raw HTTP 500, no "outcome unknown" marker (MEDIUM) | **ADDRESSED in Phase 3**: an unconfirmed commit is settled from durable evidence written in the same transaction, or returns 503 `COMMIT_OUTCOME_UNKNOWN` with the `operationId`; a retry is never re-executed (P3-4 to P3-7). Real faults on a single-node replica set only | 3 |
| F-05 | "Nothing was written; retry" wording wrong for post-commit plain audit callers; business state can commit without its event at 4 payroll + 3 auth sites (MEDIUM) | **ADDRESSED in Phase 3**: the seven sites write the business change and the event in one transaction (P3-1, P3-2) | 3 |
| F-06 | Guard invisible to readiness; failed build uncached and run in requests (MEDIUM) | **RESOLVED in Phase 2**: no index creation or repair on the request path; `/api/ready`, `--status` and startup report the exact specification, the validator, the head and a running index build (best effort, needs `$currentOp`); the readiness computation is single-flight, bounded and cached. Residual: Mongoose `autoIndex` still builds the schema indexes at application start (documented, additive) | 2 |
| F-07 | `backfillLegacyChain` ran at every startup, re-sealed chained history, not crash-safe (MEDIUM) | **RESOLVED** (Phase 0) — startup never writes; explicit, preflighted, digest-bound command | 0 |
| F-08 | Transaction opt-out honoured for any `NODE_ENV` ≠ `production`; destructive tool inherited the fallback (MEDIUM) | **RESOLVED** (Phase 0) — two-boundary policy; destructive tools need real transactions | 0 |
| F-09 | Tail truncation undetectable; doc claimed deletions detected (MEDIUM) | **PARTIALLY ADDRESSED** (Phase 2 head): removing the newest records after the cutover, head untouched, is detected (`HEAD_SEQUENCE_MISMATCH` / `HEAD_AHEAD_OF_CHAIN`, `DIRECTLY_TESTED`). **Still undetectable**, and pinned by tests: truncation before the cutover, and truncation together with a head rewritten to match (an external checkpoint would be needed) | 5 |
| F-10 | Test evidence overstated (33/33 mutants not shown for the committed test file; 100-way test serialized; no absent-guard concurrency test; no commit-ambiguity test) (MEDIUM) | **OPEN** (the Phase 0 and Phase 2 mutation results are exact for their own mechanisms only). Phase 2 added: an absent-index multi-process matrix (after an invalid first version, see the Phase 2 section), a positive control, commit-ambiguity tests labelled SIMULATED | 6 |

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
8. **One intermittent failure in the full suite during Phase 0, now attributed to the host's power state.** Of four valid full-suite runs on the Phase 0 files, three were 978/978 green and one had a single failure: `test_wave2.js` "bank accounts are versioned and masked…" stalled 49 s and failed with `fetch failed / ECONNRESET` (normally ~100–250 ms). At the time the cause was recorded as not established. It has since been established with reasonable confidence: the Windows System log (Kernel-Power) shows the machine entered **Modern Standby at 18:59:57 and resumed at 19:01:07 on 2026-10-19**, which is exactly where that test ran, and the MongoDB log shows sockets "forcibly closed by the remote host" in the same minutes. A second run in Phase 1 stalled for ~33 minutes in `test_phase10.js` STEP-26 for the same reason (standby 19:25:30–19:59:10 and 19:59:10–20:08:44; the MongoDB replica-set monitor itself logged a 4,391,786 ms "no primary" gap at 20:08:43). Both logs are kept as `FLAKE_*` / `INVALID_host_standby_*`. Consequence for the evidence: a full-suite run is only counted when no standby/sleep event overlaps it. This is an inference from timestamps, not a reproduction. Two earlier runs were invalid because the local replica set had stopped (`INVALID_db_down_*`).

## Documentation corrected in Phase 0

`docs/AUDIT-CHAIN-AND-SNAPSHOT-RECOVERY.md` no longer claims: a re-check "after any collision" (not implemented); that a dropped index can only fork "in principle" (it forked in three independent reproductions); that deletions are detected (tail truncation is not); that a dry run "writes nothing" without the collection-creation fix; that the purge race's worst outcome is a skipped record (false for run status); a working apply mode; or a lease that makes overlapping applies safe. Each corrected statement is marked *(corrected)* in that document.

## Phase 1 claims — executable invariant models

Everything in this section is model evidence: class `SIMULATED` (bounded exploration of abstract models), never `DB_ENFORCED` or `DIRECTLY_TESTED`. Full scenario table, assumptions, limitations and the shortest counterexample traces: `docs/integrity/MODEL-RESULTS.md` (generated; a test regenerates it and fails on any difference). Code: `backend/test_support/integrityModel/`. Tests: `backend/test_integrity_model.js` (78 tests, no database needed).

| # | Claim | Class | Evidence |
|---|---|---|---|
| P1-1 | The exploration tool is a bespoke bounded breadth-first explicit-state explorer, **not** TLA+/TLC. **TLC and Apalache were not run** (no Java in this environment). | `UNVERIFIED` for any TLC result | `MODEL-RESULTS.md` header; explorer tested on a lost-update system (finds it, shortest trace of 4 steps), on its atomic version (clean), on truncation and on an initial-state violation |
| P1-2 | The models of the **current** design reach the known failures: a chain fork with success reported while both unique indexes are absent (A4, F-01); business state committed without its audit event, a false "nothing was written", and duplicate application after an ambiguous commit (B1, B2: F-05, F-04); a purge on a stale run state, by a superseded lease owner, and of a snapshot with finalization evidence (C1, C2: F-02, F-03); re-sealed history by the old startup backfill (D1: F-07); a deleted snapshot without a durable before-image (E1) and without its audit event in the non-transactional fallback (E3: F-08) | `SIMULATED` | each trace is replayed step by step against the model's own transition function and verified to violate the invariant only at its last state |
| P1-3 | Either unique index alone prevents the fork; neither does not (A2, A3, A4) — the audit's finding, reproduced independently in the model | `SIMULATED` | scenarios A1–A4 |
| P1-4 | The **proposed** designs satisfy the named invariants within the bounds: transactional head compare-and-set with 2 and 3 writers and both indexes dropped (A5, A6); transactional path with an operation id checked in the same transaction (B4); run write + evidence check + fencing token (C3, C4); the explicit migration (D3, D4); directory fsync (E2) | `SIMULATED`, designs **not implemented yet** | complete explorations (860 states or fewer per scenario) |
| P1-5 | Each protection is load-bearing: removing exactly one brings back exactly its violation (run write → `NoPurgeAfterEligibilityChanges`; evidence check → `NoPurgeOfEverFinalized`; fencing → `ExpiredOwnerCannotDelete`; version condition on the head → fork; operation-record lookup → duplicates). Single protections alone are insufficient (outbox alone: duplicates remain; run write alone or fencing alone: the other violation remains) | `SIMULATED` | scenarios A7, B3, B5, C5–C9 |
| P1-6 | **Rollout condition:** the head-document protocol protects only writers that follow it. An old writer that bypasses the head breaks `HeadMatchesLastCommittedEntry` even with the unique indexes present, and forks the chain when they are absent. Old instances must be drained or blocked before the head becomes authoritative. | `SIMULATED` | scenarios A9, A10 |

### Mutation result (exact files)

18 hand-written defects in the explorer (6) and the models (12): **18 killed, 0 survived, 0 pattern-not-found**; every file restored and re-verified by hash. Honest caveat: mutant M4 (the guard cache never expires) was killed **only** by the document-regeneration test — in the explored configurations the cache-expiry action changes no scenario verdict (it can only reduce the fork window), so it is not shown to be load-bearing by this model.

| File (under `backend/`) | sha256 |
|---|---|
| `test_support/integrityModel/explorer.mjs` | `754035f71601eecf380a09c4f1fc7cd1f9f5a5d08fcf006ef7a0c14d87059bd1` |
| `test_support/integrityModel/auditChain.mjs` | `2d24e01b41ee9826ed8b2c843678a63279f41cd73adb1fd76ccf868aa35cdf07` |
| `test_support/integrityModel/businessAudit.mjs` | `3a86616b315f82354992b114120d1ba610c9f8a0a83c1b5868468b94e662f10b` |
| `test_support/integrityModel/recovery.mjs` | `7f5bd7e76d2ee619150527c8e1aabded7ef49425af69d2099ae4119bc160f09e` |
| `test_support/integrityModel/historyAndEvidence.mjs` | `cbab3dfd1cec779ebd5008023f1e317ea2d34e65353b116c93e4aa97e42973ff` |
| `test_support/integrityModel/scenarios.mjs` | `e80854ec59acbf140852e1f24838a64953ac77499957818da899a799d8678e91` |
| `test_support/integrityModel/report.mjs` | `44163069cdb7a3e9fe10931995b601cc0784c8005586f6510a7cb9aefe933900` |
| `test_support/integrityModel/run.mjs` | `975f30ab5b79bee7d38aa33a2d80dc723af320da57ebb75704b50c4acf6ae609` |
| `test_integrity_model.js` | `0d05e104beefc631bb9185f2f42f41e2a7447da27c18aa49ebad16b44140370e` |

### Phase 1 limits (summary; the full list is in `MODEL-RESULTS.md`)

1. A clean model result is a statement about a **design** under stated assumptions, not about the implementation. No finding is closed by Phase 1; all statuses in the findings table above are unchanged.
2. Bounded: 2 writers (3 for the head-compare-and-set model), at most 2 attempts, each index dropped at most once, one lease expiry, one run retry, one logical operation with at most 2 attempts, one global chain, power loss at most once.
3. Commit is an atomic first-committer-wins step; time is abstract (no clock skew); safety only (no liveness); no failover, rollback, partition or replication lag.
4. The bespoke explorer has not been cross-checked against TLC. If Java and TLC become available the same models should be re-expressed in TLA+ and checked; until then `UNVERIFIED`.

## Phase 2 claims — the transactional audit-chain head

> **Verification status: INCOMPLETE.** At the owner's instruction the remaining checks were skipped and the work was committed. What was and was not done on the final source: (a) the full backend suite was **not** run on this source, and not twice; (b) the head test file passed 117/117 in its last complete execution, the hardening (35), Phase 0 (26), `test_phase11b_audit_chain` (1) and `test_phase12` (27) files passed after the review fixes, and the database-free suites (the model explorer and the Phase 1D scaffold suites, 78 + 69 + 116 + 25 + 42 + 29 + 25, and rounding, 24) passed; (c) the mutation suite was **not completed** (see below); (d) the remediation was not independently re-reviewed. The Phase 1D scaffold hash was re-checked and is unchanged. Nothing in this section should be read as "Phase 2 verified".
>
> **Later evidence (2026-10-25, recorded 2026-11-09; the note above is left as written).** The full backend suite was afterwards run twice on a clean working tree at `aba9bc1`: 1,173/1,173 both times (`payguard-evidence/final-2026-10-25/suite_run1.log`, `suite_run2.log`, headers record the commit and the tree id). The Phase 2 mutation run and the independent re-review were still not completed.

Specification: `docs/integrity/AUDIT-CHAIN-HEAD.md` (sections 1-12). Commit: see Git history (`Enforce transactional audit-chain head integrity`). Tests: `backend/test_audit_chain_head.js` (118 tests; the last complete execution had 117, all passing, before a positive-control test, a mixed-hosts case and a stronger message assertion were added, each of which was run on its own only), `backend/test_audit_hardening.js` (35), `backend/test_integrity_phase0.js` (26); full backend suite: **NOT RUN on the final candidate** (see the verification status below). Evidence outside the repository: `payguard-evidence/phase2-2026-10-19/` (raw review findings, benchmark results with provenance, probes, mutation results, logs). An independent four-lens read-only review of the uncommitted change produced 50 findings; each was checked and dispositioned (specification section 12). **The remediation was not independently re-reviewed.**

| # | Claim | Class | Mechanism | Evidence |
|---|---|---|---|---|
| P2-1 | A writer that follows the protocol cannot fork the chain whatever the state of the unique indexes | `DB_ENFORCED` (the server's write conflict on the one head document), `DIRECTLY_TESTED` | the head advance is a conditional update in the record's transaction | barriered multi-process races under 10 index configurations, with the injected index state asserted when the writers are released and after the race; an in-process paused writer and an overtaken first append with every unique index dropped; a **positive control** shows the same harness DOES fork when the pre-head algorithm runs without the indexes and does not with them. **The first version of this evidence was invalid** (the race workers re-created the dropped indexes through Mongoose `autoIndex`; found by the review, confirmed by probe, withdrawn and redone) |
| P2-2 | The head advance and the record commit or roll back together; rollback at every step leaves records, head and business writes untouched | `DIRECTLY_TESTED` for real aborts, a callback that throws and a real `SIGKILL` of a process holding an uncommitted advance; `SIMULATED` for injected exceptions, an injected commit failure on a real replica set, a commit that never reaches the server | the same transaction | test group D (head read, head update, insert, callback, 2nd/3rd event, transient and definite commit failures, lost commit, crash). A crash stalls audited writes of every process for about the server's `transactionLifetimeLimitSeconds` (measured 4.1 s with the limit at 3 s; default 60 s extrapolated) |
| P2-3 | No silent independent commit, no accidental nested transaction | `SOURCE_ENFORCED`, `DIRECTLY_TESTED` | `log()` needs a session with an active transaction; `logStandalone` refuses to run inside a transaction callback; `log()` refuses a session of a nested transaction | group E; six census tripwires (inventory of every file touching the audit machinery, members of `auditService`, call counts, direct references, computed-name writers, `logStandalone` placement). The census is regex based and a tripwire, not a proof |
| P2-4 | The audit hash format is byte-for-byte unchanged | `DIRECTLY_TESTED` | `hashPayload`, `normalize`, `canonicalize`, `calculateAuditHash`, `GENESIS_HASH` untouched | the hashing block extracted from commits `2dfddaf`, `04c872b`, `9534553` and the working tree is textually identical after line-ending normalization and gives the pinned digest for a literal payload (artefact `hash_vector_check_result.txt`). The test oracle was re-aligned once to the service's observed behaviour (every number is hashed as a decimal string): it re-states the observed rules, it is not an independent derivation of the original intent |
| P2-5 | The database shape is judged exactly: three unique indexes (key, order, uniqueness, partial filter, sparse, collation, TTL, hidden, unfinished marker) and the validator | `DIRECTLY_TESTED` | `auditChainSpec` | live configurations in the matrix and group F2; a validator test on a real server (missing, null, string, boolean, zero, negative, below-one, array, object refused; numbers of at least one accepted); the specification is pinned literally in the test. The evaluator is stricter than necessary in places (hidden index, differently spelled partial filter): a false alarm in the safe direction, documented |
| P2-6 | After the cutover the database refuses records from writers that do not carry `headVersion` | `DB_ENFORCED` (validator, code 121), `DIRECTLY_TESTED` | collection validator `moderate`/`error` | old-writer tests; two real-server interleavings (a transaction whose snapshot predates the validator is refused with a catalog-change WriteConflict; one already holding the collection holds the cutover back and its record is caught by the tail check). **Not a security boundary**: a writer that fakes the field passes |
| P2-7 | Controlled initialization: dry run by default, refuses forks / gaps / bad links / edited or unreadable records / unchained or protocol-without-head records / incompatible shape / running or unobservable index builds / recent writes; one head; no record modified; bound to the reviewed digest, the database name and the cluster | `DIRECTLY_TESTED` | `scripts/audit-chain-head.mjs`, `auditChainHeadService` | groups F and F2 (empty and absent collections included; N initializers released together at the validator step; the CLI writes its evidence file). Truncation before the cutover remains undetectable (limitation recorded in every head) |
| P2-8 | Readiness fails closed and reports the exact state; the strict/relaxed mode is an allow-list | `DIRECTLY_TESTED`, `CONFIG_DEPENDENT` | `/api/ready`, `auditChainPolicy` | mode table, the real config module in child processes, readiness failure / timeout / single flight / no driver text, the loopback-only genesis bootstrap |
| P2-9 | The per-process transaction lane is a liveness mechanism; safety does not depend on it | `DIRECTLY_TESTED` | FIFO lane in `runInTransaction` | group H; race tests with the lane off. Its costs (login coupling, a hung transaction blocks the process) are documented and **not measured** (the long-transaction workload was not run) |
| P2-10 | Performance: the candidate meets every declared criterion; the gains over the baseline are the lane's, and the head protocol alone is not acceptable without the lane | `REPORT_ONLY` (benchmark logs; each result file carries the sha256 of the benchmarked source, equal to the final source) | harness v2, four configurations back to back (baseline, baseline + lane, candidate, candidate lane-off) | specification section 9. **The first implementation failed the declared gate and the lane was adopted afterwards: a post-redesign pass, flagged for the owners.** Synthetic single-process workloads only |
| P2-11 | A re-run transaction callback does not apply an outer-scope effect twice (`activateDue`) | `DIRECTLY_TESTED` | the count is taken after the commit | group E2; the pre-fix counting is a mutant that the suite kills |
| P2-12 | A database that has been cut over can be cloned with `copy-database` | `DIRECTLY_TESTED` | validators are applied after the documents are loaded | group F2 (documents byte-identical, indexes and validator present). `mongorestore` behaviour is `UNVERIFIED`; the procedure is documented |

### Mutation result (exact files)

**Partial. 91 mutants are defined (`mutation_phase2_v2.mjs`); 28 were executed against the final source and tests before the run was stopped at the owner's instruction; 63 were not run.** Of the 28: **26 killed, 0 survived, 2 inconclusive** (P01 and P02 timed out because the host was in Modern Standby; they are not counted as kills and were not re-run). Run, in order: P01-P10 (P01, P02 inconclusive, P03-P10 killed), S01-S07, V01-V07, X01-X04. **Not run on the final source:** X05-X11 (the specification evaluators), I01-I10 (initialization), L01-L05 (the lane), R01, E01, E02, F01, A01 (the pre-fix `activateDue` counting), the 36 mutants added for the review remediation (mode policy, loopback bootstrap, nested audited append, retry budget, snapshot read, cutover findings, CLI evidence, readiness, copy-database, validator and specification pins, the race workers' `autoIndex`, the census tripwires). The frozen manifest of the 20 files (source and tests) the run was bound to is `hashes_before_mutation_phase2_v2.txt` in the evidence directory; every file was verified against it after the run was stopped.

**Later runs (recorded 2026-11-09; the paragraph above is left as written).** After commit, two further runs of the same suite exist. **Run D** (2026-10-25, `final-2026-10-25/`, 62 mutants): 41 killed and 21 recorded as survived, but only **Q03** is a genuine survival (a complete run, exit 0: the policy decision was equivalent and only an operator note was untested). Q16's test process was terminated from outside (exit `0x40010004`), and the last 19 (Q17–C02) never started (exit `0xC000026B` within about 100 ms, the host shutting down): those are invalid runs, not survivals. **Run E** (2026-10-27, `master-2026-10-27/`, 48 mutants including those 19): 47 killed, Q17 inconclusive (timeout), and Q33's kill is compromised because its file was restored while it was under test. Tests pinning Q03's note and Q16's digest binding were added in Phase 3. On 2026-11-09, on the Phase 3 source, Q03, Q16, Q17 and Q33 were re-run cleanly: **all four killed**, every file re-verified by hash (`phaseQ_rerun.json`). The other mutants of the full set have still not been run on one exact source, so this remains **partial**.

Earlier, on the pre-remediation tests, a complete run of 50 mutants killed 45 and left five survivors (P08, S07, V06, X08, E02). That result is **superseded, not extended**: the remediation changed the tests (the survivors P08, S07 and V06 were each shown killed in the partial run above, as was S03, which survived a first partial run of the v2 suite before its test was strengthened; X08 and E02 were not re-run on the final source). Two further results of that earlier run were invalid: I03 and I04 were recorded as kills only because of host-standby timeouts.

### Phase 2 limits and residual risks

1. **F-05 and F-04 are not closed** (Phase 3): seven audit-only call sites still append after a business commit; an ambiguous commit still surfaces as the raw driver error, without operation ids.
2. **The head check is not a chain walk**, and a head-unaware writer that fakes `headVersion` while the unique indexes are ineffective is not detected at append time (pinned by tests). Only `verifyAuditChain` finds such a fork.
3. **Tail truncation** before the cutover, or together with a rewritten head, is undetectable (F-09, Phase 5).
4. **The gate pass is post-redesign.** The lane's availability coupling (logins queue behind a long transaction of the same process, up to 60 s, then a retryable 503) is a decision for the owners; it was not measured.
5. **A crashed process stalls audited writes** of every process for about the server's transaction lifetime limit.
6. **Not verified:** failover and stepdown, a real standalone server, a real lost commit reply or `failCommand` failpoint, `mongorestore` behaviour, behaviour on any topology other than a single-node replica set, production-scale traffic.
7. **The 49 s zero-commit race** has a most-likely explanation (workers rebuilding indexes during a slowed run) but was never reproduced; the index-fault matrix has passed in all five full executions of the head test file since (four of them also had failures elsewhere that were test-design problems, fixed afterwards).
8. **Development databases need the cutover.** A database that already has audit records and no head makes every audited action fail with `AUDIT_CHAIN_NOT_INITIALIZED` (503) until `scripts/audit-chain-head.mjs` has been run on it; the relaxed mode never invents a head over a non-empty chain.
9. Everything outside the Phase 2 claims keeps its earlier status. **The system-level audit-integrity gate remains closed**; production statutory-wage calculation and recovery `--apply` remain **NO-GO**.

## Phase 3 claims — atomic audit events, idempotency, unconfirmed commits

Specification: [`IDEMPOTENCY.md`](IDEMPOTENCY.md), [`AMBIGUOUS-COMMIT-RECOVERY.md`](AMBIGUOUS-COMMIT-RECOVERY.md), [`TRANSACTIONAL-ATOMICITY.md`](TRANSACTIONAL-ATOMICITY.md), [`SNAPSHOT-RECOVERY.md`](SNAPSHOT-RECOVERY.md). Tests: `backend/test_atomicity.js` (23), `backend/test_commit_ambiguity.js` (5, against a disposable `mongod` with test commands enabled), `backend/test_snapshot_recovery.js` (15). Evidence: `payguard-evidence/master-2026-10-27/phase-atomicity/`.

Provenance: the F-05 conversions, the recovery inspection and the lease model were written in an earlier unattended session (2026-11-01) and reviewed here. That session's idempotency design was **replaced**, not extended: it wrote no evidence inside the business transaction, had no fencing, burned the key on every 5xx, surfaced the raw driver error and declared a non-partial unique `operationId`. A copy of it is kept in the evidence directory.

| # | Claim | Class | Mechanism | Evidence |
|---|---|---|---|---|
| P3-1 | At the seven F-05 sites (lockout, sign-in, logout-all, preflight, processing start, stuck-run recovery, fail-run), the business change and its audit event commit together or not at all | `DIRECTLY_TESTED` (a real audit outage, made by removing the head; one event SIMULATED, as named in its test) | one `runInTransaction` callback, `auditService.log(params, session)` | group A |
| P3-2 | No cookie or other external effect happens inside those transactions | `SOURCE_ENFORCED` | cookies are set after the commit | review |
| P3-3 | Every audit writer passes the literal `session` to `log`; 35 `log` and 3 `logStandalone` sites, each file's count pinned | `SOURCE_ENFORCED`, `DIRECTLY_TESTED` | census 3 | `test_audit_chain_head.js` |
| P3-4 | Each committed transaction of a keyed request leaves a marker in the operation record, written in the same transaction | `DB_ENFORCED` (the transaction), `DIRECTLY_TESTED` | `recordInTransaction` | group B |
| P3-5 | A request whose lock was taken over cannot commit, including while its replacement is still `IN_PROGRESS` | `DB_ENFORCED` (the conditional update matches nothing and aborts the transaction), `DIRECTLY_TESTED` | `lockToken` fence | group B, both FENCING tests |
| P3-5a | A transaction nested inside another during a keyed request is refused (`IDEMPOTENCY_NESTED_TRANSACTION`); a full-suite trace found no production path that nests | `SOURCE_ENFORCED`, `DIRECTLY_TESTED`; the trace is coverage evidence, not proof | refusal in `runAttempts` | group B; `phase-atomicity/nested_trace.jsonl` |
| P3-6 | An attempt that committed work is never re-run, whether it failed, crashed or lost its reply | `DIRECTLY_TESTED` | takeover and release require `committedTransactions = 0` | group B |
| P3-7 | A commit the server applied but did not confirm is recognised from the marker; one it never applied returns `COMMIT_OUTCOME_UNKNOWN` and is not re-run; a definite (transient) commit refusal is retried, not reported as unknown | `DIRECTLY_TESTED` with **real** `failCommand` faults on a single-node replica set | `commitResolvingOutcome`, bounded majority-read polling | `test_commit_ambiguity.js` |
| P3-8 | Snapshot recovery apply always refuses | `SOURCE_ENFORCED`, `DIRECTLY_TESTED` | `applySnapshotRecovery` throws 503 | `test_snapshot_recovery.js` |
| P3-9 | Recovery inspection treats any finalization evidence as `FINALIZED` and a broken chain as ineligible; leases are fenced by token **and** fence value, and an expired lease cannot be renewed | `DIRECTLY_TESTED` | inspection, `SnapshotRecoveryLease` | `test_snapshot_recovery.js` |
| P3-11 | Within the model's bounds the implemented operation-record protocol applies one logical operation at most once and never reports success for work that was not applied; each protection (token fence, takeover rule, COMPLETED-only TTL, keeping UNKNOWN, refusing nesting, requiring evidence) is load-bearing | `SIMULATED` (model F, bespoke explorer, not TLC); assumes the TTL outlives every request (F8 shows the case where it does not) | `test_support/integrityModel/operationRecord.mjs` | `MODEL-RESULTS.md` F1–F9; `test_integrity_model.js` |
| P3-10 | "Never re-run" does not lapse with time: only `COMPLETED` idempotency records expire, `IDEMPOTENCY_TTL_HOURS` after **completion** (`completedAt`); `UNKNOWN_COMMIT` and committed `IN_PROGRESS` records are kept; the migration removes both earlier TTL indexes (Wave 1: every record after 24 h, so the guarantee held for one day; `30ebb7c`: counted from creation, so a record taken over long after creation could expire as it completed) and backfills `completedAt` | `DB_ENFORCED` (partial TTL index), `DIRECTLY_TESTED` against the real TTL monitor; on an existing database `CONFIG_DEPENDENT` on deploying new code everywhere and then running `npm run migrate` | `idempotency_ttl_completed_at`; `migrate.js` step 8 | `test_commit_ambiguity.js` retention group; 5/5 retention mutants killed (`phase-ops/mutation_retention2.json`) |
| P3-12 | The nine financially material, irreversible routes **require** an `Idempotency-Key` (428 without one); a repeat of each, even with a fresh key, is stopped by a business-level guard | `SOURCE_ENFORCED` (route inventory pinned), `DIRECTLY_TESTED` (428 path; repeats with fresh keys through the real app) | `idempotent({ required: true })`; partial unique period index, conditional transitions, salary/compensation/bank guards | `test_idempotency_policy.js`, `test_atomicity.js`, `test_phase12.js` |
| P3-13 | A fresh installation can be seeded: the three baseline rule versions validate against the schema and keep their reviewed values | `DIRECTLY_TESTED` (the real seed command on a disposable database) | description ≤ 500 characters; values pinned | `test_seed_compliance.js` (fails on the `f0f9c00` seed: F-H01) |

### Suite runs on the Phase 3 source

| Run | Date (UTC) | Result |
|---|---|---|
| a1 | 2026-11-06 | **Interrupted** (the host stopped). Before it stopped: census 3 failed on stale totals (fixed in the test) and the multi-process "queue OFF" test failed once with its detail lost. That test then passed 11/11 idle and 5/5 with every core saturated; **cause unknown, recorded as an open intermittent** |
| a2 | 2026-11-09 | **1,233/1,233**, 0 skipped, exit 0, on the source before the mutation fixes (manifest in `suite_a2_header.txt`). Superseded by a3/a4 |
| trace | 2026-11-09 | 1,233/1,233 with a temporary nesting trace in `transaction.js` (removed; restored file verified by hash) |
| a3, a4 | 2026-11-09 | **1,240/1,240 twice**, 0 skipped, exit 0, on the final source; the two manifests are identical (`suite_a3_header.txt`, `suite_a4_header.txt`). The golden snapshot hash `ca97dc1e…2868` is asserted by three suite files and was recomputed independently |

### Mutation result

43 hand-written defects against `transaction.js` (7), `idempotencyService.js` (7), `idempotency.js` (10), the seven F-05 sites (one per site: the business write moved outside the transaction) and the recovery foundation (12). Harness: `phase-atomicity/mutation_atomicity.mjs` (the Phase 2 runner, line-ending aware, one exact match required); every file restored and re-verified by hash after each mutant.

- **Run 1** (source before the fixes): 32 killed, 11 survived. Survivors that were real test gaps: O01 (no test of a stale attempt committing while its replacement is still `IN_PROGRESS`: the fencing claim was half-tested), T02 (a nested transaction's commit is invisible to the operation record, so a retry could apply it twice: **a code defect, fixed by refusing nesting during a keyed request**), T03 (a definite transient commit failure must be retried), O05, I09, R03, R04, R08. Tests were added for each.
- **Run 2** (final source): **40 killed, 3 survived**, 0 inconclusive, 0 pattern-not-found. The three were annotated before the run: O04 (a non-majority evidence read: equivalent on a single-node replica set; it matters on a multi-node set, which is untested), I07 (the key release's durable re-check: defence in depth behind the process counter), R12 (tenant mismatch: the query is already tenant-scoped).

Run 1 is kept, not discarded: `mutation_run1.json`, `mutation_run2.json`.

### Phase 3 limits

1. **Single-node replica set only.** Failover, stepdown, multi-node majority and partitions are `UNVERIFIED`.
2. Requests **without** an `Idempotency-Key` have no operation record: they still get `COMMIT_OUTCOME_UNKNOWN`, but nothing durable settles it.
3. `UNKNOWN_COMMIT` and `PRIOR_ATTEMPT_COMMITTED` are resolved by a person following [RUNBOOK-UNCONFIRMED-OPERATIONS.md](RUNBOOK-UNCONFIRMED-OPERATIONS.md); there is no tool, and the records are never edited by hand.
4. The idempotency fallback without transactions (development/test only) does not give the evidence guarantee.
5. The lock period (five minutes) must exceed the server's `transactionLifetimeLimitSeconds` for a takeover after a timed-out `UNKNOWN_COMMIT` write to be safe.
6. F-02 (the purge's unfenced run read) remains **CONTAINED** only because no purge exists. Before any apply, the gates in `SNAPSHOT-RECOVERY.md` and a new review are required.
7. Not independently reviewed. **The system-level gates stay closed**; production statutory-wage calculation and recovery apply remain **NO-GO**.
