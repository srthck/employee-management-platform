import mongoose from 'mongoose';
import { HEAD_COLLECTION } from '../services/auditChainSpec.js';

/**
 * AuditChainHead — the single authoritative head of the global audit chain.
 *
 * One document (_id 'global'). Every audit append, inside the SAME transaction that inserts the record, advances it
 * by a conditional update that matches only the exact (sequence, hash, version) the appender read:
 *
 *   {sequence: n, hash: h, version: v}  ->  {sequence: n+1, hash: h', version: v+1}
 *
 * so two transactions can never both advance the same head into different successors, whatever the state of the
 * unique indexes on the audit collection. `version` is a monotonic counter; the record written by the transition
 * to version v carries headVersion = v.
 *
 * This model exists to own the collection name and to refuse accidental use of the Mongoose update API. The head
 * is only ever written through auditService (initial creation: auditChainHeadService), using the raw collection.
 */
const baselineSchema = new mongoose.Schema({
  sequence: { type: Number, required: true },
  hash: { type: String, required: true },
  source: { type: String, required: true }, // 'initialized-from-verified-history' | 'auto-bootstrap-empty'
  at: { type: Date, required: true },
  operator: { type: String, default: null },
  planDigest: { type: String, default: null },
  commit: { type: String, default: null },
}, { _id: false });

const headSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  scope: { type: String, required: true, default: 'global' },
  formatVersion: { type: Number, required: true, default: 1 },
  sequence: { type: Number, required: true, min: 0 },
  hash: { type: String, required: true },
  version: { type: Number, required: true, min: 1 },
  baseline: { type: baselineSchema, required: true },
}, { collection: HEAD_COLLECTION, timestamps: false });

const refuse = (next) => next(Object.assign(new Error('The audit chain head is written only by the audit service through the transactional append protocol.'), { statusCode: 403 }));
headSchema.pre(['updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndReplace', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete'], { document: false, query: true }, function rejectQueryMutation(next) { refuse(next); });
headSchema.pre('save', function rejectSave(next) { refuse(next); });

export default mongoose.model('AuditChainHead', headSchema);
