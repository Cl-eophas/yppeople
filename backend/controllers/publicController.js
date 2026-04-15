const Attendance = require("../models/Attendance");
const { getTodayString } = require("../utils/dateHelpers");
const { seedDatabase } = require("../seed");

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

/**
 * One-time / on-demand seed for test environments.
 * Protected by SEED_ADMIN_KEY (env). Intentionally not tied to user auth so a fresh DB can be initialized.
 *
 * POST /api/public/seed
 * Header: x-seed-key: <key>   OR body: { key: "<key>" }
 */
exports.seed = async (req, res) => {
  try {
    const expected = process.env.SEED_ADMIN_KEY;
    if (!expected) return res.status(404).json({ success: false, message: "Not available." });

    const provided = req.headers["x-seed-key"] || req.body?.key;
    if (!provided || String(provided) !== String(expected)) {
      return res.status(403).json({ success: false, message: "Forbidden." });
    }

    const summary = await seedDatabase({ connect: false, disconnect: false });
    return res.json({
      success: true,
      message: "Seed complete.",
      data: summary,
    });
  } catch (err) {
    console.error("[public.seed]", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};
