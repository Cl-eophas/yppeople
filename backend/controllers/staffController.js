const User = require("../models/User");
const StaffProfile = require("../models/StaffProfile");
const Attendance = require("../models/Attendance");
const LeaveBalance = require("../models/LeaveBalance");
const Notification = require("../models/Notification");
const Shift = require("../models/Shift");
const { getTodayString } = require("../utils/dateHelpers");
const { verificationPayload, resolveVerificationStatus } = require("../utils/profileVerification");

exports.getDashboard = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).populate("branch_id", "name");
    const profile = await StaffProfile.findOne({ user_id: req.user._id });
    const today = getTodayString();
    const att = await Attendance.findOne({ staff_id: req.user._id, date: today });
    const balance = await LeaveBalance.findOne({ staff_id: req.user._id });

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const startStr = monthStart.toISOString().slice(0, 10);
    const endStr = monthEnd.toISOString().slice(0, 10);

    const monthAtt = await Attendance.find({
      staff_id: req.user._id,
      date: { $gte: startStr, $lte: endStr },
      status: { $in: ["present", "late", "forced", "supervisor_assisted"] },
    });
    const days_worked = monthAtt.length;
    const pay_rate = profile?.pay_rate || 0;
    const estimated_pay = days_worked * pay_rate;

    const unread_count = await Notification.countDocuments({ user_id: req.user._id, is_read: false });
    const latest = await Notification.find({ user_id: req.user._id, is_read: false })
      .sort({ createdAt: -1 })
      .limit(5);

    const todayShift = await Shift.findOne({ staff_id: req.user._id, shift_date: today })
      .select("start_time end_time")
      .lean();

    const v = resolveVerificationStatus(user);
    const verification_banner =
      !user.profileCompleted
        ? "⚠️ Complete your profile"
        : v.status === "pending"
          ? "⏳ Waiting for admin verification"
          : v.status === "rejected"
            ? `❌ Verification failed: ${v.reason || "See admin feedback"}`
            : v.status === "verified"
              ? "✔ Verified"
              : "⚠️ Your profile is incomplete. Complete verification to enable payroll.";

    return res.json({
      success: true,
      data: {
        staff: {
          name: user.name,
          staff_id: profile?.staff_id,
          type: profile?.type,
          branch: user.branch_id ? { id: user.branch_id._id, name: user.branch_id.name } : null,
        },
        verification: {
          ...verificationPayload(user),
          banner: verification_banner,
        },
        today: {
          date: today,
          shift: todayShift
            ? { start: todayShift.start_time, end: todayShift.end_time }
            : null,
          clocked_in: !!att?.clock_in,
          clocked_out: !!att?.clock_out,
          clock_in_time: att?.clock_in || null,
          clock_out_time: att?.clock_out || null,
          status: att?.status || "absent",
        },
        month_summary: {
          days_worked,
          pay_rate,
          estimated_pay,
        },
        leave_balances: {
          annual: balance ? parseFloat(balance.annual_balance.toFixed(2)) : 0,
          sick_full_remaining: balance ? 7 - balance.sick_full_used : 7,
          sick_half_remaining: balance ? 7 - balance.sick_half_used : 7,
        },
        notifications: {
          unread_count,
          latest,
        },
      },
    });
  } catch (err) {
    console.error("[staff.getDashboard]", err);
    res.status(500).json({ success: false, message: "Server error." });
  }
};
