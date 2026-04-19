
const Attendance = require("../models/Attendance");
const User = require("../models/User");
const StaffProfile = require("../models/StaffProfile");
const { isWithinGeofence } = require("../utils/geo");
const { requiresFixedBranch } = require("../utils/branchEmployment");
const { getTodayString } = require("../utils/dateHelpers");
const { emitAttendanceChanged } = require("../realtime");
const { shiftStartDateTime } = require("../utils/shiftTime");
const shiftService = require("../services/shiftService");
const Notification = require("../models/Notification");
const SecurityEvent = require("../models/SecurityEvent");
const ForceClockRequest = require("../models/ForceClockRequest");
const { logAttendanceEvent } = require("../utils/attendanceClock");

async function persistClockIn({ staffId, branchOid, today, now, locIn, shiftStart, status, lateMinutes, source }) {
  const payload = {
    clock_in: now,
    branch_id: branchOid,
    location_in: locIn,
    shift_start: shiftStart,
    status,
    late_minutes: lateMinutes,
    is_supervisor_entry: false,
    source: source || "self",
  };
  const existing = await Attendance.findOne({ staff_id: staffId, date: today });
  if (existing?.clock_in) {
    const err = new Error("Already clocked in today.");
    err.statusCode = 400;
    throw err;
  }
  try {
    if (existing?._id) {
      const doc = await Attendance.findByIdAndUpdate(existing._id, payload, { new: true });
      logAttendanceEvent("clock_in_update", { staff_id: String(staffId), date: today, branch_id: String(branchOid) });
      return doc;
    }
    const doc = await Attendance.create({
      staff_id: staffId,
      branch_id: branchOid,
      date: today,
      ...payload,
    });
    logAttendanceEvent("clock_in_create", { staff_id: String(staffId), date: today, branch_id: String(branchOid) });
    return doc;
  } catch (err) {
    if (err.code === 11000) {
      const again = await Attendance.findOne({ staff_id: staffId, date: today });
      if (again?.clock_in) {
        const dup = new Error("Already clocked in today.");
        dup.statusCode = 400;
        throw dup;
      }
      if (again) {
        const doc = await Attendance.findByIdAndUpdate(again._id, payload, { new: true });
        logAttendanceEvent("clock_in_retry", { staff_id: String(staffId), date: today });
        return doc;
      }
    }
    throw err;
  }
}

exports.clockIn = async (req, res) => {
  try {
    const staffId = req.user._id;
    const { latitude, longitude } = req.body;

    if (latitude === undefined || longitude === undefined) {
      return res.status(400).json({ success: false, message: "GPS coordinates required." });
    }

    const user = await User.findById(staffId).populate("branch_id");
    if (!user) return res.status(404).json({ success: false, message: "User not found." });

    if (user.status !== "approved" || !user.is_active) {
      return res.status(403).json({ success: false, message: "Only approved, active accounts can clock in." });
    }

    if (!["staff", "supervisor"].includes(user.role)) {
      return res.status(403).json({ success: false, message: "Clock-in is only available for staff roles." });
    }

    if (["staff", "supervisor"].includes(user.role) && !user.employment_type) {
      const sp = await StaffProfile.findOne({ user_id: staffId });
      if (sp) {
        user.employment_type = user.role === "supervisor" ? "supervisor" : sp.type;
        await user.save({ validateModifiedOnly: true });
      }
    }
    if (["staff", "supervisor"].includes(user.role) && !user.employment_type) {
      return res.status(403).json({
        success: false,
        message: "Account is missing employment_type. Ask an administrator to complete your assignment.",
      });
    }

    if (requiresFixedBranch(user.employment_type) && !user.branch_id) {
      return res.status(400).json({ success: false, message: "Not assigned to a branch." });
    }
    if (user.employment_type === "casual" && !user.branch_id) {
      return res.status(400).json({
        success: false,
        code: "BRANCH_REQUIRED",
        message:
          "Select your work branch before clock-in. Use GET /api/staff/branches/available then PUT /api/staff/my-branch.",
      });
    }

    const branch = user.branch_id;
    const { withinFence, distance } = isWithinGeofence(
      parseFloat(latitude),
      parseFloat(longitude),
      branch.latitude,
      branch.longitude,
      branch.radius_meters
    );

    if (!withinFence) {
      return res.status(400).json({
        success: false,
        message: `You are ${distance}m away. Must be within ${branch.radius_meters}m of ${branch.name}.`,
        distance,
      });
    }

    const today = getTodayString();
    const existing = await Attendance.findOne({ staff_id: staffId, date: today });
    if (existing?.clock_in) {
      return res.status(400).json({ success: false, message: "Already clocked in today." });
    }

    const now = new Date();
    const scheduled = await shiftService.getClockWindowForToday(staffId, today);

    let shiftStart;
    let status;
    let lateMinutes = 0;

    if (scheduled) {
      shiftStart = shiftStartDateTime(scheduled.shift_date, scheduled.start_time);
      if (!shiftStart) {
        shiftStart = new Date(now);
        status = "present";
      } else {
        lateMinutes = Math.max(0, Math.floor((now.getTime() - shiftStart.getTime()) / 60000));
        status = lateMinutes > 0 ? "late" : "present";
      }
    } else {
      shiftStart = new Date(now);
      const dst = String(branch.default_shift_start_time || "08:00");
      const m = dst.match(/^(\d{1,2}):(\d{2})$/);
      const hh = m ? Math.min(23, Math.max(0, parseInt(m[1], 10))) : 8;
      const mm = m ? Math.min(59, Math.max(0, parseInt(m[2], 10))) : 0;
      shiftStart.setHours(hh, mm, 0, 0);
      status = "unscheduled";
    }

    const locIn = { latitude: parseFloat(latitude), longitude: parseFloat(longitude) };
    const branchOid = branch._id || branch;

    let attendance;
    try {
      attendance = await persistClockIn({
        staffId,
        branchOid,
        today,
        now,
        locIn,
        shiftStart,
        status,
        lateMinutes,
        source: "self",
      });
    } catch (e) {
      if (e.statusCode === 400) {
        return res.status(400).json({ success: false, message: e.message });
      }
      throw e;
    }

    if (status === "late") {
      const escalatedUsers = await User.find({
        role: { $in: ["general_supervisor", "admin"] },
        is_active: true,
      }).select("_id");

      if (escalatedUsers.length) {
        await Notification.insertMany(
          escalatedUsers.map((u) => ({
            user_id: u._id,
            type: "attendance",
            message: `Late alert: ${user.name} (${user.phone || "no phone"}) is ${lateMinutes} minute(s) late — ${branch.name}.`,
          }))
        );
      }

      const { emitLateAlert } = require("../realtime");
      emitLateAlert({
        date: today,
        branch_id: branch._id,
        branch_name: branch.name,
        staff_id: user._id,
        staff_name: user.name,
        phone: user.phone || null,
        minutes_late: lateMinutes,
      });

      await SecurityEvent.create({
        type: "anomalous_action",
        user_id: user._id,
        metadata: {
          category: "late_escalation",
          name: user.name,
          phone: user.phone || null,
          minutes_late: lateMinutes,
          date: today,
        },
      });
    }

    emitAttendanceChanged({ branch_id: user.branch_id._id || user.branch_id, date: today });

    res.json({ success: true, message: "Clocked in successfully.", data: attendance });
  } catch (err) {
    console.error("[clockIn]", err);
    res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.clockOut = async (req, res) => {
  try {
    const staffId = req.user._id;
    const { latitude, longitude } = req.body;

    if (latitude === undefined || longitude === undefined) {
      return res.status(400).json({ success: false, message: "GPS coordinates required." });
    }

    const user = await User.findById(staffId).populate("branch_id");
    if (!user) return res.status(404).json({ success: false, message: "User not found." });
    if (user.status !== "approved" || !user.is_active) {
      return res.status(403).json({ success: false, message: "Only approved, active accounts can clock out." });
    }

    if (!user.branch_id) {
      return res.status(400).json({ success: false, message: "Not assigned to a branch." });
    }
    const branchOid = user.branch_id._id || user.branch_id;

    const { withinFence, distance } = isWithinGeofence(
      parseFloat(latitude),
      parseFloat(longitude),
      user.branch_id.latitude,
      user.branch_id.longitude,
      user.branch_id.radius_meters
    );

    if (!withinFence) {
      return res.status(400).json({
        success: false,
        message: `You are ${distance}m away. Must be within ${user.branch_id.radius_meters}m to clock out.`,
        distance,
      });
    }

    const today = getTodayString();
    const attendance = await Attendance.findOne({ staff_id: staffId, date: today });
    if (!attendance?.clock_in) {
      return res.status(400).json({ success: false, message: "No clock-in found for today." });
    }
    if (attendance.clock_out) {
      return res.status(400).json({ success: false, message: "Already clocked out today." });
    }

    const now = new Date();
    attendance.clock_out = now;
    attendance.location_out = { latitude: parseFloat(latitude), longitude: parseFloat(longitude) };
    if (!attendance.branch_id) attendance.branch_id = branchOid;
    await attendance.save();
    logAttendanceEvent("clock_out", { staff_id: String(staffId), date: today, branch_id: String(branchOid) });

    emitAttendanceChanged({ branch_id: user.branch_id._id || user.branch_id, date: today });

    res.json({ success: true, message: "Clocked out successfully.", data: attendance });
  } catch (err) {
    console.error("[clockOut]", err);
    res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.getHistory = async (req, res) => {
  try {
    const staffId = req.user._id;
    const { month, year } = req.query;
    const now = new Date();
    const m =
      month !== undefined && month !== "" && !Number.isNaN(parseInt(month, 10))
        ? parseInt(month, 10) - 1
        : now.getMonth();
    const y =
      year !== undefined && year !== "" && !Number.isNaN(parseInt(year, 10))
        ? parseInt(year, 10)
        : now.getFullYear();

    const startDate = new Date(y, m, 1).toISOString().slice(0, 10);
    const endDate = new Date(y, m + 1, 0).toISOString().slice(0, 10);

    const records = await Attendance.find({
      staff_id: staffId,
      date: { $gte: startDate, $lte: endDate },
    }).sort({ date: 1 });

    const summary = {
      total_days: records.length,
      present: records.filter((r) => r.status === "present").length,
      late: records.filter((r) => r.status === "late").length,
      forced: records.filter((r) => r.status === "forced" || r.is_forced).length,
      on_leave: records.filter((r) => r.status === "leave").length,
    };

    res.json({ success: true, data: records, summary });
  } catch (err) {
    console.error("[getHistory]", err);
    res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.requestForcedClockIn = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select("name branch_id");
    if (!user) return res.status(404).json({ success: false, message: "User not found." });

    const today = getTodayString();
    const { reason } = req.body;
    const reasonText = String(reason || "").trim();
    if (!reasonText) {
      return res.status(400).json({ success: false, message: "Reason is required." });
    }

    const att = await Attendance.findOne({ staff_id: user._id, date: today });
    if (att?.clock_in) {
      return res.status(400).json({ success: false, message: "You are already clocked in for today." });
    }

    const existingPending = await ForceClockRequest.findOne({
      user_id: user._id,
      date: today,
      status: "pending",
    });
    if (existingPending) {
      return res.status(400).json({ success: false, message: "A forced clock-in request is already pending." });
    }

    const request = await ForceClockRequest.create({
      user_id: user._id,
      branch_id: user.branch_id || null,
      date: today,
      reason: reasonText,
      status: "pending",
    });

    const recipients = await User.find({
      role: "admin",
      is_active: true,
    }).select("_id");

    if (recipients.length) {
      await Notification.insertMany(
        recipients.map((r) => ({
          user_id: r._id,
          type: "attendance",
          message: `Forced clock-in request from ${user.name} for ${today}.`,
        }))
      );
    }

    return res.status(201).json({
      success: true,
      message: "Forced clock-in request submitted and pending admin approval.",
      data: request,
    });
  } catch (err) {
    console.error("[requestForcedClockIn]", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};
