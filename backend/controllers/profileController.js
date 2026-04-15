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
    const {
      fullName,
      idNumber,
      kraPin,
      nssf,
      nhif,
      accountNumber,
      bankName,
      bankBranch,
      email,
      phone,
    } = req.body;

    const idOk = /^[0-9]{7,8}$/.test(String(idNumber || ""));
    const kraOk = /^[A-Z][0-9]{9}[A-Z]$/.test(String(kraPin || "").toUpperCase());
    const phoneOk = /^(\+254|0)[0-9]{9}$/.test(String(phone || ""));
    const acctOk = String(accountNumber || "").trim().length >= 6;
    const requiredOk = [fullName, nssf, nhif, bankName, bankBranch, email].every(
      (v) => typeof v === "string" && v.trim().length > 0
    );

    if (!idOk || !kraOk || !phoneOk || !acctOk || !requiredOk) {
      return res.status(400).json({
        success: false,
        message: "Invalid profile data. Ensure all required fields are complete and valid.",
      });
    }

    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ success: false, message: "User not found." });

    user.name = fullName.trim();
    user.email = email.trim().toLowerCase();
    user.idNumber = String(idNumber).trim();
    user.kraPin = String(kraPin).trim().toUpperCase();
    user.nssf = String(nssf).trim();
    user.nhif = String(nhif).trim();
    user.phone = String(phone).trim();
    user.bank = {
      ...(user.bank || {}),
      accountNumber: String(accountNumber).trim(),
      bankName: String(bankName).trim(),
      branch: String(bankBranch).trim(),
      isVerified: false,
      isActive: false,
    };
    user.profileCompleted = true;
    user.isVerified = false;

    await user.save();

    return res.json({
      success: true,
      message: "Profile updated successfully.",
      data: { profileCompleted: user.profileCompleted },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error." });
  }
};
