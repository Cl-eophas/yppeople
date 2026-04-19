const express = require("express");
const { body, param } = require("express-validator");
const router = express.Router();
const { authenticate, requireRole } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const sup = require("../controllers/supervisorController");

// Strict RBAC: supervisors only. No overlap with general supervisor.
const guard = [authenticate, requireRole("supervisor")];

router.get("/dashboard", guard, sup.getDashboard);
router.get("/staff", guard, sup.getBranchStaff);
router.get("/attendance/today", guard, sup.getTodayAttendance);
router.get("/leave", guard, sup.getBranchLeave);
router.get("/contacts", guard, sup.getTeamContacts);

router.post(
  "/attendance/manual-entry",
  guard,
  [body("staff_id").notEmpty(), body("reason").notEmpty()],
  validate,
  sup.manualClockIn
);
router.post(
  "/attendance/manual-clockin",
  guard,
  [body("staffId").isMongoId(), body("reason").trim().isLength({ min: 2, max: 500 })],
  validate,
  (req, res, next) => {
    req.body.staff_id = req.body.staffId;
    return sup.manualClockIn(req, res, next);
  }
);

router.post(
  "/attendance/force-clockout/request",
  guard,
  [body("staff_id").notEmpty(), body("reason").notEmpty()],
  validate,
  sup.requestForceClockOut
);

router.patch(
  "/leave/:id/approve",
  guard,
  [param("id").isMongoId()],
  validate,
  sup.approveLeave
);

router.patch(
  "/leave/:id/reject",
  guard,
  [param("id").isMongoId(), body("reason").notEmpty()],
  validate,
  sup.rejectLeave
);

router.post(
  "/notify",
  guard,
  [body("message").notEmpty()],
  validate,
  sup.sendNotification
);

router.post(
  "/attendance/force-clockin/request",
  guard,
  [body("staff_id").isMongoId(), body("reason").trim().isLength({ min: 5, max: 500 })],
  validate,
  sup.requestForceClockIn
);

router.get("/attendance", guard, sup.getAttendance);
router.get("/late", guard, sup.getLateStaff);

router.put(
  "/shifts/weekly",
  guard,
  [body("entries").isArray({ min: 1 })],
  validate,
  sup.setWeeklyShifts
);

module.exports = router;
