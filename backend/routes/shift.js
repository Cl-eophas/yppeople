const express = require("express");
const { body, param, query } = require("express-validator");
const router = express.Router();
const { authenticate, requireRole } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const shift = require("../controllers/shiftController");

const adminSup = [authenticate, requireRole("admin", "supervisor")];
const staffPlus = [authenticate, requireRole("admin", "supervisor", "staff")];

router.post(
  "/assign",
  adminSup,
  [
    body("staff_id").isMongoId(),
    body("branch_id").isMongoId(),
    body("shift_date").matches(/^\d{4}-\d{2}-\d{2}$/),
    body("start_time").matches(/^\d{1,2}:\d{2}$/),
  ],
  validate,
  shift.assign
);

router.post(
  "/bulk-assign",
  adminSup,
  [
    body("staff_ids").isArray({ min: 1 }),
    body("staff_ids.*").isMongoId(),
    body("shift_date").matches(/^\d{4}-\d{2}-\d{2}$/),
    body("start_time").matches(/^\d{1,2}:\d{2}$/),
  ],
  validate,
  shift.bulkAssign
);

router.get(
  "/my",
  staffPlus,
  [
    query("from").optional().matches(/^\d{4}-\d{2}-\d{2}$/),
    query("to").optional().matches(/^\d{4}-\d{2}-\d{2}$/),
  ],
  validate,
  shift.listMy
);

router.get(
  "/branch",
  adminSup,
  [
    query("branch_id").optional().isMongoId(),
    query("from").optional().matches(/^\d{4}-\d{2}-\d{2}$/),
    query("to").optional().matches(/^\d{4}-\d{2}-\d{2}$/),
    query("search").optional().trim().isLength({ max: 120 }),
  ],
  validate,
  shift.listBranch
);

router.patch(
  "/:id",
  adminSup,
  [
    param("id").isMongoId(),
    body("shift_date").optional().matches(/^\d{4}-\d{2}-\d{2}$/),
    body("start_time").optional().matches(/^\d{1,2}:\d{2}$/),
    body("staff_id").optional().isMongoId(),
  ],
  validate,
  shift.patch
);

router.delete("/:id", adminSup, [param("id").isMongoId()], validate, shift.remove);

router.post(
  "/off-day",
  adminSup,
  [
    body("staff_id").isMongoId(),
    body("date").matches(/^\d{4}-\d{2}-\d{2}$/),
    body("note").optional().trim().isLength({ max: 500 }),
  ],
  validate,
  shift.addOffDay
);

module.exports = router;
