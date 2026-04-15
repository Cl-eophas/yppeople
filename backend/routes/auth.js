const express = require("express");
const { body } = require("express-validator");
const router = express.Router();

const auth = require("../controllers/authController");
const { authenticate, requireRole } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const { loginLimiter } = require("../middleware/rateLimiter");

router.post(
  "/login",
  loginLimiter,
  [body("email").isEmail().normalizeEmail(), body("password").notEmpty()],
  validate,
  auth.login
);

router.post("/refresh", [body("user_id").notEmpty()], validate, auth.refresh);

router.post("/logout", authenticate, auth.logout);

router.get("/me", authenticate, auth.getMe);

router.get("/sessions", authenticate, auth.getSessions);

router.post(
  "/change-password",
  authenticate,
  [
    body("current_password").notEmpty(),
    body("new_password").isLength({ min: 8 }).withMessage("New password must be at least 8 characters."),
  ],
  validate,
  auth.changePassword
);

router.post(
  "/register",
  authenticate,
  requireRole("admin"),
  [
    body("name").trim().notEmpty(),
    body("email").isEmail().normalizeEmail(),
    body("password").isLength({ min: 8 }),
    body("role").optional().isIn(["admin", "supervisor", "staff"]),
  ],
  validate,
  auth.register
);

module.exports = router;
