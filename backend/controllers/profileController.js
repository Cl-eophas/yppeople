const User = require("../models/User");
const StaffProfile = require("../models/StaffProfile");

exports.getProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).populate("branch_id", "name address").select("-password");
    const sp = await StaffProfile.findOne({ user_id: req.user._id });
    const o = user.toObject();
    res.json({
      success: true,
      data: {
        ...o,
        staff_id: sp?.staff_id,
        type: sp?.type,
        join_date: sp?.join_date,
        phone: sp?.phone,
        address: sp?.address,
        pay_rate: sp?.pay_rate,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.updateProfile = async (req, res) => {
  try {
    const { phone, address } = req.body;
    const sp = await StaffProfile.findOne({ user_id: req.user._id });
    if (!sp) return res.status(404).json({ success: false, message: "Profile not found." });
    if (phone !== undefined) sp.phone = phone;
    if (address !== undefined) sp.address = address;
    await sp.save();
    res.json({ success: true, message: "Profile updated.", data: sp });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error." });
  }
};
