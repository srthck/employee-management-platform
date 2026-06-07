import { body, query, param, validationResult } from 'express-validator';

/**
 * Employee Validators
 *
 * Input validation for all employee CRUD endpoints.
 * Mirrors the Employee schema rules for consistent error messages.
 */

const DEPARTMENTS = [
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
];

const STATUSES = ['active', 'inactive', 'on-leave'];

// ─── Create Employee ─────────────────────────────────────────────────────────
export const validateCreateEmployee = [
  body('firstName')
    .trim()
    .notEmpty().withMessage('First name is required')
    .isLength({ min: 2 }).withMessage('First name must be at least 2 characters')
    .isLength({ max: 50 }).withMessage('First name cannot exceed 50 characters')
    .matches(/^[a-zA-Z\s'-]+$/).withMessage('First name can only contain letters, spaces, hyphens, and apostrophes'),

  body('lastName')
    .trim()
    .notEmpty().withMessage('Last name is required')
    .isLength({ min: 2 }).withMessage('Last name must be at least 2 characters')
    .isLength({ max: 50 }).withMessage('Last name cannot exceed 50 characters')
    .matches(/^[a-zA-Z\s'-]+$/).withMessage('Last name can only contain letters, spaces, hyphens, and apostrophes'),

  body('email')
    .trim()
    .toLowerCase()
    .notEmpty().withMessage('Email is required')
    .isEmail().withMessage('Invalid email format')
    .normalizeEmail(),

  body('phone')
    .optional({ checkFalsy: true })
    .trim()
    .matches(/^[\+]?[\d\s\-\(\)]{7,20}$/).withMessage('Invalid phone number format'),

  body('department')
    .trim()
    .notEmpty().withMessage('Department is required')
    .isIn(DEPARTMENTS).withMessage(`Department must be one of: ${DEPARTMENTS.join(', ')}`),

  body('position')
    .trim()
    .notEmpty().withMessage('Position is required')
    .isLength({ min: 2 }).withMessage('Position must be at least 2 characters')
    .isLength({ max: 100 }).withMessage('Position cannot exceed 100 characters'),

  body('salary')
    .notEmpty().withMessage('Salary is required')
    .isFloat({ min: 0, max: 10000000 }).withMessage('Salary must be a positive number'),

  body('hireDate')
    .notEmpty().withMessage('Hire date is required')
    .isISO8601().withMessage('Hire date must be a valid date (YYYY-MM-DD)')
    .toDate(),

  body('status')
    .optional()
    .isIn(STATUSES).withMessage(`Status must be one of: ${STATUSES.join(', ')}`),

  body('notes')
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ max: 500 }).withMessage('Notes cannot exceed 500 characters'),
];

// ─── Update Employee (all fields optional) ───────────────────────────────────
export const validateUpdateEmployee = [
  body('firstName')
    .optional()
    .trim()
    .isLength({ min: 2 }).withMessage('First name must be at least 2 characters')
    .isLength({ max: 50 }).withMessage('First name cannot exceed 50 characters')
    .matches(/^[a-zA-Z\s'-]+$/).withMessage('First name can only contain letters, spaces, hyphens, and apostrophes'),

  body('lastName')
    .optional()
    .trim()
    .isLength({ min: 2 }).withMessage('Last name must be at least 2 characters')
    .isLength({ max: 50 }).withMessage('Last name cannot exceed 50 characters')
    .matches(/^[a-zA-Z\s'-]+$/).withMessage('Last name can only contain letters, spaces, hyphens, and apostrophes'),

  body('email')
    .optional()
    .trim()
    .toLowerCase()
    .isEmail().withMessage('Invalid email format')
    .normalizeEmail(),

  body('phone')
    .optional({ checkFalsy: true })
    .trim()
    .matches(/^[\+]?[\d\s\-\(\)]{7,20}$/).withMessage('Invalid phone number format'),

  body('department')
    .optional()
    .trim()
    .isIn(DEPARTMENTS).withMessage(`Department must be one of: ${DEPARTMENTS.join(', ')}`),

  body('position')
    .optional()
    .trim()
    .isLength({ min: 2 }).withMessage('Position must be at least 2 characters')
    .isLength({ max: 100 }).withMessage('Position cannot exceed 100 characters'),

  body('salary')
    .optional()
    .isFloat({ min: 0, max: 10000000 }).withMessage('Salary must be a positive number'),

  body('hireDate')
    .optional()
    .isISO8601().withMessage('Hire date must be a valid date (YYYY-MM-DD)')
    .toDate(),

  body('status')
    .optional()
    .isIn(STATUSES).withMessage(`Status must be one of: ${STATUSES.join(', ')}`),

  body('notes')
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ max: 500 }).withMessage('Notes cannot exceed 500 characters'),
];

// ─── Query param validation for list/search ───────────────────────────────────
export const validateEmployeeQuery = [
  query('page')
    .optional()
    .isInt({ min: 1 }).withMessage('Page must be a positive integer')
    .toInt(),

  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1 and 100')
    .toInt(),

  query('department')
    .optional()
    .isIn([...DEPARTMENTS, '']).withMessage('Invalid department filter'),

  query('status')
    .optional()
    .isIn([...STATUSES, '']).withMessage('Invalid status filter'),

  query('search')
    .optional()
    .trim()
    .isLength({ max: 100 }).withMessage('Search query too long'),

  query('sortBy')
    .optional()
    .isIn(['firstName', 'lastName', 'email', 'department', 'position', 'salary', 'hireDate', 'createdAt'])
    .withMessage('Invalid sort field'),

  query('sortOrder')
    .optional()
    .isIn(['asc', 'desc']).withMessage('Sort order must be asc or desc'),
];

// ─── MongoDB ID param validation ─────────────────────────────────────────────
export const validateEmployeeId = [
  param('id')
    .isMongoId().withMessage('Invalid employee ID'),
];

// ─── Shared error handler ─────────────────────────────────────────────────────
export const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: errors.array().map((err) => ({
        field: err.param || err.path,
        message: err.msg,
      })),
    });
  }
  next();
};
