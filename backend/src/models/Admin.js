import mongoose from 'mongoose';
import bcryptjs from 'bcryptjs';
import config from '../config/environment.js';
import { EMAIL_PATTERN } from '../utils/email.js';

/**
 * Admin User Schema
 *
 * Represents system administrators and managers
 *
 * Security Standards:
 * - Passwords hashed with bcrypt (cost from BCRYPT_ROUNDS, default 12)
 * - Email unique and indexed for fast queries
 * - Plain text password never stored or logged
 * - Timestamps for audit trail
 * - tokenVersion lets "sign out everywhere" revoke every issued JWT
 * - failedLoginAttempts / lockUntil implement per-account lockout
 *
 * Company identity:
 * - An admin who registers owns a workspace; companyId stays null and the
 *   admin's own _id is the company.
 * - Users created inside an existing workspace carry that workspace's
 *   companyId explicitly.
 */

const adminSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      minlength: [2, 'Name must be at least 2 characters'],
      maxlength: [50, 'Name cannot exceed 50 characters'],
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [EMAIL_PATTERN, 'Invalid email format'],
    },
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: [8, 'Password must be at least 8 characters'],
      select: false, // Don't return password by default
    },
    // Permission bundles for each role live in utils/permissions.js.
    role: {
      type: String,
      enum: ['admin', 'payroll_admin', 'payroll_approver', 'manager', 'auditor'],
      default: 'admin',
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      default: null,
      index: true,
    },
    tokenVersion: {
      type: Number,
      default: 0,
    },
    failedLoginAttempts: {
      type: Number,
      default: 0,
      select: false,
    },
    lockUntil: {
      type: Date,
      default: null,
      select: false,
    },
    lastLoginAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

/**
 * Pre-save middleware: Hash password before saving
 *
 * Only hash if password is modified or new
 */
adminSchema.pre('save', async function (next) {
  // Only hash if password is new or modified
  if (!this.isModified('password')) {
    return next();
  }

  try {
    const salt = await bcryptjs.genSalt(config.bcryptRounds);
    this.password = await bcryptjs.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

/**
 * Instance method: Compare plaintext password with hashed password
 *
 * Used during login to verify credentials
 * @param {string} enteredPassword - Plain text password from login form
 * @returns {Promise<boolean>} - True if passwords match
 */
adminSchema.methods.comparePassword = async function (enteredPassword) {
  return await bcryptjs.compare(enteredPassword, this.password);
};

/**
 * Instance method: Get user data without sensitive fields
 *
 * Returns only public-safe fields
 * @returns {Object} - Safe user object
 */
adminSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password; // Never expose password
  delete obj.tokenVersion;
  delete obj.failedLoginAttempts;
  delete obj.lockUntil;
  delete obj.__v;
  return obj;
};

adminSchema.index({ createdAt: -1 });

export default mongoose.model('Admin', adminSchema);
