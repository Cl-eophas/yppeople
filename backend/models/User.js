const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true },
    role: { type: String, enum: ["admin", "supervisor", "staff"], default: "staff" },
    branch_id: { type: mongoose.Schema.Types.ObjectId, ref: "Branch" },
    is_active: { type: Boolean, default: true },
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

userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  this.password = await bcrypt.hash(this.password, 12);
  this.password_changed_at = new Date();
  next();
});

userSchema.methods.comparePassword = async function (candidate) {
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
