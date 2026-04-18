const User = require("../models/User");
const StaffProfile = require("../models/StaffProfile");
const Notification = require("../models/Notification");
const {
  isPayrollUnlocked,
  verificationPayload,
  resolveVerificationStatus,
} = require("../utils/profileVerification");
const { notifyAdmins } = require("../utils/notifyAdmins");

const KRA_PIN_REGEX = /^[A-Z][0-9]{9}[A-Z]$/;
const PHONE_REGEX = /^(\+254|0)[0-9]{9}$/;

function profileIsComplete(user) {
  return Boolean(
    user.name &&
      user.email &&
      /^[0-9]{7,8}$/.test(String(user.idNumber || "")) &&
      KRA_PIN_REGEX.test(String(user.kraPin || "").toUpperCase()) &&
      PHONE_REGEX.test(String(user.phone || "")) &&
      user.nssf &&
      user.nhif &&
      user.bank?.bankName &&
      user.bank?.branch &&
      String(user.bank?.accountNumber || "").trim().length >= 6
  );
}

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
        phone: sp?.phone || o.phone,
        address: sp?.address,
        pay_rate: sp?.pay_rate,
        ...verificationPayload(user),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.updateProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ success: false, message: "User not found." });

    const completedGate = Boolean(user.profileCompleted && profileIsComplete(user));

    if (!completedGate) {
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
      const kraOk = KRA_PIN_REGEX.test(String(kraPin || "").toUpperCase());
      const phoneOk = PHONE_REGEX.test(String(phone || ""));
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

      const prevBank = user.bank || {};
      const bankChanged =
        String(prevBank.accountNumber || "").trim() !== String(accountNumber).trim() ||
        String(prevBank.bankName || "").trim() !== String(bankName).trim() ||
        String(prevBank.branch || "").trim() !== String(bankBranch).trim();

      const wasUnlocked = isPayrollUnlocked(user);
      const priorEffective = resolveVerificationStatus(user).status;

      user.name = fullName.trim();
      user.email = email.trim().toLowerCase();
      user.idNumber = String(idNumber).trim();
      user.kraPin = String(kraPin).trim().toUpperCase();
      user.nssf = String(nssf).trim();
      user.nhif = String(nhif).trim();
      user.phone = String(phone).trim();
      user.bank = {
        ...prevBank,
        accountNumber: String(accountNumber).trim(),
        bankName: String(bankName).trim(),
        branch: String(bankBranch).trim(),
      };
      if (bankChanged) {
        user.bank.isVerified = false;
        user.bank.isActive = false;
      }

      user.profileCompleted = true;

      if (wasUnlocked && !bankChanged) {
        // Admin-verified profile: non-bank edits do not reset payroll verification.
      } else {
        user.verification_status = "pending";
        user.isVerified = false;
        user.verification_rejection_reason = null;
        if (priorEffective !== "pending") {
          await Notification.create({
            user_id: user._id,
            type: "info",
            message: "Profile submitted for admin verification.",
          });
        }
      }

      await StaffProfile.findOneAndUpdate(
        { user_id: user._id },
        { $set: { phone: String(phone).trim() } },
        { upsert: true }
      );

      await user.save();

      return res.json({
        success: true,
        message: "Profile updated successfully.",
        data: { profileCompleted: user.profileCompleted, ...verificationPayload(user) },
      });
    }

    const lockedKeys = ["idNumber", "kraPin", "nssf", "nhif", "name"];
    for (const k of lockedKeys) {
      if (req.body[k] === undefined) continue;
      const incoming = String(req.body[k] || "").trim();
      const cur = k === "kraPin" ? String(user[k] || "").trim().toUpperCase() : String(user[k] || "").trim();
      const cmp = k === "kraPin" ? incoming.toUpperCase() : incoming;
      if (cmp !== cur) {
        return res.status(400).json({
          success: false,
          message: "ID number, tax identifiers, and legal name cannot be changed here. Contact HR.",
        });
      }
    }

    const { email, phone, accountNumber, bankName, bankBranch } = req.body;
    if (
      email === undefined &&
      phone === undefined &&
      accountNumber === undefined &&
      bankName === undefined &&
      bankBranch === undefined
    ) {
      return res.status(400).json({ success: false, message: "No updatable fields provided." });
    }

    const nextEmail = email !== undefined ? String(email).trim().toLowerCase() : user.email;
    const nextPhone = phone !== undefined ? String(phone).trim() : user.phone;
    const nextAcct = accountNumber !== undefined ? String(accountNumber).trim() : String(user.bank?.accountNumber || "");
    const nextBankName = bankName !== undefined ? String(bankName).trim() : String(user.bank?.bankName || "");
    const nextBankBranch = bankBranch !== undefined ? String(bankBranch).trim() : String(user.bank?.branch || "");

    if (email !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextEmail)) {
      return res.status(400).json({ success: false, message: "Invalid email address." });
    }
    if (phone !== undefined && !PHONE_REGEX.test(nextPhone)) {
      return res.status(400).json({ success: false, message: "Invalid phone number format." });
    }

    const prevEmail = user.email;
    const prevPhone = user.phone;
    const prevBank = user.bank || {};
    const bankChanged =
      String(prevBank.accountNumber || "").trim() !== nextAcct ||
      String(prevBank.bankName || "").trim() !== nextBankName ||
      String(prevBank.branch || "").trim() !== nextBankBranch;
    const emailChanged = email !== undefined && nextEmail !== prevEmail;
    const phoneChanged = phone !== undefined && nextPhone !== prevPhone;

    if (!emailChanged && !phoneChanged && !bankChanged) {
      return res.status(400).json({ success: false, message: "Nothing to update." });
    }

    if (bankChanged) {
      if (nextAcct.length < 6 || nextBankName.length < 2 || nextBankBranch.length < 2) {
        return res.status(400).json({
          success: false,
          message: "Bank name, branch, and a valid account number are required when updating bank details.",
        });
      }
    }

    if (email !== undefined && nextEmail !== user.email) {
      const taken = await User.findOne({ email: nextEmail, _id: { $ne: user._id }, deleted_at: null }).select("_id").lean();
      if (taken) {
        return res.status(400).json({ success: false, message: "That email is already in use." });
      }
    }

    if (email !== undefined) user.email = nextEmail;
    if (phone !== undefined) user.phone = nextPhone;
    if (bankChanged) {
      user.bank = {
        ...prevBank,
        accountNumber: nextAcct,
        bankName: nextBankName,
        branch: nextBankBranch,
        isVerified: false,
        isActive: false,
      };
    }

    user.verification_status = "pending";
    user.isVerified = false;
    user.verification_rejection_reason = null;
    await user.save();
    await notifyAdmins({
      type: "approval",
      message: `${user.name} updated contact or bank details; verification set to pending.`,
    });
    await Notification.create({
      user_id: user._id,
      type: "info",
      message: "Your profile changes were saved and are pending admin verification.",
    });

    if (phone !== undefined) {
      await StaffProfile.findOneAndUpdate(
        { user_id: user._id },
        { $set: { phone: nextPhone } },
        { upsert: true }
      );
    }

    return res.json({
      success: true,
      message: "Profile updated successfully.",
      data: { profileCompleted: user.profileCompleted, ...verificationPayload(user) },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.updateContact = async (req, res) => {
  try {
    const { phone, address, email } = req.body;
    const phoneOk = PHONE_REGEX.test(String(phone || ""));
    if (!phoneOk) {
      return res.status(400).json({ success: false, message: "Invalid phone number format." });
    }

    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ success: false, message: "User not found." });

    const nextPhone = String(phone).trim();
    const phoneChanged = nextPhone !== String(user.phone || "").trim();

    if (email !== undefined) {
      const nextEmail = String(email).trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextEmail)) {
        return res.status(400).json({ success: false, message: "Invalid email address." });
      }
      if (nextEmail !== user.email) {
        const taken = await User.findOne({ email: nextEmail, _id: { $ne: user._id }, deleted_at: null }).select("_id").lean();
        if (taken) {
          return res.status(400).json({ success: false, message: "That email is already in use." });
        }
        user.email = nextEmail;
      }
    }

    user.phone = nextPhone;
    const emailChanged = email !== undefined;

    if (user.profileCompleted && profileIsComplete(user) && (phoneChanged || emailChanged)) {
      user.verification_status = "pending";
      user.isVerified = false;
      user.verification_rejection_reason = null;
      await notifyAdmins({
        type: "approval",
        message: `${user.name} updated phone or email; verification set to pending.`,
      });
    }

    await user.save();

    const profile = await StaffProfile.findOneAndUpdate(
      { user_id: req.user._id },
      { $set: { phone: nextPhone, address: String(address || "").trim() } },
      { new: true, upsert: true }
    );

    const fresh = await User.findById(req.user._id);
    return res.json({
      success: true,
      message: "Contact profile updated successfully.",
      data: { phone: profile.phone, address: profile.address, ...verificationPayload(fresh) },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error." });
  }
};
