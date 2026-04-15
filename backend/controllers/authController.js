
const crypto = require("crypto");
const User = require("../models/User");
const StaffProfile = require("../models/StaffProfile");
const LeaveBalance = require("../models/LeaveBalance");
const Session = require("../models/Session");
const SecurityEvent = require("../models/SecurityEvent");
const { signAccess, issueRefreshToken, verifyRefreshToken,
        revokeAllSessions, setRefreshCookie, clearRefreshCookie } = require("../utils/tokens");
const { validatePassword } = require("../utils/passwordPolicy");
const { isNewDevice, recordEvent } = require("../utils/intrusion");
const { calcAnnualLeaveAccrual } = require("../utils/dateHelpers");
const { nextYPStaffId } = require("../utils/staffId");
const { nextYPStaffIdV2 } = require("../utils/staffIdV2");

const getIP = (req) => req.ip || req.headers["x-forwarded-for"]?.split(",")[0] || "unknown";
const getUA = (req) => req.headers["user-agent"] || "unknown";

// ─── POST /api/auth/login ──────────────────────────────────────────────────────
exports.login = async (req, res) => {
  const ip = getIP(req);
  const ua = getUA(req);
  const identifier = (req.body.identifier || req.body.email || "").toString();
  const { password } = req.body;

  if (!identifier || !password)
    return res.status(400).json({ success: false, message: "identifier (email or staffId) and password required." });

  try {
    const identTrim = identifier.trim();
    const isEmail = /@/.test(identTrim);
    const query = isEmail ? { email: identTrim.toLowerCase() } : { staffId: identTrim.toUpperCase() };
    const user = await User.findOne(query).select("+refresh_token_hash");

    // Always take the same time path to prevent user enumeration
    if (!user) {
      await new Promise(r => setTimeout(r, 300)); // constant-time delay
      await recordEvent("failed_login", { email: identTrim, ip_address: ip, user_agent: ua });
      return res.status(401).json({ success: false, message: "Invalid credentials." });
    }

    // Lockout check
    if (user.isLocked()) {
      const remaining = Math.ceil((user.lockout_until - Date.now()) / 60000);
      return res.status(429).json({
        success: false,
        message: `Account locked. Try again in ${remaining} minute(s).`,
      });
    }

    const passwordOk = await user.comparePassword(password);
    if (!passwordOk) {
      await user.recordFailedLogin();
      if (user.failed_login_attempts >= 5) {
        await recordEvent("account_lockout", {
          user_id: user._id, email: user.email, ip_address: ip, user_agent: ua,
          metadata: { attempts: user.failed_login_attempts },
        });
        return res.status(429).json({
          success: false,
          message: "Too many failed attempts. Account locked for 15 minutes.",
        });
      }
      await recordEvent("failed_login", { user_id: user._id, email: user.email, ip_address: ip, user_agent: ua });
      return res.status(401).json({
        success: false,
        message: `Invalid credentials. ${5 - user.failed_login_attempts} attempt(s) remaining.`,
      });
    }

    const effectiveStatus = user.status || (user.is_active ? "approved" : "pending");
    if (user.status !== effectiveStatus) {
      user.status = effectiveStatus;
      await user.save({ validateModifiedOnly: true });
    }

    if (effectiveStatus !== "approved" || !user.is_active) {
      return res.status(403).json({
        success: false,
        message: effectiveStatus === "pending" ? "Account pending approval." : "Account not approved.",
        code: "NOT_APPROVED",
        status: effectiveStatus,
      });
    }

    // Reset failed attempts on success
    await user.resetLoginAttempts();

    // Anomaly: new device detection
    const newDevice = await isNewDevice(user._id, ip, ua);
    if (newDevice && user.role === "admin") {
      await recordEvent("new_device", {
        user_id: user._id, ip_address: ip, user_agent: ua,
        metadata: { role: user.role },
      });
    }

    // Issue tokens
    const { token: accessToken, jti } = signAccess(user._id, user.role);
    const { raw: refreshToken, expiresAt } = await issueRefreshToken(user._id, ip, ua);

    // Update last login meta
    user.last_ip = ip;
    user.last_login = new Date();
    await user.save({ validateModifiedOnly: true });

    // Sync leave balance for staff
    if (user.role === "staff") {
      const profile = await StaffProfile.findOne({ user_id: user._id });
      if (profile) {
        const totalAccrued = calcAnnualLeaveAccrual(profile.join_date);
        let bal = await LeaveBalance.findOne({ staff_id: user._id });
        if (!bal) {
          await LeaveBalance.create({ staff_id: user._id, annual_balance: totalAccrued });
        } else {
          const used = Math.max(0, totalAccrued - bal.annual_balance);
          bal.annual_balance = Math.max(0, totalAccrued - used);
          await bal.save();
        }
      }
    }

    setRefreshCookie(res, refreshToken, expiresAt);

    return res.json({
      success: true,
      message: "Login successful.",
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 900, // 15 min in seconds
      data: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        branch_id: user.branch_id,
        new_device_warning: newDevice && user.role === "admin",
        profile_warning: user.profileCompleted ? null : "Complete your profile to enable payments",
      },
    });
  } catch (err) {
    console.error("[login]", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

// ─── POST /api/auth/signup  (public onboarding) ───────────────────────────────
exports.signup = async (req, res) => {
  try {
    const {
      fullName,
      email,
      password,
    } = req.body;

    if (!fullName || !email || !password)
      return res.status(400).json({ success: false, message: "fullName, email, and password required." });

    const { valid, errors } = validatePassword(password);
    if (!valid) return res.status(400).json({ success: false, message: "Password policy failed.", errors });

    const exists = await User.findOne({ email: email.toLowerCase().trim() });
    if (exists) return res.status(400).json({ success: false, message: "Email already in use." });

    const staffId = await nextYPStaffIdV2();

    const user = await User.create({
      staffId,
      name: String(fullName).trim(),
      email: email.toLowerCase().trim(),
      password,
      // Ignore any client-provided role to prevent privilege escalation.
      role: "staff",
      status: "pending",
      is_active: false,
      isVerified: false,
      profileCompleted: false,
    });

    return res.status(201).json({
      success: true,
      message: "Registration received. Your account is pending approval.",
      staffId: user.staffId,
    });
  } catch (err) {
    console.error("[signup]", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

// ─── POST /api/auth/complete-profile (for google/pending users) ───────────────
exports.completeProfile = async (req, res) => {
  try {
    const { phone, idNumber, kraPin, nssf, nhif, bankName, bankBranch, accountNumber } = req.body;
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ success: false, message: "User not found." });

    const idOk = /^[0-9]{7,8}$/.test(String(idNumber || ""));
    const kraOk = /^[A-Z][0-9]{9}[A-Z]$/.test(String(kraPin || "").toUpperCase());
    const phoneOk = /^(\+254|0)[0-9]{9}$/.test(String(phone || ""));
    const acctOk = String(accountNumber || "").trim().length >= 6;
    if (!idOk || !kraOk || !phoneOk || !acctOk) {
      return res.status(400).json({
        success: false,
        message: "Invalid profile fields. Ensure ID, KRA PIN, phone, and bank account are valid.",
      });
    }

    Object.assign(user, { phone, idNumber, kraPin, nssf, nhif });
    user.bank = {
      ...(user.bank || {}),
      bankName,
      branch: bankBranch,
      accountNumber,
      isVerified: false,
      isActive: false,
    };
    if (!user.staffId) user.staffId = await nextYPStaffIdV2();
    user.status = "pending";
    user.is_active = false;
    user.role = "staff";
    user.profileCompleted = true;
    user.isVerified = false;

    await user.save();

    return res.json({ success: true, message: "Profile completed. Awaiting admin approval.", staffId: user.staffId });
  } catch (err) {
    console.error("[completeProfile]", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

// ─── POST /api/auth/refresh ────────────────────────────────────────────────────
exports.refresh = async (req, res) => {
  const rawToken = req.cookies?.wms_refresh;
  if (!rawToken)
    return res.status(401).json({ success: false, message: "No refresh token." });

  const { user_id } = req.body;
  if (!user_id)
    return res.status(400).json({ success: false, message: "user_id required." });

  try {
    const valid = await verifyRefreshToken(user_id, rawToken);
    if (!valid) {
      // Possible token theft — revoke everything
      await revokeAllSessions(user_id);
      clearRefreshCookie(res);
      await recordEvent("token_reuse", {
        user_id,
        ip_address: getIP(req),
        metadata: { note: "Invalid refresh token — all sessions revoked" },
      });
      return res.status(401).json({ success: false, message: "Session invalid. Please log in again." });
    }

    const user = await User.findById(user_id);
    if (!user || !user.is_active) {
      clearRefreshCookie(res);
      return res.status(401).json({ success: false, message: "Account not available." });
    }

    const ip = getIP(req);
    const ua = getUA(req);
    const { token: accessToken } = signAccess(user._id, user.role);
    const { raw: newRefresh, expiresAt } = await issueRefreshToken(user._id, ip, ua);

    setRefreshCookie(res, newRefresh, expiresAt);

    return res.json({
      success: true,
      access_token: accessToken,
      expires_in: 900,
    });
  } catch (err) {
    console.error("[refresh]", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

// ─── POST /api/auth/logout ─────────────────────────────────────────────────────
exports.logout = async (req, res) => {
  try {
    if (req.user) await revokeAllSessions(req.user._id);
    clearRefreshCookie(res);
    return res.json({ success: true, message: "Logged out." });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

// ─── POST /api/auth/register (admin-only) ─────────────────────────────────────
exports.register = async (req, res) => {
  try {
    const { name, email, password, role, branch_id, staff_type, join_date } = req.body;

    if (!name || !email || !password)
      return res.status(400).json({ success: false, message: "Name, email, and password required." });

    const { valid, errors } = validatePassword(password);
    if (!valid)
      return res.status(400).json({ success: false, message: "Password policy failed.", errors });

    const exists = await User.findOne({ email: email.toLowerCase().trim() });
    if (exists)
      return res.status(400).json({ success: false, message: "Email already in use." });

    const assignedRole = role || "staff";
    if (!["admin", "general_supervisor", "supervisor", "staff"].includes(assignedRole)) {
      return res.status(400).json({ success: false, message: "Invalid role." });
    }
    const user = await User.create({
      name,
      email,
      password,
      role: assignedRole,
      branch_id,
      status: "approved",
      is_active: true,
      isVerified: false,
      profileCompleted: false,
    });
    if (!user.staffId) user.staffId = await nextYPStaffIdV2();
    await user.save({ validateModifiedOnly: true });

    if (["staff", "supervisor"].includes(assignedRole)) {
      const jd = join_date ? new Date(join_date) : new Date();
      const staffId = await nextYPStaffId(jd);
      await StaffProfile.create({
        user_id: user._id,
        staff_id: staffId,
        type: staff_type || "casual",
        join_date: jd,
        pay_rate: 0,
      });
      if (assignedRole === "staff") {
        const accrued = calcAnnualLeaveAccrual(jd);
        await LeaveBalance.create({ staff_id: user._id, annual_balance: accrued });
      }
    }

    // Audit log
    const AuditLog = require("../models/AuditLog");
    await AuditLog.create({
      action: "CREATE_USER",
      admin_id: req.user._id,
      target_id: user._id,
      target_type: "user",
      module: "users",
      ip_address: getIP(req),
      user_agent: getUA(req),
      after: { name, email, role: assignedRole, branch_id },
    });

    return res.status(201).json({
      success: true,
      message: "User created.",
      data: { id: user._id, name: user.name, email: user.email, role: user.role },
    });
  } catch (err) {
    console.error("[register]", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

// ─── POST /api/auth/change-password ───────────────────────────────────────────
exports.changePassword = async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password)
      return res.status(400).json({ success: false, message: "Both passwords required." });

    const { valid, errors } = validatePassword(new_password);
    if (!valid)
      return res.status(400).json({ success: false, message: "Password policy failed.", errors });

    const user = await User.findById(req.user._id);
    if (!(await user.comparePassword(current_password)))
      return res.status(401).json({ success: false, message: "Current password incorrect." });

    user.password = new_password;
    user.force_password_reset = false;
    await user.save();
    await revokeAllSessions(user._id);
    clearRefreshCookie(res);

    return res.json({ success: true, message: "Password changed. Please log in again." });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

// ─── GET /api/auth/me ─────────────────────────────────────────────────────────
exports.getMe = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).populate("branch_id").select("-password");
    return res.json({ success: true, data: user });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

// ─── GET /api/auth/sessions ───────────────────────────────────────────────────
exports.getSessions = async (req, res) => {
  try {
    const sessions = await Session.find({
      user_id: req.user._id,
      is_revoked: false,
      expires_at: { $gt: new Date() },
    }).sort({ login_at: -1 });
    return res.json({ success: true, data: sessions });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

// ─── GET /api/auth/google/callback ────────────────────────────────────────────
exports.googleOAuthSuccess = async (req, res) => {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ success: false, message: "Google authentication failed." });

    const effectiveStatus = user.status || (user.is_active ? "approved" : "pending");
    if (user.status !== effectiveStatus) {
      user.status = effectiveStatus;
      await user.save({ validateModifiedOnly: true });
    }
    if (effectiveStatus !== "approved" || !user.is_active) {
      return res.status(403).json({
        success: false,
        message: effectiveStatus === "pending" ? "Account pending approval." : "Account not approved.",
        code: "NOT_APPROVED",
        status: effectiveStatus,
      });
    }

    const { token: accessToken } = signAccess(user._id, user.role);
    const { raw: refreshToken, expiresAt } = await issueRefreshToken(user._id, getIP(req), getUA(req));
    setRefreshCookie(res, refreshToken, expiresAt);

    return res.json({
      success: true,
      message: user.status === "approved" ? "Google login successful." : "Google account linked. Await admin approval.",
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 900,
      data: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        status: user.status,
        isVerified: user.isVerified,
        profileCompleted: user.profileCompleted,
      },
    });
  } catch (err) {
    console.error("[googleOAuthSuccess]", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};
