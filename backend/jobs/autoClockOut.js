const cron = require("node-cron");
const Attendance = require("../models/Attendance");
const { syncHoursWorkedOnDocument } = require("../utils/attendanceHours");

cron.schedule("*/15 * * * *", async () => {
  try {
    const now = new Date();
    const nineHoursAgo = new Date(now.getTime() - 9 * 60 * 60 * 1000);

    const overdueRecords = await Attendance.find({
      clock_in: { $lte: nineHoursAgo },
      $or: [{ clock_out: { $exists: false } }, { clock_out: null }],
    });

    if (overdueRecords.length > 0) {
      for (const record of overdueRecords) {
        record.clock_out = new Date(record.clock_in.getTime() + 9 * 60 * 60 * 1000);
        record.auto_clocked_out = true;
        record.notes = `${record.notes || ""} [Auto clocked-out after 9 hours]`.trim();
        syncHoursWorkedOnDocument(record);
        await record.save();
      }
      console.log(`[AutoClockOut] Auto clocked-out ${overdueRecords.length} staff`);
    }
  } catch (err) {
    console.error("[AutoClockOut] Error:", err.message);
  }
});

console.log("✅ Auto clock-out cron job running (every 15 min)");
