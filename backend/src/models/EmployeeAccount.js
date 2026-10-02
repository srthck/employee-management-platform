import mongoose from 'mongoose';
import bcryptjs from 'bcryptjs';
import config from '../config/environment.js';
import { EMAIL_PATTERN } from '../utils/email.js';

const employeeAccountSchema = new mongoose.Schema(
  {
    employee: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
      required: [true, 'Employee reference is required'],
      unique: true,
    },

    // Workspace the employee belongs to (Employee.createdBy at creation time).
    // Accounts created before this field existed resolve it from the employee.
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      default: null,
      index: true,
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
      select: false,
    },

    role: {
      type: String,
      enum: ['employee'],
      default: 'employee',
      immutable: true,
    },

    isActive: {
      type: Boolean,
      default: true,
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

employeeAccountSchema.pre('save', async function (next) {
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

employeeAccountSchema.methods.comparePassword = async function (enteredPassword) {
  return bcryptjs.compare(enteredPassword, this.password);
};

employeeAccountSchema.methods.toJSON = function () {
  const obj = this.toObject();

  delete obj.password;
  delete obj.tokenVersion;
  delete obj.failedLoginAttempts;
  delete obj.lockUntil;
  delete obj.__v;

  return obj;
};

employeeAccountSchema.index({ employee: 1 }, { unique: true });
employeeAccountSchema.index({ email: 1 }, { unique: true });

export default mongoose.model('EmployeeAccount', employeeAccountSchema);
