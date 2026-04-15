const express = require("express");
const router = express.Router();
const { authenticate, staffOrSupervisor } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const { body } = require("express-validator");
const notif = require("../controllers/notificationController");

router.get("/", authenticate, staffOrSupervisor, notif.getNotifications);

router.patch(
  "/read",
  authenticate,
  staffOrSupervisor,
  [body("notification_ids").optional().isArray()],
  validate,
  notif.markAsRead
);

module.exports = router;
