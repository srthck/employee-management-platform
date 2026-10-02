/**
 * Workforce vocabulary shared by models, validators and services.
 */

export const DEPARTMENTS = Object.freeze([
  'Engineering',
  'Marketing',
  'Sales',
  'Human Resources',
  'Finance',
  'Operations',
  'Design',
  'Legal',
  'Customer Support',
  'Other',
]);

/**
 * Kinds of employment change. Every change appends a new effective-dated
 * version; none edits an earlier one.
 */
export const EMPLOYMENT_CHANGE_TYPES = Object.freeze([
  'JOINING',
  'TRANSFER',
  'PROMOTION',
  'REDESIGNATION',
  'MANAGER_CHANGE',
  'LOCATION_CHANGE',
  'EMPLOYMENT_TYPE_CHANGE',
  'CONFIRMATION',
  'EXIT',
]);

export const EMPLOYMENT_TYPES = Object.freeze(['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN']);
export const PROBATION_STATUSES = Object.freeze(['ON_PROBATION', 'CONFIRMED', 'NOT_APPLICABLE']);
export const LIFECYCLE_STATUSES = Object.freeze(['ACTIVE', 'EXITED']);
export const EXIT_REASONS = Object.freeze(['RESIGNATION', 'TERMINATION', 'RETIREMENT', 'CONTRACT_END', 'DEATH', 'OTHER']);

export const BANK_ACCOUNT_TYPES = Object.freeze(['SAVINGS', 'CURRENT', 'SALARY']);

export const DOCUMENT_TYPES = Object.freeze([
  'PAN_CARD',
  'PASSPORT',
  'OFFER_LETTER',
  'APPOINTMENT_LETTER',
  'RELIEVING_LETTER',
  'EDUCATION_CERTIFICATE',
  'ADDRESS_PROOF',
  'BANK_PROOF',
  'PF_NOMINATION_FORM_2',
  'PF_DECLARATION_FORM_11',
  'OTHER',
]);
export const DOCUMENT_STATUSES = Object.freeze(['SUBMITTED', 'VERIFIED', 'REJECTED']);
