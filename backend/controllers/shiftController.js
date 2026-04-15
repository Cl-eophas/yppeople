const mongoose = require("mongoose");
const AuditLog = require("../models/AuditLog");
const Shift = require("../models/Shift");
const User = require("../models/User");
const shiftService = require("../services/shiftService");
const { matchUserIdsByStaffSearch } = require("../utils/staffSearch");

const getIP = (req) => req.ip || req.headers["x-forwarded-for"]?.split(",")[0] || "unknown";
const getUA = (req) => req.headers["user-agent"] || "unknown";

async function writeShiftAudit(action, req, metadata) {
  try {
    await AuditLog.create({
      action,
      admin_id: req.user._id,
      target_id: metadata.staff_id ? new mongoose.Types.ObjectId(metadata.staff_id) : undefined,
      target_type: "shift",
      module: "shift",
      ip_address: getIP(req),
      user_agent: getUA(req),
      metadata: { ...metadata, actor_id: req.user._id.toString() },
    });
  } catch (e) {
    console.error("[shift audit]", e.message);
  }
}

exports.assign = async (req, res) => {
  try {
    const { staff_id, branch_id, shift_date, start_time } = req.body;
    const r = await shiftService.assignShift({
      staff_id,
      branch_id,
      shift_date,
      start_time,
      actor: req.user,
    });
    if (!r.ok) return res.status(r.code).json({ success: false, message: r.message });
    await writeShiftAudit("SHIFT_ASSIGNED", req, {
      staff_id: r.shift.staff_id.toString(),
      date: r.shift.shift_date,
      branch_id: r.shift.branch_id.toString(),
      start_time: r.shift.start_time,
      end_time: r.shift.end_time,
    });
    res.status(201).json({ success: true, message: "Shift assigned.", data: r.shift });
  } catch (err) {
    console.error("[shift assign]", err);
    res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.bulkAssign = async (req, res) => {
  try {
    const { staff_ids, shift_date, start_time } = req.body;
    if (!Array.isArray(staff_ids) || staff_ids.length === 0)
      return res.status(400).json({ success: false, message: "staff_ids must be a non-empty array." });

    const first = await User.findById(staff_ids[0]).select("branch_id");
    if (!first?.branch_id) return res.status(400).json({ success: false, message: "First staff has no branch." });
    const bid = first.branch_id;

    for (const sid of staff_ids) {
      const u = await User.findById(sid).select("branch_id");
      if (!u?.branch_id || u.branch_id.toString() !== bid.toString())
        return res.status(400).json({ success: false, message: "All staff must belong to the same branch." });
    }

    const created = [];
    const skipped = [];
    const errors = [];

    for (const staff_id of staff_ids) {
      const r = await shiftService.assignShift({
        staff_id,
        branch_id: bid,
        shift_date,
        start_time,
        actor: req.user,
        skipDuplicate: true,
      });
      if (r.skipped) skipped.push({ staff_id, reason: r.reason });
      else if (!r.ok) errors.push({ staff_id, message: r.message });
      else created.push(r.shift);
    }

    for (const sh of created) {
      await writeShiftAudit("SHIFT_ASSIGNED", req, {
        staff_id: sh.staff_id.toString(),
        date: sh.shift_date,
        bulk: true,
      });
    }

    res.status(201).json({
      success: true,
      message: `Bulk assign complete: ${created.length} created, ${skipped.length} skipped.`,
      data: { created, skipped, errors },
    });
  } catch (err) {
    console.error("[shift bulkAssign]", err);
    res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.listMy = async (req, res) => {
  try {
    const from = req.query.from || req.query.start;
    const to = req.query.to || req.query.end;
    const q = { staff_id: req.user._id };
    if (from && to) q.shift_date = { $gte: from, $lte: to };
    else if (from) q.shift_date = { $gte: from };
    else if (to) q.shift_date = { $lte: to };

    const rows = await Shift.find(q).populate("branch_id", "name").sort({ shift_date: 1, start_time: 1 }).lean();
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("[shift listMy]", err);
    res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.listBranch = async (req, res) => {
  try {
    let branchId = req.query.branch_id;
    if (req.user.role === "supervisor") {
      branchId = req.user.branch_id?.toString();
      if (!branchId) return res.status(400).json({ success: false, message: "Supervisor has no branch." });
    }
    if (!branchId) return res.status(400).json({ success: false, message: "branch_id required." });

    const access = shiftService.assertBranchAccess(req.user, branchId);
    if (!access.ok) return res.status(access.code).json({ success: false, message: access.message });

    const from = req.query.from;
    const to = req.query.to;
    const q = { branch_id: branchId };
    if (from && to) q.shift_date = { $gte: from, $lte: to };
    else if (from) q.shift_date = { $gte: from };
    else if (to) q.shift_date = { $lte: to };

    const search = req.query.search;
    if (search && String(search).trim()) {
      const ids = await matchUserIdsByStaffSearch(search);
      if (!ids.length) return res.json({ success: true, data: [] });
      q.staff_id = { $in: ids };
    }

    const rows = await Shift.find(q)
      .populate("staff_id", "name email role")
      .populate("branch_id", "name")
      .sort({ shift_date: 1, start_time: 1 })
      .lean();
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("[shift listBranch]", err);
    res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.patch = async (req, res) => {
  try {
    const r = await shiftService.updateShift(req.params.id, req.body, req.user);
    if (!r.ok) return res.status(r.code).json({ success: false, message: r.message });
    await writeShiftAudit("SHIFT_UPDATED", req, {
      staff_id: r.shift.staff_id.toString(),
      date: r.shift.shift_date,
      before: r.before,
      after: {
        shift_date: r.shift.shift_date,
        start_time: r.shift.start_time,
        end_time: r.shift.end_time,
      },
    });
    res.json({ success: true, message: "Shift updated.", data: r.shift });
  } catch (err) {
    console.error("[shift patch]", err);
    res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.remove = async (req, res) => {
  try {
    const r = await shiftService.deleteShift(req.params.id, req.user);
    if (!r.ok) return res.status(r.code).json({ success: false, message: r.message });
    await writeShiftAudit("SHIFT_DELETED", req, {
      staff_id: r.shift.staff_id.toString(),
      date: r.shift.shift_date,
    });
    res.json({ success: true, message: "Shift removed." });
  } catch (err) {
    console.error("[shift remove]", err);
    res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.addOffDay = async (req, res) => {
  try {
    const { staff_id, date, note } = req.body;
    const r = await shiftService.recordOffDay({ staff_id, date, actor: req.user, note });
    if (!r.ok) return res.status(r.code).json({ success: false, message: r.message });
    await writeShiftAudit("OFF_DAY_RECORDED", req, { staff_id, date });
    res.status(201).json({ success: true, message: "Off day recorded.", data: r.offDay });
  } catch (err) {
    console.error("[shift addOffDay]", err);
    res.status(500).json({ success: false, message: "Server error." });
  }
};
