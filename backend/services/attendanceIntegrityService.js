const Attendance = require("../models/Attendance");
const User = require("../models/User");
const StaffProfile = require("../models/StaffProfile");
const Leave = require("../models/Leave");
const OffDay = require("../models/OffDay");
const Shift = require("../models/Shift");
const { enumerateDatesInclusive, pickLeaveForDay } = require("../utils/attendanceAnalytics");

const parseYMD = (dateStr) => {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d);
};

function isWeekend(dateStr) {
  const dt = parseYMD(dateStr);
  const day = dt.getDay();
  return day === 0 || day === 6;
}

async function loadOffDaysForRange(staffIds, startStr, endStr) {
  const docs = await OffDay.find({ staff_id: { $in: staffIds }, date: { $gte: startStr, $lte: endStr } })
    .select("staff_id date")
    .lean();
  const map = new Map();
  for (const d of docs) {
    const id = d.staff_id.toString();
    if (!map.has(id)) map.set(id, new Set());
    map.get(id).add(d.date);
  }
  return map;
}

async function loadShiftsForRange(staffIds, startStr, endStr) {
  const docs = await Shift.find({ staff_id: { $in: staffIds }, shift_date: { $gte: startStr, $lte: endStr } })
    .select("staff_id shift_date branch_id")
    .lean();
  const map = new Map();
  for (const d of docs) {
    const id = d.staff_id.toString();
    if (!map.has(id)) map.set(id, new Map());
    map.get(id).set(d.shift_date, d.branch_id);
  }
  return map;
}

/**
 * Ensure every active approved worker has an Attendance doc for every day in [startStr,endStr].
 * - Preserves existing docs (never overwrites clock_in/clock_out).
 * - Inserts missing docs with status: leave | off | absent | unscheduled.
 */
async function ensureAttendanceCompleteForPeriod({ startStr, endStr, branchId = null }) {
  const dates = enumerateDatesInclusive(startStr, endStr);
  if (!dates.length) return { ok: true, created: 0, scanned_users: 0 };

  const workerQuery = branchId
    ? { branch_id: branchId, role: { $in: ["staff", "supervisor"] }, is_active: true, status: "approved" }
    : { role: { $in: ["staff", "supervisor"] }, is_active: true, status: "approved" };

  const users = await User.find(workerQuery).select("_id branch_id role").limit(5000).lean();
  const staffIds = users.map((u) => u._id);
  if (!staffIds.length) return { ok: true, created: 0, scanned_users: 0 };

  const profs = await StaffProfile.find({ user_id: { $in: staffIds } }).select("user_id type").lean();
  const empById = Object.fromEntries(profs.map((p) => [p.user_id.toString(), p.type]));

  const periodStartDt = new Date(startStr + "T00:00:00.000Z");
  const periodEndDt = new Date(endStr + "T23:59:59.999Z");
  const leavesAll = await Leave.find({
    staff_id: { $in: staffIds },
    status: "approved",
    start_date: { $lte: periodEndDt },
    end_date: { $gte: periodStartDt },
  }).lean();
  const leavesByStaff = new Map();
  for (const l of leavesAll) {
    const id = l.staff_id.toString();
    if (!leavesByStaff.has(id)) leavesByStaff.set(id, []);
    leavesByStaff.get(id).push(l);
  }

  const [offMap, shiftMap] = await Promise.all([
    loadOffDaysForRange(staffIds, startStr, endStr),
    loadShiftsForRange(staffIds, startStr, endStr),
  ]);

  const existing = await Attendance.find({ staff_id: { $in: staffIds }, date: { $gte: startStr, $lte: endStr } })
    .select("staff_id date clock_in status")
    .lean();
  const existKey = new Set(existing.map((a) => `${a.staff_id.toString()}_${a.date}`));

  const inserts = [];
  for (const u of users) {
    const uid = u._id.toString();
    const emp = empById[uid] || (u.role === "supervisor" ? "supervisor" : "casual");
    const staffLeaves = leavesByStaff.get(uid) || [];
    const staffOff = offMap.get(uid) || new Set();
    const staffShiftDays = shiftMap.get(uid) || new Map();
    for (const ds of dates) {
      const key = `${uid}_${ds}`;
      if (existKey.has(key)) continue;

      const dayLeaves = staffLeaves.filter((l) => {
        const s = new Date(l.start_date);
        const e = new Date(l.end_date);
        s.setHours(0, 0, 0, 0);
        e.setHours(23, 59, 59, 999);
        const cur = parseYMD(ds);
        return cur >= s && cur <= e;
      });
      const leave = dayLeaves.length ? pickLeaveForDay(dayLeaves, ds) : null;

      const hasOff = staffOff.has(ds) || isWeekend(ds);
      const shiftBranch = staffShiftDays.get(ds) || null;
      const hasShift = Boolean(shiftBranch);

      let status = "unscheduled";
      if (leave) status = "leave";
      else if (hasOff) status = "off";
      else if (hasShift) status = "absent";
      else status = "unscheduled";

      inserts.push({
        staff_id: u._id,
        branch_id: shiftBranch || u.branch_id || null,
        date: ds,
        clock_in: null,
        clock_out: null,
        status,
        notes: status === "absent" ? "Auto-filled: scheduled shift but no clock-in." : "Auto-filled for payroll completeness.",
        source: "self",
        matchStatus: hasShift ? "matched" : "unscheduled",
      });
    }
  }

  if (!inserts.length) return { ok: true, created: 0, scanned_users: users.length };

  // InsertMany with ordered:false so duplicates (race) don't fail whole batch.
  let created = 0;
  try {
    const r = await Attendance.insertMany(inserts, { ordered: false });
    created = r.length;
  } catch (e) {
    // In case of E11000 duplicates, count successful inserts if provided.
    created = Array.isArray(e.insertedDocs) ? e.insertedDocs.length : 0;
  }
  return { ok: true, created, scanned_users: users.length };
}

module.exports = { ensureAttendanceCompleteForPeriod };

