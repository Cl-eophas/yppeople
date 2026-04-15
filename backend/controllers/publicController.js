const Attendance = require("../models/Attendance");
const { getTodayString } = require("../utils/dateHelpers");

/** Public aggregate for marketing hero — no auth. */
exports.getLandingStats = async (req, res) => {
  try {
    const date = getTodayString();
    const clocked_in_today = await Attendance.countDocuments({
      date,
      clock_in: { $ne: null },
    });
    res.json({
      success: true,
      data: { date, clocked_in_today },
    });
  } catch (err) {
    console.error("[getLandingStats]", err);
    res.status(500).json({ success: false, message: "Server error." });
  }
};
