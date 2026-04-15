
const Attendance = require("../models/Attendance");
const User = require("../models/User");
const { isWithinGeofence } = require("../utils/geo");
const { getTodayString } = require("../utils/dateHelpers");
const { contractStaffMayWork } = require("../utils/contractCheck");
const { emitAttendanceChanged } = require("../realtime");
const { shiftStartDateTime } = require("../utils/shiftTime");
const shiftService = require("../services/shiftService");

exports.clockIn = async (req, res) => {
  try {
    const staffId = req.user._id;
    const { latitude, longitude } = req.body;

    if (latitude === undefined || longitude === undefined) {
      return res.status(400).json({ success: false, message: "GPS coordinates required." });
    }

    const contractOk = await contractStaffMayWork(staffId);
    if (!contractOk.ok) {
      return res.status(403).json({ success: false, message: contractOk.message });
    }

    const user = await User.findById(staffId).populate("branch_id");
    if (!user.branch_id) {
      return res.status(400).json({ success: false, message: "Not assigned to a branch." });
    }

    const branch = user.branch_id;
    const { withinFence, distance } = isWithinGeofence(
      parseFloat(latitude), parseFloat(longitude),
      branch.latitude, branch.longitude, branch.radius_meters
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
    const allowUnscheduled = process.env.ALLOW_UNSCHEDULED_CLOCK_IN === "true";

    let shiftStart;
    let status;

    if (scheduled) {
      shiftStart = shiftStartDateTime(scheduled.shift_date, scheduled.start_time);
      if (!shiftStart) {
        return res.status(500).json({ success: false, message: "Invalid shift configuration." });
      }
      const windowMin = Number(branch.clock_in_window_minutes || 60);
      const deadline = new Date(shiftStart.getTime() + Math.max(10, windowMin) * 60 * 1000);
      if (now < shiftStart || now > deadline) {
        return res.status(400).json({
          success: false,
          message: `Clock-in is only allowed from ${scheduled.start_time} until ${Math.max(10, windowMin)} minute(s) after shift start.`,
        });
      }
      status = now > shiftStart ? "late" : "present";
    } else if (allowUnscheduled) {
      shiftStart = new Date(now);
      const dst = String(branch.default_shift_start_time || "08:00");
      const m = dst.match(/^(\d{1,2}):(\d{2})$/);
      const hh = m ? Math.min(23, Math.max(0, parseInt(m[1], 10))) : 8;
      const mm = m ? Math.min(59, Math.max(0, parseInt(m[2], 10))) : 0;
      shiftStart.setHours(hh, mm, 0, 0);
      status = "unscheduled";
    } else {
      return res.status(403).json({
        success: false,
        message: "No scheduled shift for today. Contact your supervisor to assign a shift.",
      });
    }
    const locIn = { latitude: parseFloat(latitude), longitude: parseFloat(longitude) };

    const attendance = existing
      ? await Attendance.findByIdAndUpdate(existing._id,
          { clock_in: now, location_in: locIn, shift_start: shiftStart, status, is_supervisor_entry: false },
          { new: true })
      : await Attendance.create({
          staff_id: staffId, date: today, clock_in: now,
          location_in: locIn, shift_start: shiftStart, status, is_supervisor_entry: false,
        });

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

    const contractOk = await contractStaffMayWork(staffId);
    if (!contractOk.ok) {
      return res.status(403).json({ success: false, message: contractOk.message });
    }

    const user = await User.findById(staffId).populate("branch_id");
    if (!user.branch_id) {
      return res.status(400).json({ success: false, message: "Not assigned to a branch." });
    }

    const { withinFence, distance } = isWithinGeofence(
      parseFloat(latitude), parseFloat(longitude),
      user.branch_id.latitude, user.branch_id.longitude, user.branch_id.radius_meters
    );

    if (!withinFence) {
      return res.status(400).json({
        success: false,
        message: `You are ${distance}m away. Must be within ${user.branch_id.radius_meters}m to clock out.`,
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
    await attendance.save();

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
      present: records.filter(r => r.status === "present").length,
      late: records.filter(r => r.status === "late").length,
      forced: records.filter(r => r.status === "forced" || r.is_forced).length,
      on_leave: records.filter(r => r.status === "leave").length,
    };

    res.json({ success: true, data: records, summary });
  } catch (err) {
    console.error("[getHistory]", err);
    res.status(500).json({ success: false, message: "Server error." });
  }
};
