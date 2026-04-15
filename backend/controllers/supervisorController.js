const User = require("../models/User");
const StaffProfile = require("../models/StaffProfile");
const Attendance = require("../models/Attendance");
const Leave = require("../models/Leave");
const Notification = require("../models/Notification");
const LeaveBalance = require("../models/LeaveBalance");
const Uniform = require("../models/Uniform");
const Meeting = require("../models/Meeting");
const AuditLog = require("../models/AuditLog");
const { sendMail } = require("../utils/mailer");
const { getTodayString } = require("../utils/dateHelpers");
const { contractStaffMayWork } = require("../utils/contractCheck");
const { emitAttendanceChanged } = require("../realtime");
const getIP = (req) => req.ip || req.headers["x-forwarded-for"]?.split(",")[0] || "unknown";
const getUA = (req) => req.headers["user-agent"] || "unknown";

const getBranchScope = (req) => {
  if (["general_supervisor", "admin"].includes(req.user.role)) {
    return req.query.branch_id ? { branch_id: req.query.branch_id } : {};
  }
  return req.user.branch_id ? { branch_id: req.user.branch_id } : null;
};

const getContactLinks = (phone) => {
  const normalized = String(phone || "").replace(/\s+/g, "");
  if (!normalized) return { whatsapp: null, phone: null };
  const dial = normalized.startsWith("+")
    ? normalized
    : normalized.startsWith("0")
      ? `+254${normalized.slice(1)}`
      : normalized;
  return {
    whatsapp: `https://wa.me/${dial.replace("+", "")}`,
    phone: `tel:${normalized}`,
  };
};

const writeAudit = async (action, req, targetId, targetType, before, after, metadata = {}) => {
  try {
    await AuditLog.create({
      action,
      admin_id: req.user._id,
      target_id: targetId || null,
      target_type: targetType,
      module: targetType,
      ip_address: getIP(req),
      user_agent: getUA(req),
      before,
      after,
      metadata,
    });
  } catch (err) {
    console.error("[supervisor.audit]", err.message);
  }
};

// ─── GET /supervisor/dashboard ─────────────────────────────────
exports.getDashboard = async (req, res) => {
  try {
    const scope = getBranchScope(req);
    if (!scope) {
      return res.status(400).json({ success: false, message: "Supervisor not assigned to a branch." });
    }

    const today = getTodayString();
    const branchStaff = await User.find({
      ...scope,
      role: { $in: ["staff", "supervisor"] },
      is_active: true,
    }).select("_id name role");
    const staffIds = branchStaff.map((s) => s._id);

    const todayAtt = await Attendance.find({ staff_id: { $in: staffIds }, date: today });
    const clockedIn = todayAtt.filter((a) => a.clock_in && !a.clock_out).length;
    const clockedOut = todayAtt.filter((a) => a.clock_out).length;
    const absent = Math.max(0, staffIds.length - todayAtt.filter((a) => a.clock_in).length);

    const pendingLeave = await Leave.find({
      staff_id: { $in: staffIds },
      status: { $in: ["pending", "pending_document"] },
    }).countDocuments();

    res.json({
      success: true,
      data: {
        branch_id: req.user.role === "supervisor" ? req.user.branch_id : null,
        total_staff: staffIds.length,
        today: { date: today, clocked_in: clockedIn, clocked_out: clockedOut, absent },
        pending_leave_requests: pendingLeave,
      },
    });
  } catch (err) {
    console.error("[supervisor.getDashboard]", err);
    res.status(500).json({ success: false, message: "Server error." });
  }
};

// ─── GET /supervisor/staff ─────────────────────────────────────
exports.getBranchStaff = async (req, res) => {
  try {
    const scope = getBranchScope(req);
    if (!scope) {
      return res.status(400).json({ success: false, message: "Supervisor not assigned to a branch." });
    }

    const staff = await User.find({ ...scope, role: { $in: ["staff", "supervisor"] } }).select("-password");
    const profiles = await StaffProfile.find({ user_id: { $in: staff.map((s) => s._id) } });
    const profileMap = {};
    profiles.forEach((p) => { profileMap[p.user_id.toString()] = p; });

    const result = staff.map((s) => ({
      ...s.toObject(),
      profile: profileMap[s._id.toString()] || null,
      contact: getContactLinks(s.phone),
    }));

    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error." });
  }
};

// ─── GET /supervisor/attendance/today ─────────────────────────
exports.getTodayAttendance = async (req, res) => {
  try {
    const scope = getBranchScope(req);
    if (!scope) {
      return res.status(400).json({ success: false, message: "Supervisor not assigned to a branch." });
    }
    const today = getTodayString();

    const branchStaff = await User.find({
      ...scope,
      role: { $in: ["staff", "supervisor"] },
      is_active: true,
    }).select("_id name role phone");
    const staffIds = branchStaff.map((s) => s._id);

    const records = await Attendance.find({ staff_id: { $in: staffIds }, date: today });
    const recordMap = {};
    records.forEach((r) => { recordMap[r.staff_id.toString()] = r; });

    const result = branchStaff.map((s) => ({
      staff_id: s._id,
      name: s.name,
      attendance: recordMap[s._id.toString()] || null,
      status: recordMap[s._id.toString()] ? recordMap[s._id.toString()].status : "absent",
      contact: getContactLinks(s.phone),
    }));

    res.json({ success: true, data: result, date: today });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error." });
  }
};

// ─── POST /supervisor/attendance/manual-entry ─────────────────
exports.manualClockIn = async (req, res) => {
  try {
    const { staff_id, reason } = req.body;
    if (!staff_id || !reason) {
      return res.status(400).json({ success: false, message: "staff_id and reason required." });
    }

    const scope = getBranchScope(req);
    if (!scope) return res.status(400).json({ success: false, message: "Supervisor not assigned to a branch." });
    const staffUser = await User.findOne({ _id: staff_id, ...scope, role: "staff" });
    if (!staffUser) {
      return res.status(403).json({ success: false, message: "Staff not in your branch." });
    }

    const contractOk = await contractStaffMayWork(staff_id);
    if (!contractOk.ok) return res.status(403).json({ success: false, message: contractOk.message });

    const today = getTodayString();
    const existing = await Attendance.findOne({ staff_id, date: today });
    if (existing?.clock_in) {
      return res.status(400).json({ success: false, message: "Staff already clocked in today." });
    }

    const now = new Date();
    const shiftStart = new Date(now);
    shiftStart.setHours(8, 0, 0, 0);

    const record = existing
      ? await Attendance.findByIdAndUpdate(
          existing._id,
          { clock_in: now, shift_start: shiftStart, status: "supervisor_assisted", is_supervisor_entry: true, notes: reason },
          { new: true }
        )
      : await Attendance.create({
          staff_id,
          date: today,
          clock_in: now,
          shift_start: shiftStart,
          status: "supervisor_assisted",
          is_supervisor_entry: true,
          notes: reason,
        });

    await Notification.create({
      user_id: staff_id,
      message: `Supervisor manually clocked you in at ${now.toLocaleTimeString()}. Reason: ${reason}`,
      type: "attendance",
    });
    await writeAudit(
      "SUPERVISOR_MANUAL_CLOCKIN",
      req,
      record._id,
      "attendance",
      null,
      { staff_id, date: today, reason }
    );

    if (staffUser.branch_id) emitAttendanceChanged({ branch_id: staffUser.branch_id, date: today });

    res.json({ success: true, message: "Manual clock-in recorded.", data: record });
  } catch (err) {
    console.error("[manualClockIn]", err);
    res.status(500).json({ success: false, message: "Server error." });
  }
};

// ─── POST /supervisor/attendance/force-clockout ───────────────
exports.forceClockOut = async (req, res) => {
  try {
    const { staff_id, reason } = req.body;
    if (!staff_id || !reason) {
      return res.status(400).json({ success: false, message: "staff_id and reason required." });
    }

    const scope = getBranchScope(req);
    if (!scope) return res.status(400).json({ success: false, message: "Supervisor not assigned to a branch." });
    const staffUser = await User.findOne({ _id: staff_id, ...scope, role: "staff" });
    if (!staffUser) {
      return res.status(403).json({ success: false, message: "Staff not in your branch." });
    }

    const today = getTodayString();
    const record = await Attendance.findOne({ staff_id, date: today });
    if (!record?.clock_in) {
      return res.status(400).json({ success: false, message: "No clock-in record for today." });
    }
    if (record.clock_out) {
      return res.status(400).json({ success: false, message: "Already clocked out." });
    }

    const now = new Date();
    record.clock_out = now;
    record.is_forced = true;
    record.notes = (record.notes ? `${record.notes} | ` : "") + `Force clock-out by supervisor: ${reason}`;
    await record.save();

    await Notification.create({
      user_id: staff_id,
      message: `Supervisor clocked you out at ${now.toLocaleTimeString()}. Reason: ${reason}`,
      type: "attendance",
    });
    await writeAudit(
      "SUPERVISOR_FORCE_CLOCKOUT",
      req,
      record._id,
      "attendance",
      null,
      { staff_id, date: today, reason }
    );

    if (staffUser.branch_id) emitAttendanceChanged({ branch_id: staffUser.branch_id, date: today });

    res.json({ success: true, message: "Force clock-out recorded.", data: record });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error." });
  }
};

// ─── GET /supervisor/leave ─────────────────────────────────────
exports.getBranchLeave = async (req, res) => {
  try {
    const scope = getBranchScope(req);
    if (!scope) {
      return res.status(400).json({ success: false, message: "Supervisor not assigned to a branch." });
    }

    const branchStaff = await User.find({
      ...scope,
      role: { $in: ["staff", "supervisor"] },
    }).select("_id name");
    const staffIds = branchStaff.map((s) => s._id);
    const staffMap = {};
    branchStaff.forEach((s) => { staffMap[s._id.toString()] = s.name; });

    const { status } = req.query;
    const query = { staff_id: { $in: staffIds } };
    if (status) query.status = status;

    const leaves = await Leave.find(query).sort({ createdAt: -1 });
    const result = leaves.map((l) => ({
      ...l.toObject(),
      staff_name: staffMap[l.staff_id.toString()] || "Unknown",
    }));

    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error." });
  }
};

// ─── PATCH /supervisor/leave/:id/approve ──────────────────────
exports.approveLeave = async (req, res) => {
  try {
    const { id } = req.params;
    const scope = getBranchScope(req);

    const leave = await Leave.findById(id).populate("staff_id", "branch_id name");
    if (!leave) {
      return res.status(404).json({ success: false, message: "Leave request not found." });
    }

    if (scope?.branch_id && leave.staff_id.branch_id?.toString() !== String(scope.branch_id)) {
      return res.status(403).json({ success: false, message: "Staff not in your branch." });
    }

    if (leave.type.startsWith("sick") && !leave.medical_document) {
      return res.status(400).json({ success: false, message: "Cannot approve sick leave without medical document." });
    }
    if (leave.status === "approved") {
      return res.status(400).json({ success: false, message: "Leave already approved." });
    }

    leave.status = "approved";
    leave.approved_by = req.user._id;
    leave.approved_at = new Date();
    await leave.save();

    await Notification.create({
      user_id: leave.staff_id._id,
      message: `Your ${leave.type.replace("_", " ")} leave (${new Date(leave.start_date).toLocaleDateString()} – ${new Date(leave.end_date).toLocaleDateString()}) has been approved.`,
      type: "leave",
    });
    await writeAudit(
      "SUPERVISOR_APPROVE_LEAVE",
      req,
      leave._id,
      "leave",
      { status: "pending" },
      { status: "approved" }
    );

    res.json({ success: true, message: "Leave approved.", data: leave });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error." });
  }
};

// ─── PATCH /supervisor/leave/:id/reject ───────────────────────
exports.rejectLeave = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ success: false, message: "Rejection reason required." });

    const scope = getBranchScope(req);
    const leave = await Leave.findById(id).populate("staff_id", "branch_id name _id");
    if (!leave) {
      return res.status(404).json({ success: false, message: "Leave request not found." });
    }
    if (scope?.branch_id && leave.staff_id.branch_id?.toString() !== String(scope.branch_id)) {
      return res.status(403).json({ success: false, message: "Staff not in your branch." });
    }

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

    await Notification.create({
      user_id: leave.staff_id._id,
      message: `Your ${leave.type.replace("_", " ")} leave request was rejected. Reason: ${reason}`,
      type: "leave",
    });
    await writeAudit(
      "SUPERVISOR_REJECT_LEAVE",
      req,
      leave._id,
      "leave",
      { status: "pending" },
      { status: "rejected", reason }
    );

    res.json({ success: true, message: "Leave rejected and balance refunded.", data: leave });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error." });
  }
};

// ─── POST /supervisor/notify ───────────────────────────────────
exports.sendNotification = async (req, res) => {
  try {
    const { staff_id, message, type } = req.body;
    if (!message?.trim()) return res.status(400).json({ success: false, message: "Message required." });

    const scope = getBranchScope(req);

    if (staff_id) {
      const staffUser = await User.findOne({ _id: staff_id, ...(scope || {}), role: "staff" });
      if (!staffUser) return res.status(403).json({ success: false, message: "Staff not in your branch." });

      await Notification.create({ user_id: staff_id, message, type: type || "info" });
      await writeAudit(
        "SUPERVISOR_NOTIFY_STAFF",
        req,
        staff_id,
        "notifications",
        null,
        { type: type || "info", message }
      );
      return res.json({ success: true, message: "Notification sent." });
    }

    const branchStaff = await User.find({ ...(scope || {}), role: "staff", is_active: true }).select("_id");
    await Notification.insertMany(
      branchStaff.map((s) => ({
        user_id: s._id,
        message,
        type: "broadcast",
      }))
    );

    res.json({ success: true, message: `Broadcast sent to ${branchStaff.length} staff members.` });
    await writeAudit(
      "SUPERVISOR_BROADCAST",
      req,
      null,
      "notifications",
      null,
      { message, recipients: branchStaff.length }
    );
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.getTeamContacts = async (req, res) => {
  try {
    const scope = getBranchScope(req);
    if (!scope) return res.status(400).json({ success: false, message: "Supervisor not assigned to a branch." });

    const users = await User.find({ ...scope, role: "staff", is_active: true })
      .select("name phone email staffId branch_id")
      .populate("branch_id", "name")
      .lean();

    const data = users.map((u) => ({
      id: u._id,
      name: u.name,
      staffId: u.staffId || null,
      email: u.email || null,
      phone: u.phone || null,
      branch: u.branch_id?.name || null,
      contact: getContactLinks(u.phone),
    }));

    return res.json({ success: true, data, count: data.length });
  } catch (err) {
    console.error("[getTeamContacts]", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.scheduleMeeting = async (req, res) => {
  try {
    const { title, agenda, scheduled_for, branch_id, participant_ids } = req.body;
    const when = new Date(scheduled_for);
    if (Number.isNaN(when.getTime()) || when <= new Date()) {
      return res.status(400).json({ success: false, message: "scheduled_for must be a future datetime." });
    }

    const meeting = await Meeting.create({
      title: String(title).trim(),
      agenda: String(agenda).trim(),
      scheduled_for: when,
      branch_id: branch_id || null,
      created_by: req.user._id,
      participants: Array.isArray(participant_ids) ? participant_ids : [],
    });

    const participants = await User.find({ _id: { $in: meeting.participants } }).select("_id name email");
    if (participants.length) {
      await Notification.insertMany(
        participants.map((p) => ({
          user_id: p._id,
          type: "meeting",
          message: `Meeting scheduled: "${meeting.title}" on ${when.toLocaleString()}.`,
        }))
      );
      await Promise.all(
        participants.map((p) =>
          sendMail({
            to: p.email,
            subject: `Meeting: ${meeting.title}`,
            html: `<p>Hello ${p.name},</p><p>You have a meeting scheduled on ${when.toLocaleString()}.</p><p><strong>${meeting.title}</strong></p><p>${meeting.agenda}</p>`,
            text: `Hello ${p.name},\n\nYou have a meeting scheduled on ${when.toLocaleString()}.\n\n${meeting.title}\n${meeting.agenda}\n`,
          })
        )
      );
    }

    await writeAudit(
      "SCHEDULE_MEETING",
      req,
      meeting._id,
      "meeting",
      null,
      { title: meeting.title, scheduled_for: meeting.scheduled_for, participants: meeting.participants.length }
    );

    return res.status(201).json({ success: true, message: "Meeting scheduled.", data: meeting });
  } catch (err) {
    console.error("[scheduleMeeting]", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.getMeetings = async (req, res) => {
  try {
    const scope = getBranchScope(req);
    if (!scope) return res.status(400).json({ success: false, message: "Supervisor not assigned to a branch." });

    const query = {};
    if (scope.branch_id) query.branch_id = scope.branch_id;
    if (req.query.status) query.status = req.query.status;

    const meetings = await Meeting.find(query)
      .sort({ scheduled_for: -1 })
      .populate("created_by", "name email")
      .populate("participants", "name email staffId")
      .populate("branch_id", "name")
      .lean();
    return res.json({ success: true, data: meetings, count: meetings.length });
  } catch (err) {
    console.error("[getMeetings]", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.assignUniform = async (req, res) => {
  try {
    const { staff_id, item_type, size, item_description } = req.body;
    const scope = getBranchScope(req);
    if (!scope) return res.status(400).json({ success: false, message: "Supervisor not assigned to a branch." });
    const staff = await User.findOne({ _id: staff_id, ...(scope || {}), role: "staff" }).select("_id name");
    if (!staff) return res.status(404).json({ success: false, message: "Staff not found in scope." });

    const active = await Uniform.findOne({ staff_id, item_type, status: "active" });
    if (active) {
      return res.status(400).json({ success: false, message: `Active ${item_type} already assigned to this staff.` });
    }

    const uniform = await Uniform.create({
      staff_id,
      item_type,
      size,
      item_description,
      issued_date: new Date(),
      notes: `Issued by ${req.user.role}`,
    });

    await Notification.create({
      user_id: staff_id,
      type: "uniform",
      message: `New uniform assigned: ${item_type}${size ? ` (${size})` : ""}.`,
    });

    await writeAudit(
      "ASSIGN_UNIFORM",
      req,
      uniform._id,
      "uniform",
      null,
      { staff_id, item_type, size }
    );

    return res.status(201).json({ success: true, message: "Uniform assigned.", data: uniform });
  } catch (err) {
    console.error("[assignUniform]", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.getUniformHistory = async (req, res) => {
  try {
    const scope = getBranchScope(req);
    if (!scope) return res.status(400).json({ success: false, message: "Supervisor not assigned to a branch." });
    const users = await User.find({ ...(scope || {}), role: "staff" }).select("_id");
    const ids = users.map((u) => u._id);
    const rows = await Uniform.find({ staff_id: { $in: ids } })
      .sort({ issued_date: -1 })
      .populate("staff_id", "name staffId phone")
      .lean();
    return res.json({ success: true, data: rows, count: rows.length });
  } catch (err) {
    console.error("[getUniformHistory]", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};
