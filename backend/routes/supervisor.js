const express = require("express");
const { body, param } = require("express-validator");
const router = express.Router();
const { authenticate, requireRole } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const sup = require("../controllers/supervisorController");

const guard = [authenticate, requireRole("supervisor", "general_supervisor", "admin")];

router.get("/dashboard", guard, sup.getDashboard);
router.get("/staff", guard, sup.getBranchStaff);
router.get("/attendance/today", guard, sup.getTodayAttendance);
router.get("/leave", guard, sup.getBranchLeave);
router.get("/contacts", guard, sup.getTeamContacts);
router.get("/meetings", guard, sup.getMeetings);
router.get("/uniforms/history", guard, sup.getUniformHistory);

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

router.post(
  "/meetings",
  guard,
  [
    body("title").trim().isLength({ min: 3, max: 160 }),
    body("agenda").trim().isLength({ min: 5, max: 4000 }),
    body("scheduled_for").isISO8601(),
    body("branch_id").optional().isMongoId(),
    body("participant_ids").optional().isArray(),
    body("participant_ids.*").optional().isMongoId(),
  ],
  validate,
  sup.scheduleMeeting
);

router.post(
  "/uniforms/assign",
  guard,
  [
    body("staff_id").isMongoId(),
    body("item_type").isIn(["shirt", "boots", "trousers", "jacket", "hat"]),
    body("size").optional().isString().isLength({ min: 1, max: 20 }),
    body("item_description").optional().isString().isLength({ max: 300 }),
  ],
  validate,
  sup.assignUniform
);

module.exports = router;
