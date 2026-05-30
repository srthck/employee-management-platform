import mongoose from 'mongoose';
import bcryptjs from 'bcryptjs';

/**
 * Admin User Schema
 * 
 * Represents system administrators and managers
 * 
 * Security Standards:
 * - Passwords hashed with bcrypt (salt rounds: 10)
 * - Email unique and indexed for fast queries
 * - Plain text password never stored or logged
 * - Timestamps for audit trail
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
      match: [
        /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/,
        'Invalid email format',
      ],
    },
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: [6, 'Password must be at least 6 characters'],
      select: false, // Don't return password by default
    },
    role: {
      type: String,
      enum: ['admin', 'manager'],
      default: 'admin',
    },
    isActive: {
      type: Boolean,
      default: true,
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
 * Use bcryptjs with 10 salt rounds (enterprise standard)
 */
adminSchema.pre('save', async function (next) {
  // Only hash if password is new or modified
  if (!this.isModified('password')) {
    return next();
  }

  try {
    const salt = await bcryptjs.genSalt(10);
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
  delete obj.__v;
  return obj;
};

// Create indexes for performance
adminSchema.index({ email: 1 });
adminSchema.index({ createdAt: -1 });

export default mongoose.model('Admin', adminSchema);
