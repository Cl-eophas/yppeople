const Shift = require("../models/Shift");
const OffDay = require("../models/OffDay");
const User = require("../models/User");
const StaffProfile = require("../models/StaffProfile");
const Notification = require("../models/Notification");
const {
  addShiftHours,
  todayYmd,
  parseHm,
  shiftStartDateTime,
  prevYmd,
} = require("../utils/shiftTime");

async function sendShiftNotification(userId, message) {
  try {
    await Notification.create({ user_id: userId, message, type: "shift" });
  } catch (e) {
    console.error("[shift notification]", e.message);
  }
}

async function assertStaffInBranch(staffId, branchId) {
  const staff = await User.findById(staffId).select("branch_id role is_active");
  if (!staff?.is_active) return { ok: false, code: 404, message: "Staff user not found or inactive." };
  if (!["staff", "supervisor"].includes(staff.role))
    return { ok: false, code: 400, message: "Shifts can only be assigned to staff or supervisors." };
  if (!staff.branch_id || staff.branch_id.toString() !== branchId.toString())
    return { ok: false, code: 400, message: "Staff does not belong to the specified branch." };
  return { ok: true, staff };
}

async function hasOffDay(staffId, dateYmd) {
  const o = await OffDay.findOne({ staff_id: staffId, date: dateYmd }).lean();
  return !!o;
}

/** Contract: max 6 consecutive assigned shift days before this date (7th would violate 1 off / 7 days). */
async function contractConsecutiveShiftCountBefore(staffId, shiftDateYmd) {
  let d = prevYmd(shiftDateYmd);
  let consecutive = 0;
  while (d) {
    if (await hasOffDay(staffId, d)) break;
    const sh = await Shift.findOne({ staff_id: staffId, shift_date: d }).lean();
    if (!sh) break;
    consecutive += 1;
    d = prevYmd(d);
  }
  return consecutive;
}

async function validateEmploymentShiftRules(staffId, shiftDateYmd) {
  const profile = await StaffProfile.findOne({ user_id: staffId }).lean();
  const type = profile?.type || "casual";

  if (await hasOffDay(staffId, shiftDateYmd))
    return { ok: false, code: 400, message: "Staff has a recorded off day on this date." };

  if (type === "contract") {
    const n = await contractConsecutiveShiftCountBefore(staffId, shiftDateYmd);
    if (n >= 6)
      return {
        ok: false,
        code: 400,
        message: "Contract staff must have at least one day off in each 7-day window. Too many consecutive shifts.",
      };
  }

  return { ok: true, employment_type: type };
}

function assertFutureOrTodayDate(shiftDateYmd) {
  const t = todayYmd();
  if (shiftDateYmd < t) return { ok: false, code: 400, message: "Cannot assign shifts in the past." };
  return { ok: true };
}

async function assertNoDuplicateShift(staffId, shiftDateYmd) {
  const exists = await Shift.findOne({ staff_id: staffId, shift_date: shiftDateYmd }).lean();
  if (exists) return { ok: false, code: 409, message: "This staff member already has a shift on that date.", existing: exists };
  return { ok: true };
}

function assertBranchAccess(actor, branchId) {
  if (actor.role === "admin") return { ok: true };
  if (actor.role === "supervisor") {
    if (!actor.branch_id || actor.branch_id.toString() !== branchId.toString())
      return { ok: false, code: 403, message: "Supervisors may only manage shifts in their own branch." };
    return { ok: true };
  }
  return { ok: false, code: 403, message: "Forbidden." };
}

/**
 * @param {object} params
 * @param {import('mongoose').Types.ObjectId} params.staff_id
 * @param {import('mongoose').Types.ObjectId} params.branch_id
 * @param {string} params.shift_date YYYY-MM-DD
 * @param {string} params.start_time HH:mm
 * @param {object} params.actor user doc
 * @param {boolean} [params.skipDuplicate] bulk: skip if duplicate
 */
async function assignShift({ staff_id, branch_id, shift_date, start_time, actor, skipDuplicate = false }) {
  if (!parseHm(start_time)) return { ok: false, code: 400, message: "Invalid start_time (use HH:mm)." };

  const branchOk = assertBranchAccess(actor, branch_id);
  if (!branchOk.ok) return branchOk;

  const dateOk = assertFutureOrTodayDate(shift_date);
  if (!dateOk.ok) return dateOk;

  const belong = await assertStaffInBranch(staff_id, branch_id);
  if (!belong.ok) return belong;

  const rules = await validateEmploymentShiftRules(staff_id, shift_date);
  if (!rules.ok) return rules;

  const dup = await assertNoDuplicateShift(staff_id, shift_date);
  if (!dup.ok) {
    if (skipDuplicate) return { ok: true, skipped: true, reason: dup.message };
    return dup;
  }

  const end = addShiftHours(start_time);
  if (!end) return { ok: false, code: 400, message: "Could not compute end time." };

  const shift = await Shift.create({
    staff_id,
    branch_id,
    shift_date,
    start_time,
    end_time: end.end_time,
    end_next_day: end.end_next_day,
    assigned_by: actor._id,
  });

  await sendShiftNotification(
    staff_id,
    `Shift assigned: ${shift_date} ${start_time}–${end.end_time}${end.end_next_day ? " (+1 day)" : ""}.`
  );

  return { ok: true, shift };
}

async function updateShift(shiftId, updates, actor) {
  const shift = await Shift.findById(shiftId);
  if (!shift) return { ok: false, code: 404, message: "Shift not found." };

  const branchOk = assertBranchAccess(actor, shift.branch_id);
  if (!branchOk.ok) return branchOk;

  const nextDate = updates.shift_date !== undefined ? updates.shift_date : shift.shift_date;
  const nextStart = updates.start_time !== undefined ? updates.start_time : shift.start_time;

  if (updates.start_time !== undefined && !parseHm(nextStart))
    return { ok: false, code: 400, message: "Invalid start_time (use HH:mm)." };

  if (updates.shift_date !== undefined) {
    const dateOk = assertFutureOrTodayDate(nextDate);
    if (!dateOk.ok) return dateOk;
  }

  if (updates.shift_date !== undefined || updates.staff_id !== undefined) {
    const staffId = updates.staff_id || shift.staff_id;
    const branchId = shift.branch_id;
    const belong = await assertStaffInBranch(staffId, branchId);
    if (!belong.ok) return belong;
    const rules = await validateEmploymentShiftRules(staffId, nextDate);
    if (!rules.ok) return rules;
    if (updates.shift_date !== undefined && updates.shift_date !== shift.shift_date) {
      const dup = await Shift.findOne({ staff_id, shift_date: nextDate, _id: { $ne: shift._id } });
      if (dup) return { ok: false, code: 409, message: "Duplicate shift for that date." };
    }
    if (
      updates.staff_id !== undefined &&
      updates.staff_id.toString() !== shift.staff_id.toString()
    ) {
      const dupOther = await Shift.findOne({
        staff_id: updates.staff_id,
        shift_date: nextDate,
        _id: { $ne: shift._id },
      });
      if (dupOther) return { ok: false, code: 409, message: "Target staff already has a shift on this date." };
    }
  }

  const before = {
    shift_date: shift.shift_date,
    start_time: shift.start_time,
    end_time: shift.end_time,
    staff_id: shift.staff_id,
  };

  if (updates.staff_id) shift.staff_id = updates.staff_id;
  if (updates.shift_date) shift.shift_date = updates.shift_date;
  if (updates.start_time) {
    shift.start_time = updates.start_time;
    const end = addShiftHours(shift.start_time);
    shift.end_time = end.end_time;
    shift.end_next_day = end.end_next_day;
  }

  await shift.save();

  await sendShiftNotification(shift.staff_id, `Shift updated: ${shift.shift_date} ${shift.start_time}–${shift.end_time}.`);

  return { ok: true, shift, before };
}

async function deleteShift(shiftId, actor) {
  const shift = await Shift.findById(shiftId);
  if (!shift) return { ok: false, code: 404, message: "Shift not found." };
  const branchOk = assertBranchAccess(actor, shift.branch_id);
  if (!branchOk.ok) return branchOk;
  if (shift.shift_date < todayYmd()) return { ok: false, code: 400, message: "Cannot delete past shifts." };
  await shift.deleteOne();
  return { ok: true, shift };
}

/** ISO week helpers for reliever off-day cap (1–3 per Mon–Sun week, local) */
function weekBoundsForDate(ymd) {
  const d = new Date(ymd + "T12:00:00");
  if (Number.isNaN(d.getTime())) return null;
  const day = d.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const mon = new Date(d);
  mon.setDate(d.getDate() + mondayOffset);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  const fmt = (x) => {
    const y = x.getFullYear();
    const m = String(x.getMonth() + 1).padStart(2, "0");
    const da = String(x.getDate()).padStart(2, "0");
    return `${y}-${m}-${da}`;
  };
  return { week_start: fmt(mon), week_end: fmt(sun) };
}

async function countOffDaysInWeek(staffId, ymd) {
  const b = weekBoundsForDate(ymd);
  if (!b) return 0;
  return OffDay.countDocuments({
    staff_id: staffId,
    date: { $gte: b.week_start, $lte: b.week_end },
  });
}

async function recordOffDay({ staff_id, date, actor, note }) {
  const staff = await User.findById(staff_id).select("branch_id role is_active");
  if (!staff?.is_active || !["staff", "supervisor"].includes(staff.role))
    return { ok: false, code: 400, message: "Invalid staff user." };
  if (!staff.branch_id) return { ok: false, code: 400, message: "Staff has no branch." };

  const branchOk = assertBranchAccess(actor, staff.branch_id);
  if (!branchOk.ok) return branchOk;

  const profile = await StaffProfile.findOne({ user_id: staff_id }).lean();
  const type = profile?.type || "casual";

  if (type === "casual") return { ok: false, code: 400, message: "Casual staff do not use scheduled off-day records." };
  if (type === "contract")
    return { ok: false, code: 400, message: "Contract off days are derived from shift patterns; use shift planning instead." };

  const existing = await OffDay.findOne({ staff_id, date }).lean();
  if (existing) return { ok: false, code: 409, message: "Off day already recorded for this date." };

  const n = await countOffDaysInWeek(staff_id, date);
  if (n >= 3) return { ok: false, code: 400, message: "Reliever off-day cap reached (max 3 per week)." };

  const doc = await OffDay.create({ staff_id, date, recorded_by: actor._id, note });
  return { ok: true, offDay: doc };
}

function getClockWindowForToday(staffId, todayStr) {
  return Shift.findOne({ staff_id, shift_date: todayStr }).lean();
}

module.exports = {
  assignShift,
  updateShift,
  deleteShift,
  recordOffDay,
  assertBranchAccess,
  shiftStartDateTime,
  getClockWindowForToday,
  sendShiftNotification,
  weekBoundsForDate,
  countOffDaysInWeek,
};
