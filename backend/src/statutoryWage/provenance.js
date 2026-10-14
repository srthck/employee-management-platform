/**
 * Three distinct hashes for legal-source provenance. They are never interchangeable.
 *
 *   sourceArtifactHash   SHA-256 of the exact original source bytes (the downloaded PDF).
 *                        Never of OCR text, a normalized copy, or a re-saved file.
 *   mappingEntryHash     SHA-256 of the canonical mapping record, which cites source artifact
 *                        hashes by value.
 *   registerSnapshotHash SHA-256 of the complete, deterministically ordered set of mapping entry
 *                        hashes together with the register metadata.
 *
 * Pure functions. No file or network access: callers hand in bytes and records.
 */

import { canonicalJson, hashCanonical, isSha256Hex, sha256Hex } from './canonical.js';
import { fail, STATUTORY_WAGE_ERROR_CODES as C } from './errors.js';
import { guardPublic, toOwnData } from './ownData.js';

export const MAPPING_ENTRY_SCHEMA = 'PAYGUARD_LEGAL_MAPPING_ENTRY_V1';
export const REGISTER_SNAPSHOT_SCHEMA = 'PAYGUARD_LEGAL_REGISTER_SNAPSHOT_V1';

const isPlain = (value) => !!value && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
/** An array. (A sparse array, or one with extra or symbol-keyed properties, never gets here: toOwnData replaces it with a NotPlainData marker.) */
const isDense = (value) => Array.isArray(value);

export const EVIDENCE_STATUSES = Object.freeze(['NOT_OBTAINED', 'ACQUIRED_HASHED', 'PRIMARY_TEXT_PARTIAL', 'PRIMARY_TEXT_VERIFIED', 'SIGNATURE_UNVERIFIED', 'SIGNATURE_VERIFIED']);
export const LIFECYCLE_STATUSES = Object.freeze(['DRAFT', 'FINAL', 'SAVED_TRANSITIONAL', 'SUPERSEDED', 'EXPIRED', 'UNKNOWN']);
export const INTERPRETATION_STATUSES = Object.freeze(['OPEN', 'INTERPRETATION_PROPOSED', 'COMPLIANCE_APPROVED', 'LEGAL_REVIEW_REQUIRED', 'CONFLICTED']);
export const ENABLEMENT_STATUSES = Object.freeze(['NOT_ENABLED', 'BLOCKED', 'ENABLED']);

/** SHA-256 of the exact source bytes. A string is rejected: bytes only. */
export function sourceArtifactHash(bytes) {
  if (!(bytes instanceof Uint8Array)) fail(C.RULE_DEFINITION_INVALID, 'sourceArtifactHash needs the exact source bytes');
  return sha256Hex(bytes);
}

const REQUIRED_ENTRY_FIELDS = ['schema', 'mappingId', 'mappingVersion', 'instrument', 'provision', 'exactText', 'sourceArtifactHashes', 'status'];

/** Validate the four independent status dimensions; they are never collapsed into one. */
export const validateStatus = guardPublic('validateStatus', validateStatusCore);

function validateStatusCore(candidate) {
  const status = toOwnData(candidate);
  const problems = [];
  if (!isPlain(status)) return ['status must be an object'];
  for (const key of Object.keys(status)) if (!['evidence', 'lifecycle', 'interpretation', 'enablement'].includes(key)) problems.push(`unrecognized status field "${key}"`);
  const check = (field, allowed) => { if (!allowed.includes(status?.[field])) problems.push(`${field} must be one of ${allowed.join('|')}`); };
  check('evidence', EVIDENCE_STATUSES);
  check('lifecycle', LIFECYCLE_STATUSES);
  check('interpretation', INTERPRETATION_STATUSES);
  check('enablement', ENABLEMENT_STATUSES);
  return problems;
}

/** Validate a mapping entry's shape. Returns the problems found (empty when valid). */
export const validateMappingEntry = guardPublic('validateMappingEntry', validateMappingEntryCore);

function validateMappingEntryCore(candidate) {
  const entry = toOwnData(candidate);
  const problems = [];
  if (!isPlain(entry)) return ['entry must be an object'];
  for (const field of REQUIRED_ENTRY_FIELDS) if (entry[field] === undefined) problems.push(`missing ${field}`);
  for (const key of Object.keys(entry)) if (!REQUIRED_ENTRY_FIELDS.includes(key)) problems.push(`unrecognized field "${key}"`);
  for (const field of ['mappingId', 'instrument', 'provision', 'exactText']) {
    if (entry[field] !== undefined && (typeof entry[field] !== 'string' || entry[field].trim() === '')) problems.push(`${field} must be a non-empty string`);
  }
  if (entry.schema !== undefined && entry.schema !== MAPPING_ENTRY_SCHEMA) problems.push(`schema must be ${MAPPING_ENTRY_SCHEMA}`);
  if (entry.mappingVersion !== undefined && !(Number.isSafeInteger(entry.mappingVersion) && entry.mappingVersion >= 1)) problems.push('mappingVersion must be a positive integer');
  if (entry.sourceArtifactHashes !== undefined) {
    if (!Array.isArray(entry.sourceArtifactHashes) || Object.keys(entry.sourceArtifactHashes).length !== entry.sourceArtifactHashes.length || entry.sourceArtifactHashes.length === 0) problems.push('sourceArtifactHashes must be a non-empty array');
    else if (!entry.sourceArtifactHashes.every(isSha256Hex)) problems.push('every sourceArtifactHash must be 64 lowercase hex characters');
  }
  if (entry.status !== undefined) problems.push(...validateStatus(entry.status));
  return problems;
}

/** Hash of the canonical mapping record (which cites source artifact hashes by value). */
export const mappingEntryHash = guardPublic('mappingEntryHash', mappingEntryHashCore);

function mappingEntryHashCore(candidate) {
  const entry = toOwnData(candidate);
  const problems = validateMappingEntry(entry);
  if (problems.length > 0) fail(C.RULE_DEFINITION_INVALID, `invalid mapping entry: ${problems.join('; ')}`, { problems });
  return hashCanonical(entry);
}

/** Deterministic order of a register's entries: by mappingId, then mappingVersion. */
export const orderEntries = guardPublic('orderEntries', (candidate) => {
  const entries = toOwnData(candidate);
  if (!isDense(entries) || entries.some((entry) => !isPlain(entry) || typeof entry.mappingId !== 'string' || !Number.isSafeInteger(entry.mappingVersion))) fail(C.RULE_DEFINITION_INVALID, 'orderEntries needs an array of entries with a text mappingId and an integer mappingVersion');
  return [...entries].sort((a, b) => (a.mappingId < b.mappingId ? -1 : a.mappingId > b.mappingId ? 1 : a.mappingVersion - b.mappingVersion));
});

/** Hash of the complete ordered register: every entry's hash, in order, plus the metadata. */
export const registerSnapshotHash = guardPublic('registerSnapshotHash', registerSnapshotHashCore);

function registerSnapshotHashCore(register) {
  const own = toOwnData(register);
  if (!isPlain(own)) fail(C.RULE_DEFINITION_INVALID, 'a register snapshot is { metadata, entries }');
  const { metadata, entries } = own;
  if (!isPlain(metadata)) fail(C.RULE_DEFINITION_INVALID, 'a register snapshot needs metadata');
  if (!isDense(entries)) fail(C.RULE_DEFINITION_INVALID, 'a register snapshot needs entries');
  const ordered = orderEntries(entries); // validates every entry (a text mappingId and an integer mappingVersion) before ordering
  const seen = new Set();
  for (const entry of ordered) {
    const key = `${entry.mappingId}@${entry.mappingVersion}`;
    if (seen.has(key)) fail(C.RULE_DEFINITION_INVALID, `duplicate mapping ${key} in one register snapshot`);
    seen.add(key);
  }
  return hashCanonical({
    schema: REGISTER_SNAPSHOT_SCHEMA,
    metadata,
    entries: ordered.map((entry) => ({ mappingId: entry.mappingId, mappingVersion: entry.mappingVersion, mappingEntryHash: mappingEntryHash(entry) })),
  });
}

/**
 * True when the stored hash equals the recomputed one. Pure; throws on malformed input. This checks SELF-CONSISTENCY only:
 * a register that matches its own hash is not thereby trusted, approved or legally correct (see productionAuthority.js).
 */
export const verifyRegisterSnapshot = guardPublic('verifyRegisterSnapshot', (register, expectedHash) => registerSnapshotHash(register) === expectedHash);


export const ACQUISITION_STATUSES = Object.freeze([
  'OFFICIAL_EGAZETTE_ACQUIRED_HASHED',
  'OFFICIAL_MINISTRY_HOST_ACQUIRED_HASHED',
  'ALTERNATE_OFFICIAL_HOST_COPY_ACQUIRED_HASHED',
  'ALTERNATE_OFFICIAL_HOST_COPY_NOT_ACQUIRED',
  'THIRD_PARTY_COPY_ACQUIRED_HASHED',
  'ACQUIRED_CONTENT_UNVERIFIED',
  'NOT_ACQUIRED_PRIMARY_ARTIFACT_PENDING',
]);
const HASHED_STATUSES = new Set(['OFFICIAL_EGAZETTE_ACQUIRED_HASHED', 'OFFICIAL_MINISTRY_HOST_ACQUIRED_HASHED', 'ALTERNATE_OFFICIAL_HOST_COPY_ACQUIRED_HASHED', 'THIRD_PARTY_COPY_ACQUIRED_HASHED', 'ACQUIRED_CONTENT_UNVERIFIED']);

/**
 * Structural validation of a source manifest: an artifact that was acquired carries a real 64-hex
 * SHA-256 and a positive byte count; one that was not acquired carries NO hash (a hash can never be
 * attached to bytes that were not acquired); a third-party copy is never counted as the official
 * source. Returns the problems found (empty when valid).
 */
const MANIFEST_KEYS = new Set(['schema', 'generatedAt', 'auditDate', 'note', 'artifacts', 'collections']);
const ARTIFACT_KEYS = new Set(['id', 'instrument', 'subject', 'issuingAuthority', 'gazetteDate', 'issueDate', 'publicationNotificationDate', 'eGazetteId',
  'acquisitionStatus', 'sourceUrl', 'originalFilename', 'storedAs', 'retrievedAt', 'byteCount', 'sha256', 'contentVerification', 'review', 'status', 'notes',
  'retrievalNote', 'usableAsSourceArtifactHash', 'reason', 'attempts', 'consequence']);
const REVIEW_KEYS = new Set(['readInFull', 'totalPages', 'pagesReviewed', 'provisionsReviewed', 'notReviewed']);
const isText = (value) => typeof value === 'string';
const isTextOrNull = (value) => value === null || typeof value === 'string';

export const validateManifest = guardPublic('validateManifest', validateManifestCore);

function validateManifestCore(candidate) {
  const manifest = toOwnData(candidate);
  const problems = [];
  if (!isPlain(manifest) || !isDense(manifest.artifacts)) return ['manifest.artifacts must be an array'];
  for (const key of Object.keys(manifest)) if (!MANIFEST_KEYS.has(key)) problems.push(`manifest: unrecognized field "${key}"`);
  for (const field of ['schema', 'generatedAt', 'auditDate', 'note']) if (manifest[field] !== undefined && !isText(manifest[field])) problems.push(`manifest.${field} must be text`);
  if (manifest.collections !== undefined && !(isPlain(manifest.collections) || isDense(manifest.collections))) problems.push('manifest.collections must be an object or an array');
  const ids = new Set();
  for (const entry of manifest.artifacts) {
    const where = `artifact ${isPlain(entry) && typeof entry.id === 'string' ? entry.id : '(no id)'}`;
    if (!isPlain(entry) || typeof entry.id !== 'string' || entry.id === '') { problems.push(`${where}: id is required`); continue; }
    if (ids.has(entry.id)) problems.push(`${where}: duplicate id`);
    ids.add(entry.id);
    for (const key of Object.keys(entry)) if (!ARTIFACT_KEYS.has(key)) problems.push(`${where}: unrecognized field "${key}"`);
    for (const field of ['instrument', 'subject', 'issuingAuthority', 'storedAs', 'notes', 'retrievalNote', 'reason', 'consequence']) {
      if (entry[field] !== undefined && !isText(entry[field])) problems.push(`${where}: ${field} must be text`);
    }
    for (const field of ['gazetteDate', 'issueDate', 'publicationNotificationDate']) {
      if (entry[field] !== undefined && !isTextOrNull(entry[field])) problems.push(`${where}: ${field} must be text or null`);
    }
    if (entry.eGazetteId !== undefined && entry.eGazetteId !== null && !Number.isSafeInteger(entry.eGazetteId)) problems.push(`${where}: eGazetteId must be an integer or null`);
    if (entry.usableAsSourceArtifactHash !== undefined && typeof entry.usableAsSourceArtifactHash !== 'boolean') problems.push(`${where}: usableAsSourceArtifactHash must be a boolean`);
    if (entry.attempts !== undefined && entry.attempts !== null && !isDense(entry.attempts)) problems.push(`${where}: attempts must be an array or null`);
    for (const field of ['contentVerification', 'status']) {
      if (entry[field] !== undefined && !isPlain(entry[field])) problems.push(`${where}: ${field} must be an object`);
    }
    if (entry.review !== undefined) {
      if (!isPlain(entry.review)) problems.push(`${where}: review must be an object`);
      else {
        for (const key of Object.keys(entry.review)) if (!REVIEW_KEYS.has(key)) problems.push(`${where}: review has the unrecognized field "${key}"`);
        if (entry.review.readInFull !== undefined && typeof entry.review.readInFull !== 'boolean') problems.push(`${where}: review.readInFull must be a boolean`);
        if (entry.review.totalPages !== undefined && entry.review.totalPages !== null && !Number.isSafeInteger(entry.review.totalPages)) problems.push(`${where}: review.totalPages must be an integer or null`);
        if (entry.review.pagesReviewed !== undefined && !isDense(entry.review.pagesReviewed)) problems.push(`${where}: review.pagesReviewed must be an array`);
        for (const field of ['provisionsReviewed', 'notReviewed']) if (entry.review[field] !== undefined && !isText(entry.review[field])) problems.push(`${where}: review.${field} must be text`);
      }
    }
    if (!ACQUISITION_STATUSES.includes(entry.acquisitionStatus)) { problems.push(`${where}: unknown acquisitionStatus ${entry.acquisitionStatus}`); continue; }
    if (HASHED_STATUSES.has(entry.acquisitionStatus)) {
      if (!isSha256Hex(entry.sha256)) problems.push(`${where}: an acquired artifact needs a 64-hex sha256`);
      if (!(Number.isSafeInteger(entry.byteCount) && entry.byteCount > 0)) problems.push(`${where}: an acquired artifact needs a positive byteCount`);
      if (![entry.retrievedAt, entry.sourceUrl, entry.originalFilename].every((text) => typeof text === 'string' && text.trim() !== '')) problems.push(`${where}: sourceUrl, originalFilename and retrievedAt are required`);
    } else if (entry.sha256 != null || entry.byteCount != null) {
      problems.push(`${where}: ${entry.acquisitionStatus} must not carry a hash or byte count`);
    }
    if (entry.acquisitionStatus === 'THIRD_PARTY_COPY_ACQUIRED_HASHED' && entry.usableAsSourceArtifactHash === true) problems.push(`${where}: a third-party copy cannot be a source artifact hash`);
    if (isPlain(entry.review) && entry.review.readInFull === true && !(isDense(entry.review.pagesReviewed) && entry.review.pagesReviewed.length > 0 && entry.review.pagesReviewed.length === entry.review.totalPages)) {
      problems.push(`${where}: "read in full" must be backed by every page being listed as reviewed`);
    }
  }
  return problems;
}

/**
 * Re-hash every acquired artifact from its real bytes. `readBytes(entry)` returns the exact bytes
 * (Uint8Array) or null when the file is missing. Pure apart from that callback.
 */
export const verifyManifestBytes = guardPublic('verifyManifestBytes', verifyManifestBytesCore);

function verifyManifestBytesCore(candidate, readBytes) {
  if (typeof readBytes !== 'function') fail(C.RULE_DEFINITION_INVALID, 'verifyManifestBytes needs a readBytes(entry) function');
  const manifest = toOwnData(candidate);
  const problems = validateManifest(manifest);
  if (problems.length > 0) fail(C.RULE_DEFINITION_INVALID, `invalid manifest: ${problems.join('; ')}`, { problems });
  const results = [];
  for (const entry of manifest.artifacts) {
    if (!HASHED_STATUSES.has(entry.acquisitionStatus)) { results.push({ id: entry.id, outcome: 'NOT_APPLICABLE' }); continue; }
    const bytes = readBytes(entry);
    if (!(bytes instanceof Uint8Array)) { results.push({ id: entry.id, outcome: 'MISSING' }); continue; }
    const actual = sha256Hex(bytes);
    results.push({
      id: entry.id,
      outcome: actual === entry.sha256 && bytes.length === entry.byteCount ? 'VERIFIED' : 'MISMATCH',
      expectedSha256: entry.sha256, actualSha256: actual, expectedBytes: entry.byteCount, actualBytes: bytes.length,
    });
  }
  return results;
}

export { canonicalJson };
