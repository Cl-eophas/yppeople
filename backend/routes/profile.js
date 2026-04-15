const express = require("express");
const { body } = require("express-validator");
const router = express.Router();
const { authenticate, staffOrSupervisor } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const profile = require("../controllers/profileController");

router.get("/", authenticate, staffOrSupervisor, profile.getProfile);

router.patch(
  "/update",
  authenticate,
  staffOrSupervisor,
  [
    body("phone").optional().isString().isLength({ max: 32 }),
    body("address").optional().isString().isLength({ min: 5 }),
  ],
  validate,
  profile.updateProfile
);

module.exports = router;
