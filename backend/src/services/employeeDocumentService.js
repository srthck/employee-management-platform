import mongoose from 'mongoose';
import EmployeeDocument from '../models/EmployeeDocument.js';
import auditService from './auditService.js';
import { runInTransaction } from '../utils/transaction.js';
import { DOCUMENT_TYPES } from '../utils/workforce.js';
import { httpError, dateOnly, isValidDate, loadCompanyEmployee } from './employeeScope.js';

/**
 * employeeDocumentService — structured document records and verification.
 *
 * Verification is a separate duty: the person who submitted a document
 * cannot verify or reject it. Decisions are final and audited; a corrected
 * document is submitted as a new record.
 */

const documentView = (doc, now = new Date()) => ({
  id: String(doc._id),
  documentType: doc.documentType,
  title: doc.title,
  issuedOn: doc.issuedOn,
  expiresOn: doc.expiresOn,
  isExpired: Boolean(doc.expiresOn && new Date(doc.expiresOn) < now),
  fileSha256: doc.fileSha256,
  notes: doc.notes,
  status: doc.status,
  submittedByEmail: doc.submittedByEmail,
  submittedAt: doc.createdAt,
  decision: doc.decision
    ? { byEmail: doc.decision.byEmail, at: doc.decision.at, note: doc.decision.note }
    : null,
});

const employeeDocumentService = {
  async list(employeeId, companyId) {
    const employee = await loadCompanyEmployee(employeeId, companyId, { lean: true });
    const documents = await EmployeeDocument.find({ employeeId: employee._id, companyId }).sort({ createdAt: -1 }).lean();
    return { documents: documents.map((doc) => documentView(doc)) };
  },

  async submit(employeeId, companyId, payload, actor) {
    const errors = [];
    if (!DOCUMENT_TYPES.includes(payload.documentType)) {
      errors.push({ field: 'documentType', message: `documentType must be one of: ${DOCUMENT_TYPES.join(', ')}.` });
    }
    const title = typeof payload.title === 'string' ? payload.title.trim() : '';
    if (title.length < 2 || title.length > 120) errors.push({ field: 'title', message: 'Title must be 2 to 120 characters.' });
    for (const field of ['issuedOn', 'expiresOn']) {
      if (payload[field] != null && payload[field] !== '' && !isValidDate(payload[field])) {
        errors.push({ field, message: `${field} must be a valid date.` });
      }
    }
    if (payload.fileSha256 != null && payload.fileSha256 !== '' && !/^[a-f0-9]{64}$/i.test(payload.fileSha256)) {
      errors.push({ field: 'fileSha256', message: 'fileSha256 must be a SHA-256 hex digest (64 characters).' });
    }
    const notes = typeof payload.notes === 'string' && payload.notes.trim() ? payload.notes.trim() : null;
    if (notes && notes.length > 300) errors.push({ field: 'notes', message: 'Notes cannot exceed 300 characters.' });
    if (errors.length > 0) throw httpError(422, 'VALIDATION_FAILED', 'Validation failed', { errors });

    const document = await runInTransaction(async (session) => {
      const employee = await loadCompanyEmployee(employeeId, companyId, { session });
      const [created] = await EmployeeDocument.create([{
        employeeId: employee._id,
        companyId,
        documentType: payload.documentType,
        title,
        issuedOn: payload.issuedOn || null,
        expiresOn: payload.expiresOn || null,
        fileSha256: payload.fileSha256 ? payload.fileSha256.toLowerCase() : null,
        notes,
        submittedBy: actor.id,
        submittedByEmail: actor.email || null,
      }], { session });

      await auditService.log({
        action: 'EMPLOYEE_DOCUMENT_SUBMITTED',
        actorId: actor.id,
        actorEmail: actor.email,
        actorRole: actor.role,
        entityType: 'EMPLOYEE',
        entityId: employee._id,
        companyId,
        newStatus: 'SUBMITTED',
        meta: { documentId: String(created._id), documentType: created.documentType, expiresOn: dateOnly(created.expiresOn) },
      }, session);
      return created;
    }, { label: 'document.submit' });

    return { document: documentView(document) };
  },

  async decide(employeeId, companyId, documentId, { decision, note }, actor) {
    if (!['VERIFIED', 'REJECTED'].includes(decision)) {
      throw httpError(422, 'VALIDATION_FAILED', 'decision must be VERIFIED or REJECTED.');
    }
    const trimmedNote = typeof note === 'string' && note.trim() ? note.trim().slice(0, 300) : null;
    if (decision === 'REJECTED' && (!trimmedNote || trimmedNote.length < 5)) {
      throw httpError(422, 'REJECTION_REASON_REQUIRED', 'Say why the document is rejected (at least 5 characters).');
    }
    if (!mongoose.isValidObjectId(documentId)) throw httpError(400, 'BAD_REQUEST', 'Invalid document ID.');

    const document = await runInTransaction(async (session) => {
      const employee = await loadCompanyEmployee(employeeId, companyId, { session });
      const doc = await EmployeeDocument.findOne({ _id: documentId, employeeId: employee._id, companyId }).session(session);
      if (!doc) throw httpError(404, 'NOT_FOUND', 'Document not found.');
      if (doc.status !== 'SUBMITTED') {
        throw httpError(409, 'DOCUMENT_DECISION_FINAL', 'This document was already decided. Submit a new record for a corrected document.');
      }
      if (String(doc.submittedBy) === String(actor.id)) {
        throw httpError(403, 'SEGREGATION_OF_DUTIES', 'The person who submitted a document cannot verify or reject it.');
      }

      doc.status = decision;
      doc.decision = { by: actor.id, byEmail: actor.email || null, at: new Date(), note: trimmedNote };
      await doc.save({ session });

      await auditService.log({
        action: decision === 'VERIFIED' ? 'EMPLOYEE_DOCUMENT_VERIFIED' : 'EMPLOYEE_DOCUMENT_REJECTED',
        actorId: actor.id,
        actorEmail: actor.email,
        actorRole: actor.role,
        entityType: 'EMPLOYEE',
        entityId: employee._id,
        companyId,
        previousStatus: 'SUBMITTED',
        newStatus: decision,
        meta: { documentId: String(doc._id), documentType: doc.documentType, note: trimmedNote },
      }, session);
      return doc;
    }, { label: 'document.decide' });

    return { document: documentView(document) };
  },
};

export default employeeDocumentService;
