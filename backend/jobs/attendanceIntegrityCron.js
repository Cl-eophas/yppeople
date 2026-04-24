const cron = require("node-cron");
const { ensureAttendanceCompleteForPeriod } = require("../services/attendanceIntegrityService");

/**
 * Daily integrity job: fill missing attendance rows for yesterday (absent/off/leave/unscheduled).
 * Ensures payroll month extraction never misses staff-day records.
 */
function scheduleIntegrityCron() {
  if (process.env.DISABLE_INTEGRITY_CRON === "true") {
    console.log("⏸  Attendance integrity cron disabled (DISABLE_INTEGRITY_CRON)");
    return;
  }
  // 00:10 daily server time
  cron.schedule("10 0 * * *", async () => {
    try {
      const d = new Date();
      d.setDate(d.getDate() - 1);
      const ymd = d.toISOString().slice(0, 10);
      const r = await ensureAttendanceCompleteForPeriod({ startStr: ymd, endStr: ymd, branchId: null });
      console.log(`[attendanceIntegrityCron] ${ymd}: created=${r.created} scanned_users=${r.scanned_users}`);
    } catch (e) {
      console.error("[attendanceIntegrityCron]", e);
    }
  });
  console.log("✅  Attendance integrity cron: daily 00:10 (fills yesterday)");
}

module.exports = { scheduleIntegrityCron };

