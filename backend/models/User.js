const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const userSchema = new mongoose.Schema(
  {
    // Identity
    staffId: { type: String, unique: true, sparse: true, trim: true }, // e.g. "YP/0001"
    name: { type: String, required: true, trim: true, maxlength: 100 }, // kept for compatibility (full name)
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: false },
    googleId: { type: String, default: null, index: true },

    // HR / payroll (required for onboarding completion)
    phone: { type: String, trim: true },
    idNumber: { type: String, trim: true },
    kraPin: { type: String, trim: true },
    nssf: { type: String, trim: true },
    nhif: { type: String, trim: true },
    bank: {
      accountNumber: { type: String, trim: true },
      bankName: { type: String, trim: true },
      branch: { type: String, trim: true },
      isVerified: { type: Boolean, default: false },
      isActive: { type: Boolean, default: false },
    },

    // System / onboarding
    role: {
      type: String,
      enum: ["admin", "general_supervisor", "supervisor", "staff"],
      default: "staff",
    },
    status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
    isVerified: { type: Boolean, default: false },
    profileCompleted: { type: Boolean, default: false },
    branch_id: { type: mongoose.Schema.Types.ObjectId, ref: "Branch" },
    is_active: { type: Boolean, default: false }, // false until approved
    failed_login_attempts: { type: Number, default: 0 },
    lockout_until: { type: Date, default: null },
    password_changed_at: { type: Date },
    force_password_reset: { type: Boolean, default: false },
    refresh_token_hash: { type: String, select: false },
    totp_secret: { type: String, select: false },
    totp_enabled: { type: Boolean, default: false },
    last_ip: { type: String },
    last_login: { type: Date },
  },
  {
    timestamps: true,
    toJSON: {
      transform(doc, ret) {
        delete ret.password;
        delete ret.refresh_token_hash;
        delete ret.totp_secret;
        delete ret.__v;
        return ret;
      },
    },
  }
);

userSchema.index({ branch_id: 1, role: 1 });
userSchema.index({ is_active: 1, role: 1 });
userSchema.index({ staffId: 1 });
userSchema.index({ status: 1, role: 1, is_active: 1 });

userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  if (!this.password) return next();
  this.password = await bcrypt.hash(this.password, 12);
  this.password_changed_at = new Date();
  next();
});

userSchema.methods.comparePassword = async function (candidate) {
  if (!this.password) return false;
  return bcrypt.compare(candidate, this.password);
};

userSchema.methods.isLocked = function () {
  return this.lockout_until && this.lockout_until > new Date();
};

userSchema.methods.recordFailedLogin = async function () {
  this.failed_login_attempts += 1;
  if (this.failed_login_attempts >= 5) {
    this.lockout_until = new Date(Date.now() + 15 * 60 * 1000);
  }
  return this.save({ validateModifiedOnly: true });
};

userSchema.methods.resetLoginAttempts = async function () {
  this.failed_login_attempts = 0;
  this.lockout_until = null;
  return this.save({ validateModifiedOnly: true });
};

module.exports = mongoose.model("User", userSchema);
