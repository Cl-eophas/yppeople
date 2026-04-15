const express = require("express");
const { body } = require("express-validator");
const router = express.Router();
const { authenticate, staffOrSupervisor } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const profile = require("../controllers/profileController");

router.get("/", authenticate, staffOrSupervisor, profile.getProfile);

const profileValidators = [
  body("fullName").trim().isLength({ min: 2, max: 120 }),
  body("idNumber").trim().matches(/^[0-9]{7,8}$/),
  body("kraPin").trim().matches(/^[A-Z][0-9]{9}[A-Z]$/),
  body("nssf").trim().isLength({ min: 2, max: 40 }),
  body("nhif").trim().isLength({ min: 2, max: 40 }),
  body("accountNumber").trim().isLength({ min: 6, max: 40 }),
  body("bankName").trim().isLength({ min: 2, max: 120 }),
  body("bankBranch").trim().isLength({ min: 2, max: 120 }),
  body("email").isEmail().normalizeEmail(),
  body("phone").trim().matches(/^(\+254|0)[0-9]{9}$/),
];

router.put(
  "/profile",
  authenticate,
  staffOrSupervisor,
  profileValidators,
  validate,
  profile.updateProfile
);

router.patch(
  "/update",
  authenticate,
  staffOrSupervisor,
  profileValidators,
  validate,
  profile.updateProfile
);

module.exports = router;
