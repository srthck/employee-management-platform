/**
 * Permission-based access control.
 *
 * Routes declare the capability they need (requirePermission), never a role.
 * Roles are named bundles of permissions, so adding a role or splitting a duty
 * (e.g. separating who prepares payroll from who approves it) is a change here,
 * not a hunt through every route.
 *
 * Segregation of duties is built into the default bundles:
 *   payroll_admin     prepares payroll (create, calculate) but cannot finalize,
 *                     and cannot change where salary is paid
 *   payroll_approver  finalizes and overrides variance but cannot change inputs
 *   manager (HR)      maintains people data and bank accounts, cannot run payroll
 *   auditor           reads everything relevant (masked), changes nothing
 *
 * sensitive.read reveals decrypted statutory and bank identifiers; every
 * reveal is audited. It is not needed to see masked values.
 */

export const PERMISSIONS = Object.freeze({
  EMPLOYEE_READ: 'employee.read',
  EMPLOYEE_WRITE: 'employee.write',
  EMPLOYEE_ARCHIVE: 'employee.archive',
  EMPLOYEE_STATUTORY_WRITE: 'employee.statutory.write',
  EMPLOYEE_BANK_WRITE: 'employee.bank.write',
  EMPLOYEE_DOCUMENT_WRITE: 'employee.document.write',
  EMPLOYEE_DOCUMENT_VERIFY: 'employee.document.verify',
  EMPLOYEE_ACCOUNT_MANAGE: 'employee_account.manage',
  SALARY_READ: 'salary.read',
  SALARY_REVISE: 'salary.revise',
  COMPENSATION_READ: 'compensation.read',
  COMPENSATION_PROPOSE: 'compensation.propose',
  COMPENSATION_APPROVE: 'compensation.approve',
  COMPENSATION_COMPONENT_MANAGE: 'compensation.component.manage',
  PAYROLL_READ: 'payroll.read',
  PAYROLL_PREFLIGHT: 'payroll.preflight',
  PAYROLL_PREPARE: 'payroll.prepare',
  PAYROLL_FINALIZE: 'payroll.finalize',
  PAYROLL_VARIANCE_OVERRIDE: 'payroll.variance.override',
  COMPLIANCE_READ: 'compliance.read',
  AUDIT_READ: 'audit.read',
  AUDIT_VERIFY: 'audit.verify',
  COMPANY_READ: 'company.read',
  COMPANY_MANAGE: 'company.manage',
  SENSITIVE_READ: 'sensitive.read',
  SELF_SERVICE: 'self.service',
});

const P = PERMISSIONS;

const ADMIN_PERMISSIONS = Object.values(P).filter((permission) => permission !== P.SELF_SERVICE);

export const ROLE_PERMISSIONS = Object.freeze({
  admin: Object.freeze(ADMIN_PERMISSIONS),
  payroll_admin: Object.freeze([
    P.COMPANY_READ, P.EMPLOYEE_READ, P.SALARY_READ, P.SALARY_REVISE,
    P.EMPLOYEE_STATUTORY_WRITE, P.EMPLOYEE_DOCUMENT_WRITE, P.SENSITIVE_READ,
    P.COMPENSATION_READ, P.COMPENSATION_PROPOSE, P.COMPENSATION_COMPONENT_MANAGE,
    P.PAYROLL_READ, P.PAYROLL_PREFLIGHT, P.PAYROLL_PREPARE,
    P.COMPLIANCE_READ, P.AUDIT_READ,
  ]),
  payroll_approver: Object.freeze([
    P.COMPANY_READ, P.EMPLOYEE_READ, P.SALARY_READ,
    P.COMPENSATION_READ, P.COMPENSATION_APPROVE,
    P.PAYROLL_READ, P.PAYROLL_PREFLIGHT, P.PAYROLL_FINALIZE, P.PAYROLL_VARIANCE_OVERRIDE,
    P.COMPLIANCE_READ, P.AUDIT_READ, P.AUDIT_VERIFY,
  ]),
  manager: Object.freeze([
    P.COMPANY_READ, P.EMPLOYEE_READ, P.EMPLOYEE_WRITE, P.EMPLOYEE_ACCOUNT_MANAGE, P.SALARY_READ,
    P.EMPLOYEE_STATUTORY_WRITE, P.EMPLOYEE_BANK_WRITE, P.EMPLOYEE_DOCUMENT_WRITE, P.EMPLOYEE_DOCUMENT_VERIFY,
    P.COMPENSATION_READ, P.COMPENSATION_PROPOSE,
    P.PAYROLL_READ, P.PAYROLL_PREFLIGHT,
    P.COMPLIANCE_READ, P.AUDIT_READ, P.AUDIT_VERIFY,
  ]),
  auditor: Object.freeze([
    P.COMPANY_READ, P.EMPLOYEE_READ, P.SALARY_READ, P.PAYROLL_READ, P.COMPENSATION_READ,
    P.COMPLIANCE_READ, P.AUDIT_READ, P.AUDIT_VERIFY,
  ]),
  employee: Object.freeze([P.SELF_SERVICE]),
});

/** Roles that belong to company staff (stored on Admin). */
export const STAFF_ROLES = Object.freeze(['admin', 'payroll_admin', 'payroll_approver', 'manager', 'auditor']);

export const ROLE_LABELS = Object.freeze({
  admin: 'Administrator',
  payroll_admin: 'Payroll administrator',
  payroll_approver: 'Payroll approver',
  manager: 'HR manager',
  auditor: 'Auditor',
  employee: 'Employee',
});

export const permissionsForRole = (role) => ROLE_PERMISSIONS[role] || [];

export const hasPermission = (user, permission) => permissionsForRole(user?.role).includes(permission);
