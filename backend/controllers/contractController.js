const Contract = require("../models/Contract");
const User = require("../models/User");
const StaffProfile = require("../models/StaffProfile");
const Notification = require("../models/Notification");
const AuditLog = require("../models/AuditLog");

const getIP = (req) => req.ip || req.headers["x-forwarded-for"]?.split(",")[0] || "unknown";
const getUA = (req) => req.headers["user-agent"] || "unknown";

const writeAudit = async (action, req, targetId, targetType, before, after, metadata = {}) => {
  try {
    await AuditLog.create({
      action,
      admin_id: req.user._id,
      target_id: targetId,
      target_type: targetType,
      module: "contracts",
      ip_address: getIP(req),
      user_agent: getUA(req),
      before,
      after,
      metadata,
    });
  } catch (e) {
    console.error("[audit contract]", e.message);
  }
};

exports.createContract = async (req, res) => {
  try {
    const { staff_id, contract_text, start_date, end_date } = req.body;

    const user = await User.findById(staff_id);
    if (!user || user.role !== "staff")
      return res.status(400).json({ success: false, message: "Target must be an active staff user." });

    const profile = await StaffProfile.findOne({ user_id: staff_id });
    if (!profile || profile.type !== "contract")
      return res.status(400).json({ success: false, message: "Contracts can only be assigned to contract-type staff." });

    const start = new Date(start_date);
    const end = new Date(end_date);
    if (end <= start) return res.status(400).json({ success: false, message: "End date must be after start date." });

    const doc = await Contract.create({
      staff_id,
      contract_text,
      start_date: start,
      end_date: end,
      accepted: false,
      created_by: req.user._id,
    });

    await writeAudit("CREATE_CONTRACT", req, doc._id, "contract", null, { staff_id, start_date: start, end_date: end });
    await Notification.create({
      user_id: staff_id,
      message: "You have a new employment contract to read and accept before clocking in.",
      type: "warning",
    });

    res.status(201).json({ success: true, message: "Contract created. Staff must accept it to work.", data: doc });
  } catch (err) {
    console.error("[createContract]", err);
    res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.listContracts = async (req, res) => {
  try {
    const { staff_id, accepted } = req.query;
    const q = {};
    if (staff_id) q.staff_id = staff_id;
    if (accepted !== undefined) q.accepted = accepted === "true";

    const list = await Contract.find(q)
      .populate("staff_id", "name email")
      .populate("created_by", "name")
      .sort({ createdAt: -1 })
      .limit(200);
    res.json({ success: true, data: list });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.getMyContract = async (req, res) => {
  try {
    const pending = await Contract.findOne({
      staff_id: req.user._id,
      accepted: false,
    }).sort({ createdAt: -1 });

    const activeSigned = await Contract.findOne({
      staff_id: req.user._id,
      accepted: true,
    })
      .sort({ signed_at: -1 })
      .limit(1);

    const profile = await StaffProfile.findOne({ user_id: req.user._id });

    res.json({
      success: true,
      data: {
        staff_type: profile?.type || null,
        pending_contract: pending,
        latest_signed: activeSigned,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.acceptContract = async (req, res) => {
  try {
    const { contract_id } = req.body;
    if (!contract_id) return res.status(400).json({ success: false, message: "contract_id required." });

    const c = await Contract.findOne({ _id: contract_id, staff_id: req.user._id, accepted: false });
    if (!c) return res.status(404).json({ success: false, message: "No pending contract found for you." });

    c.accepted = true;
    c.signed_at = new Date();
    await c.save();

    await AuditLog.create({
      action: "ACCEPT_CONTRACT",
      admin_id: req.user._id,
      target_id: c._id,
      target_type: "contract",
      module: "contracts",
      ip_address: getIP(req),
      user_agent: getUA(req),
      after: { accepted: true, signed_at: c.signed_at },
    });

    await Notification.create({
      user_id: req.user._id,
      message: "You accepted your employment contract. You may clock in when within branch geofence.",
      type: "info",
    });

    res.json({ success: true, message: "Contract accepted.", data: c });
  } catch (err) {
    console.error("[acceptContract]", err);
    res.status(500).json({ success: false, message: "Server error." });
  }
};
