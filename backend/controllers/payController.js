const Attendance = require("../models/Attendance");
const StaffProfile = require("../models/StaffProfile");
const User = require("../models/User");
const { isPayrollUnlocked } = require("../utils/profileVerification");

exports.getPaySummary = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user || !isPayrollUnlocked(user)) {
      return res.status(403).json({
        success: false,
        message: "Complete profile verification to access payroll",
      });
    }

    const now = new Date();
    const month = parseInt(req.query.month, 10) || now.getMonth() + 1;
    const year = parseInt(req.query.year, 10) || now.getFullYear();
    const start = new Date(year, month - 1, 1);
    const end = new Date(year, month, 0);
    const startStr = start.toISOString().slice(0, 10);
    const endStr = end.toISOString().slice(0, 10);

    const records = await Attendance.find({
      staff_id: req.user._id,
      date: { $gte: startStr, $lte: endStr },
      status: { $in: ["present", "late", "forced", "supervisor_assisted"] },
    });
    const profile = await StaffProfile.findOne({ user_id: req.user._id });
    const days_worked = records.length;
    const rate_per_day = (Number(user.pay_rate || 0) > 0 ? Number(user.pay_rate) : Number(profile?.pay_rate || 0)) || 0;

    res.json({
      success: true,
      data: {
        period: { month, year },
        days_worked,
        rate_per_day,
        estimated_pay: days_worked * rate_per_day,
        currency: "KES",
        note: "Estimate based on recorded attendance and your current daily rate.",
      },
    });
  } catch (err) {
    console.error("[getPaySummary]", err);
    res.status(500).json({ success: false, message: "Server error." });
  }
};
