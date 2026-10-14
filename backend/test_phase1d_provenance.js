/**
 * test_phase1d_provenance.js — source provenance: three distinct hashes, four independent
 * statuses, manifest integrity (Phase 1D scaffold; pure, no database).
 *
 * Groups A (manifest integrity), B (independent SHA-256), C (status separation) and O
 * (source-version immutability).
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  sourceArtifactHash, mappingEntryHash, registerSnapshotHash, verifyRegisterSnapshot, validateMappingEntry, validateStatus,
  validateManifest, verifyManifestBytes, orderEntries, MAPPING_ENTRY_SCHEMA,
  EVIDENCE_STATUSES, LIFECYCLE_STATUSES, INTERPRETATION_STATUSES, ENABLEMENT_STATUSES,
} from './src/statutoryWage/provenance.js';
import { sha256Hex } from './src/statutoryWage/canonical.js';
import { pollutionDifferential } from './test_support/wageFixtures.js';
import { StatutoryWageError, STATUTORY_WAGE_ERROR_CODES as C } from './src/statutoryWage/errors.js';

const bytes = (text) => new TextEncoder().encode(text);
const ARTIFACT_A = bytes('fixture artifact A (not a legal document)');
const ARTIFACT_B = bytes('fixture artifact B (not a legal document)');
const HASH_A = sha256Hex(ARTIFACT_A);
const HASH_B = sha256Hex(ARTIFACT_B);

const status = (overrides = {}) => ({ evidence: 'ACQUIRED_HASHED', lifecycle: 'FINAL', interpretation: 'OPEN', enablement: 'NOT_ENABLED', ...overrides });
const entry = (overrides = {}) => ({
  schema: MAPPING_ENTRY_SCHEMA, mappingId: 'FIXTURE_MAPPING_1', mappingVersion: 1, instrument: 'FIXTURE_INSTRUMENT', provision: 'FIXTURE_PROVISION',
  exactText: 'fixture text', sourceArtifactHashes: [HASH_A], status: status(), ...overrides,
});
const expectCode = (fn, code) => {
  let error = null;
  try { fn(); } catch (e) { error = e; }
  assert.ok(error instanceof StatutoryWageError, `expected ${code}`);
  assert.equal(error.code, code);
};

describe('three distinct hashes, never interchangeable', () => {
  test('sourceArtifactHash is the SHA-256 of the exact bytes and nothing else', () => {
    assert.equal(sourceArtifactHash(bytes('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.equal(sourceArtifactHash(ARTIFACT_A), HASH_A);
    assert.notEqual(sourceArtifactHash(bytes('abc ')), sourceArtifactHash(bytes('abc')), 'one extra byte is a different artifact');
    expectCode(() => sourceArtifactHash('abc'), C.RULE_DEFINITION_INVALID); // text is not bytes
  });

  test('mappingEntryHash hashes the canonical record, and changes when the cited source artifact changes', () => {
    const one = mappingEntryHash(entry());
    assert.match(one, /^[0-9a-f]{64}$/);
    assert.equal(mappingEntryHash(entry()), one, 'deterministic');
    assert.notEqual(one, HASH_A, 'it is not the source artifact hash');
    assert.notEqual(mappingEntryHash(entry({ sourceArtifactHashes: [HASH_B] })), one, 'citing another artifact changes the entry hash');
    assert.notEqual(mappingEntryHash(entry({ exactText: 'fixture text.' })), one);
    assert.equal(mappingEntryHash({ ...entry(), status: { enablement: 'NOT_ENABLED', interpretation: 'OPEN', lifecycle: 'FINAL', evidence: 'ACQUIRED_HASHED' } }), one, 'key order is irrelevant');
  });

  test('registerSnapshotHash covers the whole ordered set, is order-independent, and moves when any entry or the metadata moves', () => {
    const e1 = entry();
    const e2 = entry({ mappingId: 'FIXTURE_MAPPING_2', sourceArtifactHashes: [HASH_B] });
    const metadata = { registerVersion: 1, label: 'fixture register' };
    const one = registerSnapshotHash({ metadata, entries: [e1, e2] });
    assert.equal(registerSnapshotHash({ metadata, entries: [e2, e1] }), one, 'input order does not matter');
    assert.notEqual(registerSnapshotHash({ metadata, entries: [e1] }), one);
    assert.notEqual(registerSnapshotHash({ metadata: { ...metadata, registerVersion: 2 }, entries: [e1, e2] }), one);
    assert.notEqual(registerSnapshotHash({ metadata, entries: [e1, entry({ ...e2, exactText: 'changed' })] }), one);
    assert.notEqual(one, mappingEntryHash(e1));
    assert.notEqual(one, HASH_A);
    assert.equal(verifyRegisterSnapshot({ metadata, entries: [e2, e1] }, one), true);
    assert.equal(verifyRegisterSnapshot({ metadata, entries: [e1, e2] }, '0'.repeat(64)), false);
  });

  test('two versions of one mapping are distinct entries; duplicates of one version are refused', () => {
    const v1 = entry();
    const v2 = entry({ mappingVersion: 2, exactText: 'revised fixture text' });
    assert.deepEqual(orderEntries([v2, v1]).map((x) => x.mappingVersion), [1, 2]);
    assert.notEqual(registerSnapshotHash({ metadata: {}, entries: [v1] }), registerSnapshotHash({ metadata: {}, entries: [v1, v2] }));
    expectCode(() => registerSnapshotHash({ metadata: {}, entries: [v1, { ...v1 }] }), C.RULE_DEFINITION_INVALID);
  });

  test('source-version immutability: a later register that adds or revises mappings leaves the earlier register hash and its entry hashes untouched', () => {
    const early = { metadata: { registerVersion: 1 }, entries: [entry()] };
    const earlyHash = registerSnapshotHash(early);
    const earlyEntryHash = mappingEntryHash(early.entries[0]);
    const later = { metadata: { registerVersion: 2 }, entries: [entry(), entry({ mappingVersion: 2, exactText: 'revised' }), entry({ mappingId: 'FIXTURE_MAPPING_9' })] };
    registerSnapshotHash(later);
    assert.equal(registerSnapshotHash(early), earlyHash, 'the earlier snapshot is still the same snapshot');
    assert.equal(mappingEntryHash(early.entries[0]), earlyEntryHash);
    // An old frozen rule version that cites the early hashes remains verifiable against the early register.
    assert.equal(verifyRegisterSnapshot(early, earlyHash), true);
  });
});

describe('mapping entries and the four independent status dimensions', () => {
  test('a valid entry has no problems', () => {
    assert.deepEqual(validateMappingEntry(entry()), []);
  });

  test('missing fields, wrong schema, bad hashes and bad versions are reported', () => {
    for (const field of ['schema', 'mappingId', 'mappingVersion', 'instrument', 'provision', 'exactText', 'sourceArtifactHashes', 'status']) {
      const broken = entry(); delete broken[field];
      assert.ok(validateMappingEntry(broken).some((problem) => problem.includes(field)), `${field} is required`);
    }
    assert.ok(validateMappingEntry(entry({ schema: 'OTHER' })).length > 0);
    assert.ok(validateMappingEntry(entry({ sourceArtifactHashes: [] })).length > 0);
    assert.ok(validateMappingEntry(entry({ sourceArtifactHashes: ['xyz'] })).length > 0);
    assert.ok(validateMappingEntry(entry({ sourceArtifactHashes: [HASH_A.toUpperCase()] })).length > 0, 'hex must be lowercase');
    assert.ok(validateMappingEntry(entry({ mappingVersion: 0 })).length > 0);
    expectCode(() => mappingEntryHash(entry({ sourceArtifactHashes: [] })), C.RULE_DEFINITION_INVALID);
  });

  test('evidence, lifecycle, interpretation and enablement are four separate dimensions, none collapsed into another', () => {
    assert.deepEqual(validateStatus(status()), []);
    // Every combination of the four dimensions is individually expressible.
    let combos = 0;
    for (const evidence of EVIDENCE_STATUSES) for (const lifecycle of LIFECYCLE_STATUSES) for (const interpretation of INTERPRETATION_STATUSES) for (const enablement of ENABLEMENT_STATUSES) {
      assert.deepEqual(validateStatus({ evidence, lifecycle, interpretation, enablement }), []);
      combos += 1;
    }
    assert.equal(combos, EVIDENCE_STATUSES.length * LIFECYCLE_STATUSES.length * INTERPRETATION_STATUSES.length * ENABLEMENT_STATUSES.length);
    // A source can be acquired and verified while its interpretation is open and it is not enabled.
    assert.deepEqual(validateStatus({ evidence: 'PRIMARY_TEXT_VERIFIED', lifecycle: 'FINAL', interpretation: 'OPEN', enablement: 'NOT_ENABLED' }), []);
    // Each dimension rejects values that belong to another.
    assert.equal(validateStatus(status({ evidence: 'FINAL' })).length, 1);
    assert.equal(validateStatus(status({ lifecycle: 'OPEN' })).length, 1);
    assert.equal(validateStatus(status({ interpretation: 'ENABLED' })).length, 1);
    assert.equal(validateStatus(status({ enablement: 'COMPLIANCE_APPROVED' })).length, 1);
    assert.equal(validateStatus({}).length, 4);
  });
});

describe('manifest integrity (groups A and B)', () => {
  const acquired = (id, sha256, byteCount, overrides = {}) => ({
    id, acquisitionStatus: 'OFFICIAL_EGAZETTE_ACQUIRED_HASHED', sha256, byteCount, sourceUrl: `https://example.invalid/${id}.pdf`, originalFilename: `${id}.pdf`, retrievedAt: '2026-10-13T00:00:00Z', ...overrides,
  });
  const manifest = () => ({ artifacts: [acquired('A', HASH_A, ARTIFACT_A.length), acquired('B', HASH_B, ARTIFACT_B.length), { id: 'C', acquisitionStatus: 'NOT_ACQUIRED_PRIMARY_ARTIFACT_PENDING' }] });
  const reader = (map) => (entry) => map[entry.id] ?? null;

  test('a well-formed manifest has no problems and every acquired artifact re-hashes to its recorded hash', () => {
    assert.deepEqual(validateManifest(manifest()), []);
    const results = verifyManifestBytes(manifest(), reader({ A: ARTIFACT_A, B: ARTIFACT_B }));
    assert.deepEqual(results.map((r) => [r.id, r.outcome]), [['A', 'VERIFIED'], ['B', 'VERIFIED'], ['C', 'NOT_APPLICABLE']]);
  });

  test('independent SHA-256: one changed byte, a truncated file or a missing file is caught', () => {
    const tampered = new Uint8Array(ARTIFACT_A); tampered[0] ^= 1;
    const truncated = ARTIFACT_B.slice(0, ARTIFACT_B.length - 1);
    const results = verifyManifestBytes(manifest(), reader({ A: tampered, B: truncated }));
    assert.equal(results[0].outcome, 'MISMATCH');
    assert.equal(results[0].actualSha256, sha256Hex(tampered));
    assert.equal(results[1].outcome, 'MISMATCH');
    assert.equal(verifyManifestBytes(manifest(), reader({ A: ARTIFACT_A }))[1].outcome, 'MISSING');
  });

  test('a hash can never be attached to bytes that were not acquired', () => {
    const problems = validateManifest({ artifacts: [{ id: 'X', acquisitionStatus: 'NOT_ACQUIRED_PRIMARY_ARTIFACT_PENDING', sha256: HASH_A }] });
    assert.ok(problems.some((p) => p.includes('must not carry a hash')));
    const problems2 = validateManifest({ artifacts: [{ id: 'X', acquisitionStatus: 'ALTERNATE_OFFICIAL_HOST_COPY_NOT_ACQUIRED', byteCount: 5 }] });
    assert.ok(problems2.some((p) => p.includes('must not carry a hash')));
  });

  test('an acquired artifact needs a real hash, byte count, URL, filename and retrieval time', () => {
    assert.ok(validateManifest({ artifacts: [acquired('A', 'abc', 10)] }).some((p) => p.includes('64-hex')));
    assert.ok(validateManifest({ artifacts: [acquired('A', HASH_A, 0)] }).some((p) => p.includes('byteCount')));
    assert.ok(validateManifest({ artifacts: [acquired('A', HASH_A, 5, { sourceUrl: undefined })] }).some((p) => p.includes('sourceUrl')));
  });

  test('the four acquisition states are distinct, and unknown states are rejected', () => {
    for (const acquisitionStatus of ['OFFICIAL_EGAZETTE_ACQUIRED_HASHED', 'ALTERNATE_OFFICIAL_HOST_COPY_NOT_ACQUIRED', 'NOT_ACQUIRED_PRIMARY_ARTIFACT_PENDING', 'ACQUIRED_CONTENT_UNVERIFIED']) {
      const base = acquisitionStatus === 'OFFICIAL_EGAZETTE_ACQUIRED_HASHED' || acquisitionStatus === 'ACQUIRED_CONTENT_UNVERIFIED'
        ? acquired('S', HASH_A, 5, { acquisitionStatus }) : { id: 'S', acquisitionStatus };
      assert.deepEqual(validateManifest({ artifacts: [base] }), [], acquisitionStatus);
    }
    assert.ok(validateManifest({ artifacts: [{ id: 'S', acquisitionStatus: 'DONE' }] }).some((p) => p.includes('unknown acquisitionStatus')));
  });

  test('a third-party copy is never usable as the source artifact hash', () => {
    const copy = acquired('T', HASH_A, 5, { acquisitionStatus: 'THIRD_PARTY_COPY_ACQUIRED_HASHED', usableAsSourceArtifactHash: true });
    assert.ok(validateManifest({ artifacts: [copy] }).some((p) => p.includes('third-party copy')));
    assert.deepEqual(validateManifest({ artifacts: [{ ...copy, usableAsSourceArtifactHash: false }] }), []);
  });

  test('"read in full" must be backed by every page being listed as reviewed', () => {
    const partial = acquired('P', HASH_A, 5, { review: { readInFull: true, totalPages: 259, pagesReviewed: [134, 135, 159] } });
    assert.ok(validateManifest({ artifacts: [partial] }).some((p) => p.includes('read in full')));
    const full = acquired('F', HASH_A, 5, { review: { readInFull: true, totalPages: 2, pagesReviewed: [1, 2] } });
    assert.deepEqual(validateManifest({ artifacts: [full] }), []);
    const honestPartial = acquired('Q', HASH_A, 5, { review: { readInFull: false, totalPages: 259, pagesReviewed: [134, 135, 159] } });
    assert.deepEqual(validateManifest({ artifacts: [honestPartial] }), []);
  });

  test('duplicate artifact ids and a non-array manifest are reported', () => {
    assert.ok(validateManifest({ artifacts: [acquired('A', HASH_A, 5), acquired('A', HASH_B, 5)] }).some((p) => p.includes('duplicate id')));
    assert.deepEqual(validateManifest({}), ['manifest.artifacts must be an array']);
  });
});

describe('register entries, statuses and manifests are strict', () => {
  test('a mapping entry rejects unrecognized fields and empty or non-text identity fields', () => {
    for (const over of [{ approved: true }, { gross: 1 }, { mappingId: null }, { mappingId: '' }, { instrument: null }, { provision: '' }, { exactText: '   ' }, { mappingId: {} }, { mappingId: 7 }]) {
      assert.ok(validateMappingEntry(entry(over)).length > 0, JSON.stringify(over));
      expectCode(() => mappingEntryHash(entry(over)), C.RULE_DEFINITION_INVALID);
    }
    assert.ok(validateMappingEntry(entry({ sourceArtifactHashes: new Array(1) })).length > 0);
    assert.deepEqual(validateMappingEntry(entry()), []);
  });

  test('validators reject caller-built prototypes, class instances and malformed entries without a raw crash', () => {
    class Entry { constructor() { Object.assign(this, entry()); } }
    assert.ok(validateMappingEntry(Object.create(entry())).length > 0);
    assert.ok(validateMappingEntry(new Entry()).length > 0);
    assert.ok(validateMappingEntry({ ...entry(), status: Object.create(status()) }).length > 0);
    assert.ok(validateStatus(Object.create(status())).length > 0);
    assert.ok(validateManifest({ artifacts: [Object.create({ id: 'A', acquisitionStatus: 'NOT_ACQUIRED_PRIMARY_ARTIFACT_PENDING' })] }).length > 0);
    assert.ok(validateManifest(Object.create({ artifacts: [] })).length > 0);
    for (const entries of [[null], [undefined], [7], ['x'], [{}], [{ mappingId: 'A' }], [{ mappingId: 'A', mappingVersion: 1.5 }], new Array(1)]) {
      expectCode(() => registerSnapshotHash({ metadata: { a: 1 }, entries }), C.RULE_DEFINITION_INVALID);
    }
    for (const metadata of [[], null, 'm', undefined]) expectCode(() => registerSnapshotHash({ metadata, entries: [] }), C.RULE_DEFINITION_INVALID);
    expectCode(() => mappingEntryHash(new Entry()), C.RULE_DEFINITION_INVALID);
  });

  test('a class instance or caller-built prototype is rejected AS NOT AN OBJECT (the exact reason), not by a field it happens to carry', () => {
    class Entry { constructor() { Object.assign(this, entry()); } }
    class Status { constructor() { Object.assign(this, status()); } }
    class Manifest { constructor() { this.artifacts = []; } }
    assert.deepEqual(validateMappingEntry(new Entry()), ['entry must be an object']);
    assert.deepEqual(validateMappingEntry(Object.create(entry())), ['entry must be an object']);
    assert.deepEqual(validateStatus(new Status()), ['status must be an object']);
    assert.deepEqual(validateManifest(new Manifest()), ['manifest.artifacts must be an array']);
    assert.deepEqual(validateManifest({ artifacts: [new Entry()] }).filter((p) => p.includes('unrecognized')), [], 'no accidental unknown-field reason');
    assert.ok(validateManifest({ artifacts: [new Entry()] }).some((p) => p.includes('id is required')));
  });

  test('a status rejects unrecognized fields and non-objects', () => {
    assert.ok(validateStatus(status({ enabledBy: 'someone' })).some((p) => p.includes('enabledBy')));
    for (const bad of [null, undefined, 'ENABLED', [], 7]) assert.deepEqual(validateStatus(bad), ['status must be an object']);
    assert.deepEqual(validateStatus(status()), []);
  });

  test('a manifest with a defect cannot be byte-verified, and empty provenance text is a defect', () => {
    const bad = { artifacts: [{ id: 1, acquisitionStatus: 'NOT_ACQUIRED_PRIMARY_ARTIFACT_PENDING' }] };
    expectCode(() => verifyManifestBytes(bad, () => null), C.RULE_DEFINITION_INVALID);
    const emptyText = { artifacts: [{ id: 'A', acquisitionStatus: 'OFFICIAL_EGAZETTE_ACQUIRED_HASHED', sha256: HASH_A, byteCount: 5, retrievedAt: '', sourceUrl: 'https://example.invalid/a', originalFilename: 'a.pdf' }] };
    assert.ok(validateManifest(emptyText).some((p) => p.includes('required')));
  });
});

describe('final hardening 3 — validateManifest rejects unknown keys and malformed structures', () => {
  const full = () => ({
    id: 'A1', instrument: 'FIXTURE_INSTRUMENT', subject: 'fixture subject', issuingAuthority: 'FIXTURE_AUTHORITY', gazetteDate: '2026-01-01', issueDate: null, publicationNotificationDate: null, eGazetteId: 7,
    acquisitionStatus: 'OFFICIAL_EGAZETTE_ACQUIRED_HASHED', sourceUrl: 'https://example.invalid/a.pdf', originalFilename: 'a.pdf', storedAs: 'official/a.pdf', retrievedAt: '2026-10-13T00:00:00Z',
    byteCount: ARTIFACT_A.length, sha256: HASH_A, contentVerification: { text: 'verified' }, review: { readInFull: false, totalPages: 3, pagesReviewed: [1], provisionsReviewed: 'p', notReviewed: 'q' },
    status: { evidence: 'ACQUIRED_HASHED' }, notes: 'n', retrievalNote: 'r', usableAsSourceArtifactHash: true,
  });
  const pending = () => ({ id: 'P1', instrument: 'FIXTURE', subject: 's', acquisitionStatus: 'NOT_ACQUIRED_PRIMARY_ARTIFACT_PENDING', status: { evidence: 'NOT_OBTAINED' }, reason: 'r', attempts: [{ n: 1 }], consequence: 'c' });
  const manifest = (over = {}) => ({ schema: 'FIXTURE_MANIFEST_V1', generatedAt: '2026-10-13T00:00:00Z', auditDate: '2026-10-13', note: 'n', artifacts: [full(), pending()], collections: { corpus: { count: 1 } }, ...over });
  const withArtifact = (over) => manifest({ artifacts: [{ ...full(), ...over }] });
  const mentions = (problems, text) => problems.some((p) => p.includes(text));

  test('a complete manifest in the real shape (descriptive fields, review, status, collections) is valid', () => {
    assert.deepEqual(validateManifest(manifest()), []);
    assert.deepEqual(validateManifest({ artifacts: [] }), []);
    assert.deepEqual(validateManifest({ artifacts: [Object.assign(Object.create(null), full())] }), [], 'null-prototype data is plain data');
    assert.deepEqual(validateManifest(manifest({ collections: [] })), []);
    assert.equal(verifyManifestBytes(manifest({ artifacts: [full()] }), () => ARTIFACT_A)[0].outcome, 'VERIFIED');
  });

  test('unknown keys are rejected at the manifest, artifact and review level (including an own __proto__ key)', () => {
    assert.ok(mentions(validateManifest(manifest({ bar: 2 })), 'unrecognized field "bar"'));
    assert.ok(mentions(validateManifest(withArtifact({ foo: 1 })), 'unrecognized field "foo"'));
    assert.ok(mentions(validateManifest(withArtifact({ approved: true })), 'unrecognized field "approved"'));
    assert.ok(mentions(validateManifest(withArtifact({ review: { ...full().review, zzz: 1 } })), 'review has the unrecognized field "zzz"'));
    assert.ok(mentions(validateManifest(JSON.parse('{"artifacts":[],"__proto__":{"x":1}}')), 'unrecognized field "__proto__"'));
    assert.ok(mentions(validateManifest({ artifacts: [JSON.parse('{"id":"A","acquisitionStatus":"NOT_ACQUIRED_PRIMARY_ARTIFACT_PENDING","__proto__":{"x":1}}')] }), 'unrecognized field "__proto__"'));
  });

  test('malformed structures are rejected: wrong types for every typed field, holes, non-objects, inherited data', () => {
    const bad = {
      'instrument number': { instrument: 5 }, 'subject object': { subject: {} }, 'issuingAuthority array': { issuingAuthority: [] }, 'storedAs number': { storedAs: 1 }, 'notes number': { notes: 5 },
      'retrievalNote bool': { retrievalNote: true }, 'reason number': { reason: 1 }, 'consequence array': { consequence: [] },
      'gazetteDate number': { gazetteDate: 20260101 }, 'issueDate object': { issueDate: {} }, 'publicationNotificationDate bool': { publicationNotificationDate: false },
      'eGazetteId float': { eGazetteId: 1.5 }, 'eGazetteId string': { eGazetteId: '7' }, 'usable string': { usableAsSourceArtifactHash: 'true' },
      'attempts object': { attempts: {} }, 'attempts sparse': { attempts: new Array(2) }, 'contentVerification array': { contentVerification: [] }, 'status string': { status: 'x' },
      'review string': { review: 'x' }, 'review array': { review: [] }, 'readInFull string': { review: { readInFull: 'true' } }, 'totalPages float': { review: { totalPages: 2.5 } },
      'pagesReviewed object': { review: { pagesReviewed: {} } }, 'pagesReviewed sparse': { review: { pagesReviewed: new Array(1) } }, 'provisionsReviewed number': { review: { provisionsReviewed: 5 } }, 'notReviewed array': { review: { notReviewed: [] } },
      'sha256 uppercase': { sha256: HASH_A.toUpperCase() }, 'sha256 short': { sha256: 'abc' }, 'byteCount zero': { byteCount: 0 }, 'byteCount float': { byteCount: 1.5 }, 'sourceUrl empty': { sourceUrl: '' }, 'originalFilename space': { originalFilename: ' ' },
    };
    for (const [name, over] of Object.entries(bad)) assert.ok(validateManifest(withArtifact(over)).length > 0, name);
    for (const m of [null, undefined, 'm', 5, [], {}, { artifacts: {} }, { artifacts: 'x' }, { artifacts: new Array(1) }, { artifacts: [null] }, { artifacts: ['x'] }, { artifacts: [[]] }, { artifacts: [{}] }, { artifacts: [{ id: 5 }] }, { artifacts: [{ id: '' }] }]) {
      assert.ok(validateManifest(m).length > 0, JSON.stringify(m));
    }
    for (const over of [{ schema: 5 }, { generatedAt: {} }, { auditDate: [] }, { note: 1 }, { collections: 'x' }, { collections: null }]) assert.ok(validateManifest(manifest(over)).length > 0, JSON.stringify(over));
    class Art { constructor() { Object.assign(this, full()); } }
    assert.ok(validateManifest({ artifacts: [new Art()] }).length > 0, 'a class instance is not plain data');
    assert.ok(validateManifest({ artifacts: [Object.create(full())] }).length > 0, 'an inherited artifact is not plain data');
    assert.ok(validateManifest(Object.create({ artifacts: [] })).length > 0, 'an inherited manifest is not plain data');
    let thrown = null;
    try { validateManifest({ artifacts: [{ get id() { return 'A'; } }] }); } catch (e) { thrown = e; }
    assert.ok(thrown instanceof StatutoryWageError && thrown.code === C.INPUT_MALFORMED, 'an accessor is a named error');
  });

  test('the earlier rules still hold: duplicate ids, unknown status, a hash on a non-acquired artifact, a third-party copy as a source hash, read in full without every page', () => {
    assert.ok(mentions(validateManifest(manifest({ artifacts: [full(), full()] })), 'duplicate id'));
    assert.ok(mentions(validateManifest(withArtifact({ acquisitionStatus: 'DONE' })), 'unknown acquisitionStatus'));
    assert.ok(mentions(validateManifest(manifest({ artifacts: [{ ...pending(), sha256: HASH_A }] })), 'must not carry a hash'));
    assert.ok(mentions(validateManifest(withArtifact({ acquisitionStatus: 'THIRD_PARTY_COPY_ACQUIRED_HASHED', usableAsSourceArtifactHash: true })), 'third-party copy'));
    assert.ok(mentions(validateManifest(withArtifact({ review: { readInFull: true, totalPages: 3, pagesReviewed: [1] } })), 'read in full'));
    assert.deepEqual(validateManifest(withArtifact({ review: { readInFull: true, totalPages: 2, pagesReviewed: [1, 2] } })), []);
  });

  test('verifyManifestBytes refuses a manifest with an unknown key or a malformed structure: nothing is hashed from a defective manifest', () => {
    expectCode(() => verifyManifestBytes(withArtifact({ foo: 1 }), () => ARTIFACT_A), C.RULE_DEFINITION_INVALID);
    expectCode(() => verifyManifestBytes(manifest({ bar: 1 }), () => ARTIFACT_A), C.RULE_DEFINITION_INVALID);
    expectCode(() => verifyManifestBytes({ artifacts: [null] }, () => ARTIFACT_A), C.RULE_DEFINITION_INVALID);
    expectCode(() => verifyManifestBytes(null, () => ARTIFACT_A), C.RULE_DEFINITION_INVALID);
  });
});

describe('final hardening 5 — the provenance validators read own data only', () => {
  const samples = () => ({
    entry: entry(),
    register: { metadata: { registerVersion: 1, label: 'fixture' }, entries: [entry(), entry({ mappingId: 'FIXTURE_MAPPING_2', sourceArtifactHashes: [HASH_B] })] },
    manifest: { schema: 'M', generatedAt: 'g', auditDate: 'a', note: 'n', collections: { c: 1 }, artifacts: [{ id: 'A', acquisitionStatus: 'OFFICIAL_EGAZETTE_ACQUIRED_HASHED', sha256: HASH_A, byteCount: 5, sourceUrl: 'u', originalFilename: 'f', retrievedAt: 'r', review: { readInFull: false, totalPages: 1, pagesReviewed: [], provisionsReviewed: 'p', notReviewed: 'n' }, status: { evidence: 'X' } }, { id: 'B', acquisitionStatus: 'NOT_ACQUIRED_PRIMARY_ARTIFACT_PENDING', reason: 'r', attempts: [] }] },
  });

  test('differential: for every key at every depth, deleting it and polluting Object.prototype with its original value changes nothing', () => {
    const s = samples();
    const runs = [
      ['validateMappingEntry', s.entry, (copy) => validateMappingEntry(copy)],
      ['mappingEntryHash', s.entry, (copy) => mappingEntryHash(copy)],
      ['validateStatus', s.entry.status, (copy) => validateStatus(copy)],
      ['registerSnapshotHash', s.register, (copy) => registerSnapshotHash(copy)],
      ['validateManifest', s.manifest, (copy) => validateManifest(copy)],
    ];
    let total = 0;
    for (const [name, sample, call] of runs) {
      const { findings, examined } = pollutionDifferential(sample, call);
      assert.deepEqual(findings, [], name);
      total += examined.length;
    }
    assert.ok(total > 60, `the differential examined ${total} key paths`);
  });

  test('named cases: a missing own field stays missing even if Object.prototype supplies it', () => {
    for (const [key, value] of [['mappingId', 'FIXTURE_MAPPING_1'], ['status', status()], ['exactText', 'fixture text'], ['sourceArtifactHashes', [HASH_A]], ['evidence', 'ACQUIRED_HASHED'], ['artifacts', []]]) {
      Object.prototype[key] = value; // eslint-disable-line no-extend-native
      try {
        const broken = entry(); delete broken[key]; delete broken.status?.[key];
        if (Object.hasOwn({ mappingId: 1, status: 1, exactText: 1, sourceArtifactHashes: 1 }, key)) assert.ok(validateMappingEntry(broken).length > 0, key);
        if (key === 'evidence') assert.ok(validateStatus((({ evidence, ...rest }) => rest)(status())).length > 0);
        if (key === 'artifacts') assert.ok(validateManifest({}).length > 0);
      } finally {
        delete Object.prototype[key];
      }
    }
  });
});

describe('last review round — symbol-keyed arrays in the validators', () => {
  const withSymbol = (array) => { array[Symbol('s')] = 1; return array; };
  test('a symbol-keyed list is not a list: the entry, register and manifest validators reject it, and polluted prototypes cannot fill it', () => {
    assert.ok(validateMappingEntry(entry({ sourceArtifactHashes: withSymbol([HASH_A]) })).length > 0);
    expectCode(() => registerSnapshotHash({ metadata: { a: 1 }, entries: withSymbol([entry()]) }), C.RULE_DEFINITION_INVALID);
    expectCode(() => orderEntries(withSymbol([entry()])), C.RULE_DEFINITION_INVALID);
    const artifact = { id: 'A', acquisitionStatus: 'OFFICIAL_EGAZETTE_ACQUIRED_HASHED', sha256: HASH_A, byteCount: 5, sourceUrl: 'u', originalFilename: 'f', retrievedAt: 'r' };
    assert.ok(validateManifest({ artifacts: withSymbol([artifact]) }).length > 0);
    // the reviewer's probe: polluted sha256/byteCount must not satisfy a symbol-keyed artifact list
    const bare = { id: 'A', acquisitionStatus: 'OFFICIAL_EGAZETTE_ACQUIRED_HASHED', sourceUrl: 'u', originalFilename: 'f', retrievedAt: 'r' };
    Object.prototype.sha256 = HASH_A; Object.prototype.byteCount = 5; // eslint-disable-line no-extend-native
    try {
      assert.ok(validateManifest({ artifacts: withSymbol([bare]) }).length > 0);
      assert.ok(validateManifest({ artifacts: [bare] }).some((p) => p.includes('sha256')), 'the control: the missing own hash is a problem');
    } finally {
      delete Object.prototype.sha256; delete Object.prototype.byteCount;
    }
  });
});
