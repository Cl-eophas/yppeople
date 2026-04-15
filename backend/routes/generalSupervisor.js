const express = require("express");
const { body, query } = require("express-validator");
const router = express.Router();
const { authenticate, requireRole } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const gs = require("../controllers/generalSupervisorController");

const guard = [authenticate, requireRole("general_supervisor")];

router.get(
  "/attendance",
  guard,
  [
    query("date").optional().matches(/^\d{4}-\d{2}-\d{2}$/),
    query("branch_id").optional().isMongoId(),
    query("status").optional().isIn(["present", "late", "forced", "supervisor_assisted", "absent", "leave", "unscheduled"]),
  ],
  validate,
  gs.globalAttendance
);

router.get(
  "/contacts",
  guard,
  [query("role").optional().isIn(["staff", "supervisor"]), query("branch_id").optional().isMongoId()],
  validate,
  gs.contacts
);

router.get("/branches", guard, gs.listBranches);

router.get("/meetings", guard, gs.listMeetings);
router.post(
  "/meetings",
  guard,
  [body("title").trim().isLength({ min: 3, max: 160 }), body("date").isISO8601(), body("participants").isArray({ min: 1 }), body("participants.*").isMongoId()],
  validate,
  gs.scheduleMeeting
);

router.get("/uniforms/history", guard, gs.uniformHistory);
router.post(
  "/uniforms/assign",
  guard,
  [body("staff_id").isMongoId(), body("item").trim().isLength({ min: 2, max: 120 }), body("quantity").isInt({ min: 1, max: 1000 })],
  validate,
  gs.assignUniform
);

module.exports = router;
