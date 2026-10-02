/**
 * Client-side permission helpers.
 *
 * The server sends the signed-in user's permissions (derived from their role).
 * The UI uses them only to decide what to show; the API enforces every
 * permission independently.
 */

export const can = (user, permission) => Boolean(user?.permissions?.includes(permission));

export const canAny = (user, permissions) => permissions.some((permission) => can(user, permission));

export const ROLE_LABELS = {
  admin: 'Administrator',
  payroll_admin: 'Payroll administrator',
  payroll_approver: 'Payroll approver',
  manager: 'HR manager',
  auditor: 'Auditor',
  employee: 'Employee',
};

export const roleLabel = (role) => ROLE_LABELS[role] || role;
