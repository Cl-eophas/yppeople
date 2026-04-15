const express = require("express");
const { body, param } = require("express-validator");
const router = express.Router();
const { authenticate, requireRole } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const sup = require("../controllers/supervisorController");

const guard = [authenticate, requireRole("supervisor", "admin")];

router.get("/dashboard", guard, sup.getDashboard);
router.get("/staff", guard, sup.getBranchStaff);
router.get("/attendance/today", guard, sup.getTodayAttendance);
router.get("/leave", guard, sup.getBranchLeave);

router.post(
  "/attendance/manual-entry",
  guard,
  [body("staff_id").notEmpty(), body("reason").notEmpty()],
  validate,
  sup.manualClockIn
);

router.post(
  "/attendance/force-clockout",
  guard,
  [body("staff_id").notEmpty(), body("reason").notEmpty()],
  validate,
  sup.forceClockOut
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

module.exports = router;
