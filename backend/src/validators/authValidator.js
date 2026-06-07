import { body, validationResult } from 'express-validator';

/**
 * Express Validator Chain
 * 
 * Production standards:
 * - Sanitize input (trim, lowercase emails)
 * - Validate format and length
 * - Custom validation rules
 * - Clear error messages for debugging
 */

/**
 * Validation: Register request
 * Validates: name, email, password
 */
export const validateRegister = [
  body('name')
    .trim()
    .notEmpty()
    .withMessage('Name is required')
    .isLength({ min: 2 })
    .withMessage('Name must be at least 2 characters')
    .isLength({ max: 50 })
    .withMessage('Name cannot exceed 50 characters')
    .matches(/^[a-zA-Z\s'-]+$/)
    .withMessage('Name can only contain letters, spaces, hyphens, and apostrophes'),

  body('email')
    .trim()
    .toLowerCase()
    .isEmail()
    .withMessage('Invalid email format')
    .normalizeEmail(),

  body('password')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters')
    .isLength({ max: 64 })
    .withMessage('Password cannot exceed 64 characters')
    .matches(/(?=.*[a-z])/) // at least one lowercase
    .withMessage('Password must contain at least one lowercase letter')
    .matches(/(?=.*[A-Z])/) // at least one uppercase
    .withMessage('Password must contain at least one uppercase letter')
    .matches(/(?=.*\d)/) // at least one digit
    .withMessage('Password must contain at least one digit'),

  body('confirmPassword')
    .custom((value, { req }) => value === req.body.password)
    .withMessage('Passwords do not match'),
];

/**
 * Validation: Login request
 * Validates: email, password
 */
export const validateLogin = [
  body('email')
    .trim()
    .toLowerCase()
    .isEmail()
    .withMessage('Invalid email format')
    .normalizeEmail(),

  body('password')
    .notEmpty()
    .withMessage('Password is required'),
];

/**
 * Handle validation errors
 * 
 * Production standards:
 * - Returns 400 Bad Request on validation failure
 * - Structured error response
 * - No sensitive information leaked
 */
export const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: errors.array().map((err) => ({
        field: err.param,
        message: err.msg,
      })),
    });
  }
  next();
};
