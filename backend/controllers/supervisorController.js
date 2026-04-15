
const User = require("../models/User");
const StaffProfile = require("../models/StaffProfile");
const Attendance = require("../models/Attendance");
const Leave = require("../models/Leave");
const Notification = require("../models/Notification");
const LeaveBalance = require("../models/LeaveBalance");
const { isWithinGeofence } = require("../utils/geo");
const { getTodayString } = require("../utils/dateHelpers");
const { contractStaffMayWork } = require("../utils/contractCheck");
const { emitAttendanceChanged } = require("../realtime");

// ─── GET /supervisor/dashboard ─────────────────────────────────
exports.getDashboard = async (req, res) => {
  try {
    const branchId = req.user.branch_id;
    if (!branchId)
      return res.status(400).json({ success: false, message: "Supervisor not assigned to a branch." });

    const today = getTodayString();

    // Staff + supervisors in this branch (supervisor is an elevated staff member)
    const branchStaff = await User.find({
      branch_id: branchId,
      role: { $in: ["staff", "supervisor"] },
      is_active: true,
    }).select("_id name role");
    const staffIds = branchStaff.map(s => s._id);

    // Today attendance for branch
    const todayAtt = await Attendance.find({ staff_id: { $in: staffIds }, date: today });
    const clockedIn = todayAtt.filter(a => a.clock_in && !a.clock_out).length;
    const clockedOut = todayAtt.filter(a => a.clock_out).length;
    const absent = Math.max(0, staffIds.length - todayAtt.filter(a => a.clock_in).length);

    // Pending leave in branch
    const pendingLeave = await Leave.find({
      staff_id: { $in: staffIds },
      status: { $in: ["pending", "pending_document"] },
    }).countDocuments();

    res.json({
      success: true,
      data: {
        branch_id: branchId,
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
    const branchId = req.user.branch_id;
    const staff = await User.find({ branch_id: branchId, role: { $in: ["staff", "supervisor"] } }).select("-password");
    const profiles = await StaffProfile.find({ user_id: { $in: staff.map(s => s._id) } });
    const profileMap = {};
    profiles.forEach(p => { profileMap[p.user_id.toString()] = p; });

    const result = staff.map(s => ({
      ...s.toObject(),
      profile: profileMap[s._id.toString()] || null,
    }));

    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error." });
  }
};

// ─── GET /supervisor/attendance/today ─────────────────────────
exports.getTodayAttendance = async (req, res) => {
  try {
    const branchId = req.user.branch_id;
    const today = getTodayString();

    const branchStaff = await User.find({
      branch_id: branchId,
      role: { $in: ["staff", "supervisor"] },
      is_active: true,
    }).select("_id name role");
    const staffIds = branchStaff.map(s => s._id);
    const staffMap = {};
    branchStaff.forEach(s => { staffMap[s._id.toString()] = s.name; });

    const records = await Attendance.find({ staff_id: { $in: staffIds }, date: today });
    const recordMap = {};
    records.forEach(r => { recordMap[r.staff_id.toString()] = r; });

    const result = branchStaff.map(s => ({
      staff_id: s._id,
      name: s.name,
      attendance: recordMap[s._id.toString()] || null,
      status: recordMap[s._id.toString()]
        ? recordMap[s._id.toString()].status
        : "absent",
    }));

    res.json({ success: true, data: result, date: today });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error." });
  }
};

// ─── POST /supervisor/attendance/manual-entry ─────────────────
// Supervisor can clock in a staff member manually (e.g. device failure)
exports.manualClockIn = async (req, res) => {
  try {
    const { staff_id, reason } = req.body;
    if (!staff_id || !reason)
      return res.status(400).json({ success: false, message: "staff_id and reason required." });

    // Verify staff is in supervisor's branch
    const staffUser = await User.findOne({ _id: staff_id, branch_id: req.user.branch_id, role: "staff" });
    if (!staffUser)
      return res.status(403).json({ success: false, message: "Staff not in your branch." });

    const contractOk = await contractStaffMayWork(staff_id);
    if (!contractOk.ok)
      return res.status(403).json({ success: false, message: contractOk.message });

    const today = getTodayString();
    const existing = await Attendance.findOne({ staff_id, date: today });
    if (existing?.clock_in)
      return res.status(400).json({ success: false, message: "Staff already clocked in today." });

    const now = new Date();
    const shiftStart = new Date(now);
    shiftStart.setHours(8, 0, 0, 0);

    const record = existing
      ? await Attendance.findByIdAndUpdate(existing._id,
          { clock_in: now, shift_start: shiftStart, status: "supervisor_assisted", is_supervisor_entry: true, notes: reason },
          { new: true })
      : await Attendance.create({
          staff_id, date: today, clock_in: now, shift_start: shiftStart,
          status: "supervisor_assisted", is_supervisor_entry: true, notes: reason,
        });

    // Notify the staff member
    await Notification.create({
      user_id: staff_id,
      message: `Supervisor manually clocked you in at ${now.toLocaleTimeString()}. Reason: ${reason}`,
      type: "attendance",
    });

    emitAttendanceChanged({ branch_id: req.user.branch_id, date: today });

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
    if (!staff_id || !reason)
      return res.status(400).json({ success: false, message: "staff_id and reason required." });

    const staffUser = await User.findOne({ _id: staff_id, branch_id: req.user.branch_id, role: "staff" });
    if (!staffUser)
      return res.status(403).json({ success: false, message: "Staff not in your branch." });

    const today = getTodayString();
    const record = await Attendance.findOne({ staff_id, date: today });
    if (!record?.clock_in)
      return res.status(400).json({ success: false, message: "No clock-in record for today." });
    if (record.clock_out)
      return res.status(400).json({ success: false, message: "Already clocked out." });

    const now = new Date();
    record.clock_out = now;
    record.is_forced = true;
    record.notes = (record.notes ? record.notes + " | " : "") + `Force clock-out by supervisor: ${reason}`;
    await record.save();

    await Notification.create({
      user_id: staff_id,
      message: `Supervisor clocked you out at ${now.toLocaleTimeString()}. Reason: ${reason}`,
      type: "attendance",
    });

    emitAttendanceChanged({ branch_id: req.user.branch_id, date: today });

    res.json({ success: true, message: "Force clock-out recorded.", data: record });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error." });
  }
};

// ─── GET /supervisor/leave ─────────────────────────────────────
exports.getBranchLeave = async (req, res) => {
  try {
    const branchId = req.user.branch_id;
    const branchStaff = await User.find({
      branch_id: branchId,
      role: { $in: ["staff", "supervisor"] },
    }).select("_id name");
    const staffIds = branchStaff.map(s => s._id);
    const staffMap = {};
    branchStaff.forEach(s => { staffMap[s._id.toString()] = s.name; });

    const { status } = req.query;
    const query = { staff_id: { $in: staffIds } };
    if (status) query.status = status;

    const leaves = await Leave.find(query).sort({ createdAt: -1 });
    const result = leaves.map(l => ({
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
    const branchId = req.user.branch_id;

    const leave = await Leave.findById(id).populate("staff_id", "branch_id name");
    if (!leave)
      return res.status(404).json({ success: false, message: "Leave request not found." });

    // Verify staff is in supervisor's branch
    if (leave.staff_id.branch_id?.toString() !== branchId?.toString())
      return res.status(403).json({ success: false, message: "Staff not in your branch." });

    // Sick leave requires document before approval
    if (leave.type.startsWith("sick") && !leave.medical_document)
      return res.status(400).json({ success: false, message: "Cannot approve sick leave without medical document." });

    if (leave.status === "approved")
      return res.status(400).json({ success: false, message: "Leave already approved." });

    leave.status = "approved";
    leave.approved_by = req.user._id;
    leave.approved_at = new Date();
    await leave.save();

    await Notification.create({
      user_id: leave.staff_id._id,
      message: `Your ${leave.type.replace("_", " ")} leave (${new Date(leave.start_date).toLocaleDateString()} – ${new Date(leave.end_date).toLocaleDateString()}) has been approved.`,
      type: "leave",
    });

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
    if (!reason)
      return res.status(400).json({ success: false, message: "Rejection reason required." });

    const branchId = req.user.branch_id;
    const leave = await Leave.findById(id).populate("staff_id", "branch_id name _id");
    if (!leave)
      return res.status(404).json({ success: false, message: "Leave request not found." });

    if (leave.staff_id.branch_id?.toString() !== branchId?.toString())
      return res.status(403).json({ success: false, message: "Staff not in your branch." });

    // Refund balance on rejection
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

    res.json({ success: true, message: "Leave rejected and balance refunded.", data: leave });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error." });
  }
};

// ─── POST /supervisor/notify ───────────────────────────────────
exports.sendNotification = async (req, res) => {
  try {
    const { staff_id, message, type } = req.body;
    if (!message?.trim())
      return res.status(400).json({ success: false, message: "Message required." });

    const branchId = req.user.branch_id;

    if (staff_id) {
      // Individual
      const staffUser = await User.findOne({ _id: staff_id, branch_id: branchId, role: "staff" });
      if (!staffUser)
        return res.status(403).json({ success: false, message: "Staff not in your branch." });

      await Notification.create({ user_id: staff_id, message, type: type || "info" });
      return res.json({ success: true, message: "Notification sent." });
    }

    // Branch broadcast
    const branchStaff = await User.find({ branch_id: branchId, role: "staff", is_active: true }).select("_id");
    await Notification.insertMany(branchStaff.map(s => ({
      user_id: s._id, message, type: "broadcast",
    })));

    res.json({ success: true, message: `Broadcast sent to ${branchStaff.length} staff members.` });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error." });
  }
};
