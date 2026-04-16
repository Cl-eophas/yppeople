const crypto = require("crypto");
const mongoose = require("mongoose");
const User = require("../models/User");
const StaffProfile = require("../models/StaffProfile");
const Branch = require("../models/Branch");
const Attendance = require("../models/Attendance");
const Leave = require("../models/Leave");
const LeaveBalance = require("../models/LeaveBalance");
const Notification = require("../models/Notification");
const Uniform = require("../models/Uniform");
const AuditLog = require("../models/AuditLog");
const SecurityEvent = require("../models/SecurityEvent");
const Session = require("../models/Session");
const Contract = require("../models/Contract");
const Shift = require("../models/Shift");
const OffDay = require("../models/OffDay");
const ForceClockRequest = require("../models/ForceClockRequest");
const ForceClockOutRequest = require("../models/ForceClockOutRequest");
const { sendMail } = require("../utils/mailer");
const { emitUserStatusChanged } = require("../realtime");
const { validatePassword } = require("../utils/passwordPolicy");
const { getActiveAlerts, detectRapidActions } = require("../utils/intrusion");
const { revokeAllSessions } = require("../utils/tokens");
const { emitAttendanceChanged } = require("../realtime");
const { escapeRegExp, matchUserIdsByStaffSearch } = require("../utils/staffSearch");

/** Debounce identical attendance exports per admin (month bucket) to reduce duplicate downloads. */
const recentAttendanceExports = new Map();
const EXPORT_DEBOUNCE_MS = 45_000;

const getIP = (req) => req.ip || req.headers["x-forwarded-for"]?.split(",")[0] || "unknown";
const getUA = (req) => req.headers["user-agent"] || "unknown";
const KRA_PIN_REGEX = /^[A-Z][0-9]{9}[A-Z]$/;
const PHONE_REGEX = /^(\+254|0)[0-9]{9}$/;

const hasCompletedProfile = (user) => {
  if (!user) return false;
  return Boolean(
    user.name &&
      user.email &&
      /^[0-9]{7,8}$/.test(String(user.idNumber || "")) &&
      KRA_PIN_REGEX.test(String(user.kraPin || "").toUpperCase()) &&
      PHONE_REGEX.test(String(user.phone || "")) &&
      user.nssf &&
      user.nhif &&
      user.bank?.bankName &&
      user.bank?.branch &&
      String(user.bank?.accountNumber || "").trim().length >= 6
  );
};

const writeAudit = async (action, req, targetId, targetType, before, after, metadata = {}) => {
  try {
    await AuditLog.create({
      action, admin_id: req.user._id, target_id: targetId,
      target_type: targetType, module: targetType,
      ip_address: getIP(req), user_agent: getUA(req),
      before, after, metadata,
    });
  } catch (e) { console.error("[audit]", e.message); }
};

// ─── Dashboard / Control Center ──────────────────────────────────
exports.getStats = async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);

    const [
      totalStaff,
      totalActive,
      totalBranches,
      pendingLeave,
      todayAtt,
      recentAudit,
      alertSample,
      securityAlertsCount,
      activeSessions,
    ] = await Promise.all([
      User.countDocuments({ role: "staff" }),
      User.countDocuments({ role: "staff", is_active: true }),
      Branch.countDocuments({ is_active: true }),
      Leave.countDocuments({ status: { $in: ["pending", "pending_document"] } }),
      Attendance.find({ date: today }),
      AuditLog.find({})
        .sort({ timestamp: -1 })
        .limit(10)
        .populate("admin_id", "name email"),
      SecurityEvent.find({ resolved: false })
        .sort({ created_at: -1 })
        .limit(5)
        .populate("user_id", "name email"),
      SecurityEvent.countDocuments({ resolved: false }),
      Session.countDocuments({ is_revoked: false, expires_at: { $gt: new Date() } }),
    ]);

    res.json({
      success: true,
      data: {
        workforce: { total_staff: totalStaff, active: totalActive, inactive: totalStaff - totalActive },
        today: {
          date: today,
          clocked_in: todayAtt.filter((a) => a.clock_in && !a.clock_out).length,
          clocked_out: todayAtt.filter((a) => a.clock_out).length,
          total_records: todayAtt.length,
        },
        branches: totalBranches,
        pending_leave: pendingLeave,
        active_sessions: activeSessions,
        security_alerts: securityAlertsCount,
        recent_activity: recentAudit,
        alerts: alertSample,
      },
    });
  } catch (err) {
    console.error("[getStats]", err);
    res.status(500).json({ success: false, message: "Server error." });
  }
};

// ─── Security Events ──────────────────────────────────────────────
exports.getSecurityEvents = async (req, res) => {
  try {
    const { resolved, type, limit = 50 } = req.query;
    const query = {};
    if (resolved !== undefined) query.resolved = resolved === "true";
    if (type) query.type = type;

    const events = await SecurityEvent.find(query)
      .sort({ created_at: -1 })
      .limit(parseInt(limit))
      .populate("user_id", "name email role");

    res.json({ success: true, data: events });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.resolveSecurityEvent = async (req, res) => {
  try {
    const event = await SecurityEvent.findByIdAndUpdate(
      req.params.id, { resolved: true }, { new: true }
    );
    if (!event) return res.status(404).json({ success: false, message: "Event not found." });
    await writeAudit("RESOLVE_SECURITY_EVENT", req, event._id, "security", null, { resolved: true });
    res.json({ success: true, message: "Event resolved.", data: event });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error." });
  }
};

// ─── User Management ──────────────────────────────────────────────
exports.getAllUsers = async (req, res) => {
  try {
    const { role, branch_id, is_active, status, search } = req.query;
    const query = {};
    if (role) query.role = role;
    if (branch_id) query.branch_id = branch_id;
    if (is_active !== undefined) query.is_active = is_active === "true";
    if (status) query.status = status;
    if (search && String(search).trim()) {
      const term = escapeRegExp(search.trim());
      const profMatch = await StaffProfile.find({ staff_id: { $regex: term, $options: "i" } }).select("user_id").lean();
      const profIds = profMatch.map((p) => p.user_id);
      const or = [
        { name: { $regex: term, $options: "i" } },
        { email: { $regex: term, $options: "i" } },
      ];
      if (profIds.length) or.push({ _id: { $in: profIds } });
      query.$or = or;
    }

    const users = await User.find(query).populate("branch_id", "name").sort({ createdAt: -1 }).lean();
    if (req.query.include_profile === "true") {
      const profileUserIds = users.filter((u) => ["staff", "supervisor"].includes(u.role)).map((u) => u._id);
      if (profileUserIds.length) {
        const profs = await StaffProfile.find({ user_id: { $in: profileUserIds } })
          .select("user_id type staff_id join_date")
          .lean();
        const map = Object.fromEntries(profs.map((p) => [p.user_id.toString(), p]));
        for (const u of users) {
          if (["staff", "supervisor"].includes(u.role)) u.staff_profile = map[u._id.toString()] || null;
        }
      }
    }
    res.json({ success: true, data: users, count: users.length });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.getPendingUsers = async (req, res) => {
  try {
    const users = await User.find({ status: "pending" })
      .populate("branch_id", "name")
      .sort({ createdAt: -1 })
      .lean();
    res.json({ success: true, data: users, count: users.length });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.approveUser = async (req, res) => {
  try {
    const { role } = req.body;
    if (!["staff", "supervisor", "general_supervisor", "admin"].includes(role)) {
      return res.status(400).json({ success: false, message: "Invalid role." });
    }
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: "User not found." });

    const before = { status: user.status, is_active: user.is_active, role: user.role };
    user.role = role;
    user.status = "approved";
    user.is_active = true;
    await user.save();

    await Notification.create({
      user_id: user._id,
      type: "info",
      message: `Your account has been approved. You can now log in.`,
    });

    const loginUrl = process.env.PUBLIC_APP_URL || "http://localhost:5000/";
    await sendMail({
      to: user.email,
      subject: "Account approved",
      html: `<p>Hello ${user.name},</p><p>Your account has been approved. You can now log in here: <a href="${loginUrl}">${loginUrl}</a></p>`,
      text: `Hello ${user.name},\n\nYour account has been approved. Log in: ${loginUrl}\n`,
    });

    await writeAudit("APPROVE_USER", req, user._id, "users", before, { status: "approved", role }, { notify: true });
    emitUserStatusChanged({ user_id: user._id, status: "approved", role: user.role });

    res.json({ success: true, message: "User approved.", data: { id: user._id, status: user.status, role: user.role } });
  } catch (err) {
    console.error("[approveUser]", err);
    res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.rejectUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: "User not found." });

    const before = { status: user.status, is_active: user.is_active };
    user.status = "rejected";
    user.is_active = false;
    await user.save();

    await Notification.create({
      user_id: user._id,
      type: "warning",
      message: `Your account registration was rejected. Contact HR/admin for support.`,
    });

    const loginUrl = process.env.PUBLIC_APP_URL || "http://localhost:5000/";
    await sendMail({
      to: user.email,
      subject: "Account rejected",
      html: `<p>Hello ${user.name},</p><p>Your account registration was rejected. If you believe this is an error, contact HR/admin.</p>`,
      text: `Hello ${user.name},\n\nYour account registration was rejected. Contact HR/admin.\n`,
    });

    await writeAudit("REJECT_USER", req, user._id, "users", before, { status: "rejected" }, { notify: true });
    emitUserStatusChanged({ user_id: user._id, status: "rejected" });

    res.json({ success: true, message: "User rejected." });
  } catch (err) {
    console.error("[rejectUser]", err);
    res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.verifyUserProfile = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: "User not found." });

    if (!user.profileCompleted || !hasCompletedProfile(user)) {
      return res.status(400).json({
        success: false,
        message: "Cannot verify user. Profile must be fully completed with valid bank details.",
      });
    }

    const before = { isVerified: user.isVerified, bankVerified: user.bank?.isVerified };
    user.isVerified = true;
    user.bank = { ...(user.bank || {}), isVerified: true, isActive: true };
    await user.save();

    await Notification.create({
      user_id: user._id,
      type: "info",
      message: "Your profile has been verified by admin.",
    });

    await sendMail({
      to: user.email,
      subject: "Profile verified",
      html: `<p>Hello ${user.name},</p><p>Your profile and payment details have been verified successfully.</p>`,
      text: `Hello ${user.name},\n\nYour profile and payment details have been verified successfully.\n`,
    });

    await writeAudit("VERIFY_USER_PROFILE", req, user._id, "users", before, { isVerified: true });

    return res.json({
      success: true,
      message: "User verified successfully.",
      data: { id: user._id, isVerified: user.isVerified },
    });
  } catch (err) {
    console.error("[verifyUserProfile]", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.createUserByAdmin = async (req, res) => {
  try {
    const { fullName, email, role, branch_id } = req.body;
    const cleanEmail = String(email || "").toLowerCase().trim();
    const cleanName = String(fullName || "").trim();

    if (!["admin", "general_supervisor", "supervisor", "staff"].includes(role)) {
      return res.status(400).json({ success: false, message: "Invalid role." });
    }

    const exists = await User.findOne({ email: cleanEmail });
    if (exists) return res.status(400).json({ success: false, message: "Email already in use." });

    const generatedPassword = crypto.randomBytes(8).toString("base64url");
    const staffId = await require("../utils/staffIdV2").nextYPStaffIdV2();

    const user = await User.create({
      staffId,
      name: cleanName,
      email: cleanEmail,
      password: generatedPassword,
      role,
      branch_id: branch_id || undefined,
      status: "approved",
      is_active: true,
      isVerified: false,
      profileCompleted: false,
      force_password_reset: true,
    });

    await Notification.create({
      user_id: user._id,
      type: "info",
      message: "Your account has been created by admin. Please update your password after login.",
    });

    const appUrl = process.env.PUBLIC_APP_URL || "http://localhost:5000/";
    await sendMail({
      to: user.email,
      subject: "Your WMS account credentials",
      html: `<p>Hello ${user.name},</p><p>Your account has been created.</p><p>Email: ${user.email}<br/>Temporary password: <strong>${generatedPassword}</strong><br/>Staff ID: ${user.staffId}</p><p>Login: <a href="${appUrl}">${appUrl}</a></p>`,
      text: `Hello ${user.name},\n\nYour account has been created.\nEmail: ${user.email}\nTemporary password: ${generatedPassword}\nStaff ID: ${user.staffId}\nLogin: ${appUrl}\n`,
    });

    await writeAudit(
      "ADMIN_CREATE_USER",
      req,
      user._id,
      "users",
      null,
      { name: user.name, email: user.email, role: user.role, status: user.status, staffId: user.staffId }
    );

    return res.status(201).json({
      success: true,
      message: "User account created successfully.",
      data: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        staffId: user.staffId,
      },
    });
  } catch (err) {
    console.error("[createUserByAdmin]", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.getForcedClockRequests = async (req, res) => {
  try {
    const { status = "pending" } = req.query;
    const query = {};
    if (["pending", "approved", "rejected"].includes(String(status))) {
      query.status = status;
    }

    const rows = await ForceClockRequest.find(query)
      .sort({ createdAt: -1 })
      .populate("user_id", "name email phone staffId branch_id")
      .populate("reviewed_by", "name email")
      .lean();

    return res.json({ success: true, data: rows, count: rows.length });
  } catch (err) {
    console.error("[getForcedClockRequests]", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.approveForcedClockRequest = async (req, res) => {
  try {
    const request = await ForceClockRequest.findById(req.params.id).populate("user_id", "name branch_id");
    if (!request) return res.status(404).json({ success: false, message: "Request not found." });
    if (request.status !== "pending") {
      return res.status(400).json({ success: false, message: "Request has already been reviewed." });
    }

    const now = new Date();
    const attendance = await Attendance.findOneAndUpdate(
      { staff_id: request.user_id._id, date: request.date },
      {
        $set: {
          clock_in: now,
          status: "forced",
          is_forced: true,
          notes: `Forced clock-in approved by admin. Reason: ${request.reason}`,
        },
        $setOnInsert: {
          staff_id: request.user_id._id,
          date: request.date,
        },
      },
      { upsert: true, new: true }
    );

    request.status = "approved";
    request.reviewed_by = req.user._id;
    request.reviewed_at = now;
    request.review_note = String(req.body.note || "").trim() || "Approved by admin";
    await request.save();

    await Notification.create({
      user_id: request.user_id._id,
      type: "attendance",
      message: "Your forced clock-in request has been approved by admin.",
    });

    await writeAudit(
      "APPROVE_FORCED_CLOCKIN",
      req,
      request._id,
      "attendance",
      { status: "pending" },
      { status: "approved", attendance_id: attendance._id }
    );

    if (request.user_id?.branch_id) {
      emitAttendanceChanged({ branch_id: request.user_id.branch_id, date: request.date });
    }

    return res.json({ success: true, message: "Forced clock-in request approved.", data: request });
  } catch (err) {
    console.error("[approveForcedClockRequest]", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.rejectForcedClockRequest = async (req, res) => {
  try {
    const request = await ForceClockRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ success: false, message: "Request not found." });
    if (request.status !== "pending") {
      return res.status(400).json({ success: false, message: "Request has already been reviewed." });
    }

    const note = String(req.body.note || "").trim();
    if (!note) {
      return res.status(400).json({ success: false, message: "Rejection note is required." });
    }

    request.status = "rejected";
    request.reviewed_by = req.user._id;
    request.reviewed_at = new Date();
    request.review_note = note;
    await request.save();

    await Notification.create({
      user_id: request.user_id,
      type: "warning",
      message: `Your forced clock-in request was rejected. Reason: ${note}`,
    });

    await writeAudit(
      "REJECT_FORCED_CLOCKIN",
      req,
      request._id,
      "attendance",
      { status: "pending" },
      { status: "rejected", review_note: note }
    );

    return res.json({ success: true, message: "Forced clock-in request rejected.", data: request });
  } catch (err) {
    console.error("[rejectForcedClockRequest]", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.getForcedClockOutRequests = async (req, res) => {
  try {
    const { status = "pending" } = req.query;
    const query = {};
    if (["pending", "approved", "rejected"].includes(String(status))) query.status = status;

    const rows = await ForceClockOutRequest.find(query)
      .sort({ createdAt: -1 })
      .populate("user_id", "name email phone staffId branch_id")
      .populate("reviewed_by", "name email")
      .lean();
    return res.json({ success: true, data: rows, count: rows.length });
  } catch (err) {
    console.error("[getForcedClockOutRequests]", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.approveForcedClockOutRequest = async (req, res) => {
  try {
    const request = await ForceClockOutRequest.findById(req.params.id).populate("user_id", "name branch_id");
    if (!request) return res.status(404).json({ success: false, message: "Request not found." });
    if (request.status !== "pending") return res.status(400).json({ success: false, message: "Request has already been reviewed." });

    const record = await Attendance.findOne({ staff_id: request.user_id._id, date: request.date });
    if (!record?.clock_in) return res.status(400).json({ success: false, message: "No clock-in record for that date." });
    if (record.clock_out) return res.status(400).json({ success: false, message: "Already clocked out." });

    const now = new Date();
    record.clock_out = now;
    record.is_forced = true;
    record.status = "forced";
    record.notes = `${record.notes || ""} [Forced clock-out approved by admin: ${request.reason}]`.trim();
    await record.save();

    request.status = "approved";
    request.reviewed_by = req.user._id;
    request.reviewed_at = now;
    request.review_note = String(req.body.note || "").trim() || "Approved by admin";
    await request.save();

    await Notification.create({
      user_id: request.user_id._id,
      type: "attendance",
      message: "Your forced clock-out request has been approved by admin.",
    });

    await writeAudit(
      "APPROVE_FORCED_CLOCKOUT",
      req,
      request._id,
      "attendance",
      { status: "pending" },
      { status: "approved", attendance_id: record._id }
    );
    if (request.user_id?.branch_id) emitAttendanceChanged({ branch_id: request.user_id.branch_id, date: request.date });

    return res.json({ success: true, message: "Forced clock-out request approved.", data: request });
  } catch (err) {
    console.error("[approveForcedClockOutRequest]", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.rejectForcedClockOutRequest = async (req, res) => {
  try {
    const request = await ForceClockOutRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ success: false, message: "Request not found." });
    if (request.status !== "pending") return res.status(400).json({ success: false, message: "Request has already been reviewed." });

    const note = String(req.body.note || "").trim();
    if (!note) return res.status(400).json({ success: false, message: "Rejection note is required." });

    request.status = "rejected";
    request.reviewed_by = req.user._id;
    request.reviewed_at = new Date();
    request.review_note = note;
    await request.save();

    await Notification.create({
      user_id: request.user_id,
      type: "warning",
      message: `Your forced clock-out request was rejected. Reason: ${note}`,
    });

    await writeAudit(
      "REJECT_FORCED_CLOCKOUT",
      req,
      request._id,
      "attendance",
      { status: "pending" },
      { status: "rejected", review_note: note }
    );
    return res.json({ success: true, message: "Forced clock-out request rejected.", data: request });
  } catch (err) {
    console.error("[rejectForcedClockOutRequest]", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.exportUsersXlsx = async (req, res) => {
  try {
    const XLSX = require("xlsx");
    const users = await User.find({})
      .populate("branch_id", "name")
      .sort({ createdAt: -1 })
      .lean();

    const rows = users.map((u) => ({
      "Staff ID": u.staffId || "",
      "Full Name": u.name || "",
      Email: u.email || "",
      Phone: u.phone || "",
      "ID Number": u.idNumber || "",
      "KRA PIN": u.kraPin || "",
      NSSF: u.nssf || "",
      NHIF: u.nhif || "",
      "Bank Name": u.bank?.bankName || "",
      "Account Number": u.bank?.accountNumber || "",
      Branch: u.bank?.branch || "",
      "Bank Verified": u.bank?.isVerified ? "Yes" : "No",
      Status: u.status || "",
      Role: u.role || "",
      "System Branch": u.branch_id?.name || "",
    }));

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Users");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="users.xlsx"');
    return res.send(buf);
  } catch (err) {
    console.error("[exportUsersXlsx]", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.getUserById = async (req, res) => {
  try {
    const user = await User.findById(req.params.id).populate("branch_id");
    if (!user) return res.status(404).json({ success: false, message: "User not found." });

    const [profile, balance, sessions, recentAudit] = await Promise.all([
      StaffProfile.findOne({ user_id: user._id }),
      LeaveBalance.findOne({ staff_id: user._id }),
      Session.find({ user_id: user._id, is_revoked: false, expires_at: { $gt: new Date() } }),
      AuditLog.find({ target_id: user._id }).sort({ timestamp: -1 }).limit(10),
    ]);

    res.json({
      success: true,
      data: { user, profile, leave_balance: balance, active_sessions: sessions.length, recent_audit: recentAudit },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.updateUser = async (req, res) => {
  try {
    // Whitelist allowed admin-editable fields
    const allowed = ["name", "email", "role", "branch_id", "is_active"];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: "User not found." });

    // Prevent admin from downgrading themselves
    if (req.params.id === req.user._id.toString() && updates.role && updates.role !== "admin")
      return res.status(400).json({ success: false, message: "Cannot downgrade your own admin role." });

    if (updates.role === "staff" && user.role === "supervisor" && user.branch_id) {
      const otherSupervisors = await User.countDocuments({
        branch_id: user.branch_id,
        role: "supervisor",
        is_active: true,
        _id: { $ne: user._id },
      });
      if (otherSupervisors < 1) {
        return res.status(400).json({
          success: false,
          message: "Cannot demote the last supervisor for this branch. Promote another supervisor first.",
        });
      }
    }

    if (updates.is_active === false && user.role === "supervisor" && user.branch_id) {
      const otherSupervisors = await User.countDocuments({
        branch_id: user.branch_id,
        role: "supervisor",
        is_active: true,
        _id: { $ne: user._id },
      });
      if (otherSupervisors < 1) {
        return res.status(400).json({
          success: false,
          message: "Cannot deactivate the last supervisor for this branch.",
        });
      }
    }

    const before = { name: user.name, email: user.email, role: user.role, branch_id: user.branch_id, is_active: user.is_active };
    Object.assign(user, updates);
    await user.save();

    const auditMeta = { ...updates };
    if (updates.role && updates.role !== before.role) auditMeta.promotion = `${before.role} → ${updates.role}`;
    await writeAudit("UPDATE_USER", req, user._id, "users", before, updates, auditMeta);

    if (updates.is_active === false) {
      await revokeAllSessions(user._id);
      await Notification.create({
        user_id: user._id,
        message: "Your account has been modified by an administrator.",
        type: "warning",
      });
    }

    res.json({ success: true, message: "User updated.", data: user });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.deactivateUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: "User not found." });
    if (req.params.id === req.user._id.toString())
      return res.status(400).json({ success: false, message: "Cannot deactivate yourself." });

    await User.findByIdAndUpdate(req.params.id, { is_active: false });
    await revokeAllSessions(req.params.id);
    await writeAudit("DEACTIVATE_USER", req, user._id, "users", { is_active: true }, { is_active: false });
    await Notification.create({ user_id: user._id, message: "Your account has been deactivated. Contact your administrator.", type: "warning" });

    res.json({ success: true, message: "User deactivated and sessions revoked." });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.deleteUser = async (req, res) => {
  try {
    const { confirmation, admin_password } = req.body;

    if (confirmation !== "DELETE")
      return res.status(400).json({ success: false, message: 'Type "DELETE" to confirm.' });

    // Re-auth: admin must provide their own password
    if (!admin_password)
      return res.status(400).json({ success: false, message: "Admin password required for deletion." });

    const adminUser = await User.findById(req.user._id);
    const passwordOk = await adminUser.comparePassword(admin_password);
    if (!passwordOk) {
      await writeAudit("DELETE_USER_FAILED_AUTH", req, req.params.id, "users", null, null, { reason: "wrong admin password" });
      return res.status(401).json({ success: false, message: "Admin password incorrect." });
    }

    const target = await User.findById(req.params.id);
    if (!target) return res.status(404).json({ success: false, message: "User not found." });
    if (req.params.id === req.user._id.toString())
      return res.status(400).json({ success: false, message: "Cannot delete yourself." });

    const snapshot = { name: target.name, email: target.email, role: target.role };
    await writeAudit("DELETE_USER", req, target._id, "users", snapshot, null, { permanent: true });

    await Promise.all([
      User.findByIdAndDelete(target._id),
      StaffProfile.deleteOne({ user_id: target._id }),
      LeaveBalance.deleteOne({ staff_id: target._id }),
      Session.deleteMany({ user_id: target._id }),
      Attendance.deleteMany({ staff_id: target._id }),
      Leave.deleteMany({ staff_id: target._id }),
      Notification.deleteMany({ user_id: target._id }),
      Uniform.deleteMany({ staff_id: target._id }),
      Contract.deleteMany({ staff_id: target._id }),
      Shift.deleteMany({ staff_id: target._id }),
      OffDay.deleteMany({ staff_id: target._id }),
    ]);

    res.json({ success: true, message: `User "${target.name}" permanently deleted.` });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error." });
  }
};

// ─── Pay Rate Management ─────────────────────────────────────────
exports.setPayRate = async (req, res) => {
  try {
    const { rate } = req.body;
    if (!rate || isNaN(rate) || rate <= 0)
      return res.status(400).json({ success: false, message: "Rate must be a positive number." });
    if (rate > 50000)
      return res.status(400).json({ success: false, message: "Rate exceeds maximum allowed (KES 50,000/day). Flag for review." });

    const profile = await StaffProfile.findOne({ user_id: req.params.id });
    if (!profile) return res.status(404).json({ success: false, message: "Staff profile not found." });

    const oldRate = profile.pay_rate;

    // Flag abnormal change (>200% increase)
    if (oldRate > 0 && rate > oldRate * 3) {
      const SecurityEvent = require("../models/SecurityEvent");
      await SecurityEvent.create({
        type: "anomalous_action",
        user_id: req.user._id,
        ip_address: getIP(req),
        metadata: { note: "Abnormal pay rate increase", old_rate: oldRate, new_rate: rate, staff_id: req.params.id },
      });
    }

    profile.rate_history.push({ rate: oldRate, effective_date: new Date(), set_by: req.user._id });
    profile.pay_rate = parseFloat(rate);
    await profile.save();

    await writeAudit("SET_PAY_RATE", req, req.params.id, "payroll", { pay_rate: oldRate }, { pay_rate: rate });

    await Notification.create({
      user_id: req.params.id,
      message: `Your pay rate has been updated to KES ${rate}/day by admin.`,
      type: "pay",
    });

    res.json({ success: true, message: "Pay rate updated.", data: { old_rate: oldRate, new_rate: rate } });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error." });
  }
};

// ─── Branch Management ────────────────────────────────────────────
exports.getBranches = async (req, res) => {
  try {
    const branches = await Branch.find().sort({ name: 1 });
    res.json({ success: true, data: branches });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.createBranch = async (req, res) => {
  try {
    const {
      name,
      address,
      latitude,
      longitude,
      radius_meters,
      default_shift_start_time,
      clock_in_window_minutes,
    } = req.body;

    const nameTrim = (name || "").trim();
    if (!nameTrim)
      return res.status(400).json({ success: false, message: "Branch name is required." });

    const esc = nameTrim.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const dup = await Branch.findOne({ name: new RegExp(`^${esc}$`, "i") });
    if (dup)
      return res.status(400).json({ success: false, message: "A branch with this name already exists." });

    const addr = (address || "").trim();
    if (!addr || addr.length < 5)
      return res.status(400).json({ success: false, message: "Address is required (at least 5 characters)." });

    if (latitude === undefined || longitude === undefined || isNaN(Number(latitude)) || isNaN(Number(longitude)))
      return res.status(400).json({ success: false, message: "Valid coordinates required." });
    const lat = Number(latitude);
    const lon = Number(longitude);
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180)
      return res.status(400).json({ success: false, message: "Coordinates out of valid range." });
    const rad = radius_meters != null ? Number(radius_meters) : 1000;
    if (Number.isNaN(rad) || rad < 50 || rad > 10000)
      return res.status(400).json({ success: false, message: "Radius must be 50–10,000 meters (default 1000)." });

    const dst = default_shift_start_time != null ? String(default_shift_start_time).trim() : "08:00";
    if (!/^\d{1,2}:\d{2}$/.test(dst))
      return res.status(400).json({ success: false, message: "default_shift_start_time must be HH:mm." });
    const [hh, mm] = dst.split(":").map((x) => parseInt(x, 10));
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59)
      return res.status(400).json({ success: false, message: "default_shift_start_time out of range." });
    const defaultShift = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;

    const win = clock_in_window_minutes != null ? Number(clock_in_window_minutes) : 60;
    if (Number.isNaN(win) || win < 10 || win > 240)
      return res.status(400).json({ success: false, message: "clock_in_window_minutes must be 10–240 (default 60)." });

    const branch = await Branch.create({
      name: nameTrim,
      address: addr,
      latitude: lat,
      longitude: lon,
      radius_meters: rad,
      default_shift_start_time: defaultShift,
      clock_in_window_minutes: Math.round(win),
    });
    await writeAudit("CREATE_BRANCH", req, branch._id, "branches", null, {
      name: nameTrim,
      address: addr,
      latitude: lat,
      longitude: lon,
      radius_meters: rad,
      default_shift_start_time: defaultShift,
      clock_in_window_minutes: Math.round(win),
    });

    res.status(201).json({ success: true, message: "Branch created.", data: branch });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.updateBranch = async (req, res) => {
  try {
    const {
      latitude,
      longitude,
      radius_meters,
      name,
      address,
      default_shift_start_time,
      clock_in_window_minutes,
    } = req.body;
    if (latitude !== undefined && (isNaN(latitude) || latitude < -90 || latitude > 90))
      return res.status(400).json({ success: false, message: "Invalid latitude." });
    if (longitude !== undefined && (isNaN(longitude) || longitude < -180 || longitude > 180))
      return res.status(400).json({ success: false, message: "Invalid longitude." });
    if (radius_meters !== undefined) {
      const rad = Number(radius_meters);
      if (Number.isNaN(rad) || rad < 50 || rad > 10000)
        return res.status(400).json({ success: false, message: "Radius must be 50–10,000 meters." });
    }
    if (default_shift_start_time !== undefined) {
      const dst = String(default_shift_start_time).trim();
      if (!/^\d{1,2}:\d{2}$/.test(dst))
        return res.status(400).json({ success: false, message: "default_shift_start_time must be HH:mm." });
      const [hh, mm] = dst.split(":").map((x) => parseInt(x, 10));
      if (hh < 0 || hh > 23 || mm < 0 || mm > 59)
        return res.status(400).json({ success: false, message: "default_shift_start_time out of range." });
    }
    if (clock_in_window_minutes !== undefined) {
      const win = Number(clock_in_window_minutes);
      if (Number.isNaN(win) || win < 10 || win > 240)
        return res.status(400).json({ success: false, message: "clock_in_window_minutes must be 10–240." });
    }

    const branch = await Branch.findById(req.params.id);
    if (!branch) return res.status(404).json({ success: false, message: "Branch not found." });

    const before = { name: branch.name, latitude: branch.latitude, longitude: branch.longitude, radius_meters: branch.radius_meters };
    if (name !== undefined) branch.name = name;
    if (address !== undefined) branch.address = address;
    if (latitude !== undefined) branch.latitude = Number(latitude);
    if (longitude !== undefined) branch.longitude = Number(longitude);
    if (radius_meters !== undefined) branch.radius_meters = Number(radius_meters);
    if (default_shift_start_time !== undefined) {
      const [hh, mm] = String(default_shift_start_time).trim().split(":").map((x) => parseInt(x, 10));
      branch.default_shift_start_time = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    }
    if (clock_in_window_minutes !== undefined) branch.clock_in_window_minutes = Math.round(Number(clock_in_window_minutes));
    await branch.save();

    await writeAudit("UPDATE_BRANCH", req, branch._id, "branches", before, req.body);
    res.json({ success: true, data: branch });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error." });
  }
};

// ─── Branch Monitoring / Transfers / Reports ──────────────────────
exports.getBranchMonitor = async (req, res) => {
  try {
    const branch = await Branch.findById(req.params.id).lean();
    if (!branch) return res.status(404).json({ success: false, message: "Branch not found." });

    const today = new Date().toISOString().slice(0, 10);
    const [activeStaff, activeSupervisors, todayAttendance, upcomingShifts, recentAudit] = await Promise.all([
      User.countDocuments({ branch_id: branch._id, role: "staff", is_active: true }),
      User.countDocuments({ branch_id: branch._id, role: "supervisor", is_active: true }),
      Attendance.find({ date: today })
        .populate("staff_id", "branch_id")
        .lean(),
      Shift.find({ branch_id: branch._id, shift_date: { $gte: today } })
        .sort({ shift_date: 1, start_time: 1 })
        .limit(25)
        .populate("staff_id", "name role")
        .lean(),
      AuditLog.find({ module: "branches", target_id: branch._id })
        .sort({ timestamp: -1 })
        .limit(10)
        .populate("admin_id", "name email")
        .lean(),
    ]);

    const branchToday = todayAttendance.filter(
      (a) => a.staff_id?.branch_id && String(a.staff_id.branch_id) === String(branch._id)
    );
    const byStatus = branchToday.reduce((acc, a) => {
      const k = a.status || "unknown";
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});

    return res.json({
      success: true,
      data: {
        branch,
        workforce: { active_staff: activeStaff, active_supervisors: activeSupervisors },
        today: { date: today, attendance_total: branchToday.length, attendance_by_status: byStatus },
        upcoming_shifts: upcomingShifts,
        recent_activity: recentAudit,
      },
    });
  } catch (err) {
    console.error("[getBranchMonitor]", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.transferUsersToBranch = async (req, res) => {
  try {
    const { user_ids, to_branch_id } = req.body;
    if (!Array.isArray(user_ids) || user_ids.length < 1)
      return res.status(400).json({ success: false, message: "user_ids must be a non-empty array." });
    if (!to_branch_id || !mongoose.Types.ObjectId.isValid(to_branch_id))
      return res.status(400).json({ success: false, message: "to_branch_id is required." });

    const toBranch = await Branch.findById(to_branch_id).lean();
    if (!toBranch) return res.status(404).json({ success: false, message: "Target branch not found." });

    const users = await User.find({ _id: { $in: user_ids } }).select("_id role branch_id is_active name email").lean();
    if (!users.length) return res.status(404).json({ success: false, message: "No users found for transfer." });

    const eligible = users.filter((u) => u.is_active && ["staff", "supervisor"].includes(u.role));
    if (!eligible.length)
      return res.status(400).json({ success: false, message: "No eligible active staff/supervisors found in selection." });

    const updates = await User.updateMany(
      { _id: { $in: eligible.map((u) => u._id) } },
      { $set: { branch_id: toBranch._id } }
    );

    await writeAudit(
      "TRANSFER_USERS_BRANCH",
      req,
      toBranch._id,
      "branches",
      null,
      { to_branch_id: toBranch._id, moved: eligible.length },
      { user_ids: eligible.map((u) => u._id.toString()) }
    );

    return res.json({
      success: true,
      message: `Transferred ${eligible.length} user(s) to "${toBranch.name}".`,
      data: { matched: users.length, transferred: eligible.length, modified: updates.modifiedCount },
    });
  } catch (err) {
    console.error("[transferUsersToBranch]", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.getBranchReport = async (req, res) => {
  try {
    const branch = await Branch.findById(req.params.id).lean();
    if (!branch) return res.status(404).json({ success: false, message: "Branch not found." });

    const from = req.query.from || req.query.start_date || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const to = req.query.to || req.query.end_date || new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to))
      return res.status(400).json({ success: false, message: "from/to must be YYYY-MM-DD." });

    const userIds = await User.find({ branch_id: branch._id, is_active: true, role: { $in: ["staff", "supervisor"] } })
      .select("_id")
      .lean();
    const ids = userIds.map((u) => u._id);

    const [attRows, leaveCount, shiftCount, staffCount, supCount] = await Promise.all([
      ids.length
        ? Attendance.find({ staff_id: { $in: ids }, date: { $gte: from, $lte: to } }).select("status date").lean()
        : [],
      ids.length ? Leave.countDocuments({ staff_id: { $in: ids }, createdAt: { $gte: new Date(from), $lte: new Date(to + "T23:59:59") } }) : 0,
      Shift.countDocuments({ branch_id: branch._id, shift_date: { $gte: from, $lte: to } }),
      User.countDocuments({ branch_id: branch._id, role: "staff", is_active: true }),
      User.countDocuments({ branch_id: branch._id, role: "supervisor", is_active: true }),
    ]);

    const attendance_by_status = attRows.reduce((acc, r) => {
      const k = r.status || "unknown";
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});

    return res.json({
      success: true,
      data: {
        branch: { _id: branch._id, name: branch.name },
        range: { from, to },
        workforce: { active_staff: staffCount, active_supervisors: supCount },
        attendance: { total_records: attRows.length, by_status: attendance_by_status },
        shifts: { total_scheduled: shiftCount },
        leave: { total_requests_created: leaveCount },
      },
    });
  } catch (err) {
    console.error("[getBranchReport]", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.deleteBranch = async (req, res) => {
  try {
    const assigned = await User.countDocuments({ branch_id: req.params.id, is_active: true });
    if (assigned > 0) {
      return res.status(400).json({
        success: false,
        message: "Reassign or deactivate all users before deleting this branch.",
      });
    }
    const branch = await Branch.findById(req.params.id);
    if (!branch) return res.status(404).json({ success: false, message: "Branch not found." });
    await Branch.findByIdAndDelete(req.params.id);
    await writeAudit("DELETE_BRANCH", req, req.params.id, "branches", { name: branch.name }, null);
    res.json({ success: true, message: "Branch deleted." });
  } catch (err) {
    console.error("[deleteBranch]", err);
    res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.updateStaffProfileType = async (req, res) => {
  try {
    const { type } = req.body;
    if (!["casual", "reliever", "contract"].includes(type)) {
      return res.status(400).json({ success: false, message: "type must be casual, reliever, or contract." });
    }
    const profile = await StaffProfile.findOne({ user_id: req.params.id });
    if (!profile) return res.status(404).json({ success: false, message: "Staff profile not found." });
    const before = profile.type;
    profile.type = type;
    await profile.save();
    await writeAudit("UPDATE_EMPLOYMENT_TYPE", req, req.params.id, "users", { employment_type: before }, { employment_type: type });
    res.json({ success: true, message: "Employment type updated.", data: profile });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error." });
  }
};

// ─── Attendance (Admin) ───────────────────────────────────────────
exports.getAllAttendance = async (req, res) => {
  try {
    const { date, branch_id, staff_id, status, search } = req.query;
    const query = {};
    if (date) query.date = date;
    if (status) query.status = status;

    if (search && String(search).trim()) {
      const ids = await matchUserIdsByStaffSearch(search);
      if (!ids.length) return res.json({ success: true, data: [], count: 0 });
      if (staff_id) {
        if (!ids.some((id) => id.toString() === staff_id)) {
          return res.json({ success: true, data: [], count: 0 });
        }
        query.staff_id = staff_id;
      } else {
        query.staff_id = { $in: ids };
      }
    } else if (staff_id) {
      query.staff_id = staff_id;
    }

    let records = await Attendance.find(query)
      .populate("staff_id", "name branch_id")
      .sort({ date: -1 })
      .limit(1000)
      .lean();

    const staffMongoIds = [...new Set(records.map((r) => r.staff_id?._id).filter(Boolean))];
    if (staffMongoIds.length) {
      const profs = await StaffProfile.find({ user_id: { $in: staffMongoIds } }).select("user_id staff_id").lean();
      const ypMap = Object.fromEntries(profs.map((p) => [p.user_id.toString(), p.staff_id]));
      for (const r of records) {
        const uid = r.staff_id?._id?.toString();
        if (uid) r.yp_staff_id = ypMap[uid] ?? null;
      }
    }

    if (branch_id) records = records.filter((r) => r.staff_id?.branch_id?.toString() === branch_id);
    res.json({ success: true, data: records, count: records.length });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.editAttendance = async (req, res) => {
  try {
    const { clock_in, clock_out, reason } = req.body;
    if (!reason?.trim())
      return res.status(400).json({ success: false, message: "Edit reason required." });

    const record = await Attendance.findById(req.params.id);
    if (!record) return res.status(404).json({ success: false, message: "Record not found." });

    const before = { clock_in: record.clock_in, clock_out: record.clock_out, status: record.status };
    if (clock_in) record.clock_in = new Date(clock_in);
    if (clock_out) record.clock_out = new Date(clock_out);
    record.notes = `${record.notes || ""} [Admin edit by ${req.user.name}: ${reason}]`.trim();
    await record.save();

    const staffU = await User.findById(record.staff_id).select("branch_id");
    if (staffU?.branch_id) emitAttendanceChanged({ branch_id: staffU.branch_id, date: record.date });

    await writeAudit("EDIT_ATTENDANCE", req, record._id, "attendance", before, { clock_in, clock_out }, { reason });
    res.json({ success: true, message: "Attendance record updated.", data: record });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error." });
  }
};

// ─── Leave ────────────────────────────────────────────────────────
exports.getAllLeave = async (req, res) => {
  try {
    const { status, staff_id, search } = req.query;
    const query = {};
    if (status) query.status = status;

    if (search && String(search).trim()) {
      const ids = await matchUserIdsByStaffSearch(search);
      if (!ids.length) return res.json({ success: true, data: [] });
      if (staff_id) {
        if (!ids.some((id) => id.toString() === staff_id)) return res.json({ success: true, data: [] });
        query.staff_id = staff_id;
      } else {
        query.staff_id = { $in: ids };
      }
    } else if (staff_id) {
      query.staff_id = staff_id;
    }

    const leaves = await Leave.find(query).populate("staff_id", "name").sort({ createdAt: -1 }).lean();
    const uids = [...new Set(leaves.map((l) => l.staff_id?._id).filter(Boolean))];
    if (uids.length) {
      const profs = await StaffProfile.find({ user_id: { $in: uids } }).select("user_id staff_id").lean();
      const ypMap = Object.fromEntries(profs.map((p) => [p.user_id.toString(), p.staff_id]));
      for (const l of leaves) {
        const id = l.staff_id?._id?.toString();
        if (id) l.yp_staff_id = ypMap[id] ?? null;
      }
    }
    res.json({ success: true, data: leaves });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.approveLeave = async (req, res) => {
  try {
    const leave = await Leave.findById(req.params.id).populate("staff_id", "name branch_id _id");
    if (!leave) return res.status(404).json({ success: false, message: "Leave not found." });
    if (!["pending", "pending_document"].includes(leave.status)) {
      return res.status(400).json({ success: false, message: "Leave can only be approved from pending state." });
    }
    if (leave.type.startsWith("sick") && !leave.medical_document)
      return res.status(400).json({ success: false, message: "Cannot approve sick leave without medical document." });

    leave.status = "approved";
    leave.approved_by = req.user._id;
    leave.approved_at = new Date();
    await leave.save();

    await writeAudit("APPROVE_LEAVE", req, leave._id, "leave", { status: "pending" }, { status: "approved" });
    await Notification.create({
      user_id: leave.staff_id._id,
      message: `Your ${leave.type.replace(/_/g, " ")} leave has been approved.`,
      type: "leave",
    });

    res.json({ success: true, message: "Leave approved.", data: leave });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.rejectLeave = async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason?.trim())
      return res.status(400).json({ success: false, message: "Rejection reason required." });

    const leave = await Leave.findById(req.params.id).populate("staff_id", "_id name");
    if (!leave) return res.status(404).json({ success: false, message: "Leave not found." });
    if (!["pending", "pending_document"].includes(leave.status)) {
      return res.status(400).json({ success: false, message: "Leave can only be rejected from pending state." });
    }

    // Refund balance
    const balance = await LeaveBalance.findOne({ staff_id: leave.staff_id._id });
    if (balance) {
      if (leave.type === "annual") balance.annual_balance += leave.days_requested;
      else if (leave.type === "sick_full") balance.sick_full_used = Math.max(0, balance.sick_full_used - leave.days_requested);
      else if (leave.type === "sick_half") balance.sick_half_used = Math.max(0, balance.sick_half_used - leave.days_requested);
      await balance.save();
    }

    leave.status = "rejected";
    leave.rejection_reason = reason;
    await leave.save();

    await writeAudit("REJECT_LEAVE", req, leave._id, "leave", { status: "pending" }, { status: "rejected", reason });
    await Notification.create({
      user_id: leave.staff_id._id,
      message: `Your ${leave.type.replace(/_/g, " ")} leave was rejected. Reason: ${reason}`,
      type: "leave",
    });

    res.json({ success: true, message: "Leave rejected and balance refunded." });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error." });
  }
};

// ─── Uniform ──────────────────────────────────────────────────────
exports.issueUniform = async (req, res) => {
  try {
    const { staff_id, item_type, size, item_description } = req.body;
    const existing = await Uniform.findOne({ staff_id, item_type, status: "active" });
    if (existing)
      return res.status(400).json({ success: false, message: `Active ${item_type} already assigned.` });

    const item = await Uniform.create({ staff_id, item_type, size, item_description, issued_date: new Date() });
    await writeAudit("ISSUE_UNIFORM", req, staff_id, "uniforms", null, { item_type, size });
    await Notification.create({ user_id: staff_id, message: `New uniform issued: ${item_type}${size ? ` (${size})` : ""}.`, type: "info" });

    res.status(201).json({ success: true, message: "Uniform issued.", data: item });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.returnUniform = async (req, res) => {
  try {
    const item = await Uniform.findByIdAndUpdate(
      req.params.id, { status: "returned", returned_date: new Date() }, { new: true }
    );
    if (!item) return res.status(404).json({ success: false, message: "Item not found." });
    await writeAudit("RETURN_UNIFORM", req, item.staff_id, "uniforms", { status: "active" }, { status: "returned" });
    res.json({ success: true, message: "Uniform returned.", data: item });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error." });
  }
};

// ─── Notifications (Admin Broadcast) ─────────────────────────────
exports.broadcastNotification = async (req, res) => {
  try {
    const { message, type, role, branch_id } = req.body;
    if (!message?.trim())
      return res.status(400).json({ success: false, message: "Message cannot be empty." });
    if (message.length > 500)
      return res.status(400).json({ success: false, message: "Message too long (max 500 chars)." });

    const query = { is_active: true };
    if (role) query.role = role;
    if (branch_id) query.branch_id = branch_id;

    const users = await User.find(query).select("_id");
    if (users.length === 0)
      return res.status(400).json({ success: false, message: "No matching users found." });

    await Notification.insertMany(users.map(u => ({
      user_id: u._id, message, type: type || "broadcast",
    })));

    await writeAudit("BROADCAST_NOTIFICATION", req, null, "notifications", null, { message, role, branch_id, recipients: users.length });
    res.json({ success: true, message: `Broadcast sent to ${users.length} users.` });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error." });
  }
};

// ─── Audit Logs ───────────────────────────────────────────────────
exports.getAuditLogs = async (req, res) => {
  try {
    const { module, admin_id, target_id, action, from, to, limit = 100 } = req.query;
    const query = {};
    if (module) query.module = module;
    if (admin_id) query.admin_id = admin_id;
    if (target_id) query.target_id = target_id;
    if (action) query.action = { $regex: action, $options: "i" };
    if (from || to) {
      query.timestamp = {};
      if (from) query.timestamp.$gte = new Date(from);
      if (to) query.timestamp.$lte = new Date(to);
    }

    const logs = await AuditLog.find(query)
      .populate("admin_id", "name email role")
      .sort({ timestamp: -1 })
      .limit(Math.min(parseInt(limit), 500));

    res.json({ success: true, data: logs, count: logs.length });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error." });
  }
};

// ─── Session Management ───────────────────────────────────────────
exports.getActiveSessions = async (req, res) => {
  try {
    const sessions = await Session.find({ is_revoked: false, expires_at: { $gt: new Date() } })
      .populate("user_id", "name email role")
      .sort({ login_at: -1 })
      .limit(200);
    res.json({ success: true, data: sessions });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.revokeUserSessions = async (req, res) => {
  try {
    await revokeAllSessions(req.params.id);
    await writeAudit("REVOKE_SESSIONS", req, req.params.id, "sessions", null, { all_revoked: true });
    res.json({ success: true, message: "All sessions revoked." });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error." });
  }
};

// ─── Attendance CSV export (payroll-oriented) ─────────────────────
const COUNTABLE_ATT = ["present", "late", "forced", "supervisor_assisted"];

exports.exportAttendance = async (req, res) => {
  try {
    const now = new Date();
    const month = parseInt(req.query.month, 10) || now.getMonth() + 1;
    const year = parseInt(req.query.year, 10) || now.getFullYear();
    const debounceKey = `${req.user._id}:${year}:${month}`;
    const last = recentAttendanceExports.get(debounceKey);
    if (last && Date.now() - last < EXPORT_DEBOUNCE_MS) {
      return res.status(429).json({
        success: false,
        message: "An export for this month was just generated. Wait a moment before downloading again.",
      });
    }

    const start = new Date(year, month - 1, 1);
    const end = new Date(year, month, 0);
    const startStr = start.toISOString().slice(0, 10);
    const endStr = end.toISOString().slice(0, 10);

    const staffList = await User.find({ role: "staff" }).populate("branch_id", "name").select("name branch_id").lean();

    const rows = [];
    for (const u of staffList) {
      const profile = await StaffProfile.findOne({ user_id: u._id }).lean();
      const staffNum = profile?.staff_id || "—";
      const type = profile?.type || "—";
      const daysPresent = await Attendance.countDocuments({
        staff_id: u._id,
        date: { $gte: startStr, $lte: endStr },
        status: { $in: COUNTABLE_ATT },
      });
      const paidDays = type === "contract" ? "-" : String(daysPresent);

      rows.push({
        staff_id: staffNum,
        name: u.name,
        branch: u.branch_id?.name || "—",
        attendance_type: type,
        days_present: daysPresent,
        days_worked: daysPresent,
        paid_days: paidDays,
      });
    }

    const esc = (v) => {
      const s = v == null ? "" : String(v);
      if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };
    const header = ["Staff ID", "Name", "Branch", "Attendance Type", "Days Present", "Days Worked", "Paid Days"];
    const lines = [header.map(esc).join(",")];
    for (const r of rows) {
      lines.push(
        [r.staff_id, r.name, r.branch, r.attendance_type, r.days_present, r.days_worked, r.paid_days]
          .map(esc)
          .join(",")
      );
    }
    const csv = lines.join("\r\n");

    await writeAudit("EXPORT_ATTENDANCE", req, null, "attendance", null, {
      month,
      year,
      row_count: rows.length,
    });

    recentAttendanceExports.set(debounceKey, Date.now());

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="attendance-export-${year}-${String(month).padStart(2, "0")}.csv"`
    );
    res.send(`\ufeff${csv}`);
  } catch (err) {
    console.error("[exportAttendance]", err);
    res.status(500).json({ success: false, message: "Server error." });
  }
};

// ─── Uniform grid (admin) ─────────────────────────────────────────
exports.getUniformsGrid = async (req, res) => {
  try {
    const { branch_id, item_type, search } = req.query;
    const q = {};
    if (item_type) q.item_type = item_type;

    if (search && String(search).trim()) {
      const ids = await matchUserIdsByStaffSearch(search);
      if (!ids.length) return res.json({ success: true, data: [] });
      q.staff_id = { $in: ids };
    }

    let items = await Uniform.find(q)
      .populate({ path: "staff_id", select: "name branch_id", populate: { path: "branch_id", select: "name" } })
      .sort({ issued_date: -1 })
      .limit(500)
      .lean();

    if (branch_id) items = items.filter((i) => i.staff_id?.branch_id?._id?.toString() === branch_id);

    const now = Date.now();
    const MS_YEAR = 365 * 86400000;
    const data = items.map((i) => {
      let overdue_return = false;
      if (i.status === "active" && i.issued_date && now - new Date(i.issued_date).getTime() > MS_YEAR)
        overdue_return = true;
      const needs_attention = i.status === "replacement_pending" || i.status === "lost" || overdue_return;
      return { ...i, overdue_return, needs_attention };
    });

    const uids = [...new Set(data.map((i) => i.staff_id?._id).filter(Boolean))];
    if (uids.length) {
      const profs = await StaffProfile.find({ user_id: { $in: uids } }).select("user_id staff_id").lean();
      const ypMap = Object.fromEntries(profs.map((p) => [p.user_id.toString(), p.staff_id]));
      for (const i of data) {
        const id = i.staff_id?._id?.toString();
        if (id) i.yp_staff_id = ypMap[id] ?? null;
      }
    }

    res.json({ success: true, data });
  } catch (err) {
    console.error("[getUniformsGrid]", err);
    res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.requestUniformReplacement = async (req, res) => {
  try {
    const { reason } = req.body;
    const item = await Uniform.findById(req.params.id).populate("staff_id", "name");
    if (!item) return res.status(404).json({ success: false, message: "Uniform record not found." });

    const before = { status: item.status, notes: item.notes };
    item.status = "replacement_pending";
    item.notes = `${item.notes || ""} [Replacement requested: ${(reason || "n/a").slice(0, 400)}]`.trim();
    await item.save();

    await writeAudit("UNIFORM_REPLACEMENT_REQUEST", req, item._id, "uniforms", before, {
      status: item.status,
      notes: item.notes,
    });
    await Notification.create({
      user_id: item.staff_id._id || item.staff_id,
      message: `Uniform replacement requested for ${item.item_type}. See HR.`,
      type: "warning",
    });

    res.json({ success: true, message: "Marked as replacement pending.", data: item });
  } catch (err) {
    console.error("[requestUniformReplacement]", err);
    res.status(500).json({ success: false, message: "Server error." });
  }
};

// ─── Leave accrual (admin visibility) ─────────────────────────────
exports.getLeaveAccrualReport = async (req, res) => {
  try {
    const staffUsers = await User.find({ role: "staff", is_active: true }).select("name").lean();
    const data = [];

    for (const u of staffUsers) {
      const p = await StaffProfile.findOne({ user_id: u._id });
      if (!p) continue;
      const join = new Date(p.join_date);
      const now = new Date();
      const monthsWorked = Math.max(
        0,
        (now.getFullYear() - join.getFullYear()) * 12 + (now.getMonth() - join.getMonth())
      );
      const earnedLeaveDays = Math.round(monthsWorked * 1.75 * 100) / 100;

      data.push({
        staff_id: p.staff_id,
        name: u.name,
        months_worked: monthsWorked,
        earned_leave_days: earnedLeaveDays,
        join_date: p.join_date,
      });
    }

    const { search } = req.query;
    let out = data;
    if (search && String(search).trim()) {
      const t = String(search).trim().toLowerCase();
      out = data.filter(
        (row) =>
          String(row.staff_id || "").toLowerCase().includes(t) || String(row.name || "").toLowerCase().includes(t)
      );
    }

    res.json({ success: true, data: out });
  } catch (err) {
    console.error("[getLeaveAccrualReport]", err);
    res.status(500).json({ success: false, message: "Server error." });
  }
};
