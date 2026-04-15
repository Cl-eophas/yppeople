const express = require("express");
const { body } = require("express-validator");
const router = express.Router();
const { authenticate, staffOrSupervisor } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const att = require("../controllers/attendanceController");

router.post(
  "/clock-in",
  authenticate,
  staffOrSupervisor,
  [
    body("latitude").isFloat({ min: -90, max: 90 }),
    body("longitude").isFloat({ min: -180, max: 180 }),
  ],
  validate,
  att.clockIn
);

router.post(
  "/clock-out",
  authenticate,
  staffOrSupervisor,
  [
    body("latitude").isFloat({ min: -90, max: 90 }),
    body("longitude").isFloat({ min: -180, max: 180 }),
  ],
  validate,
  att.clockOut
);

router.get("/history", authenticate, staffOrSupervisor, att.getHistory);

module.exports = router;
