const express = require("express");
const router = express.Router();
const { authenticate, staffOrSupervisor } = require("../middleware/auth");
const staff = require("../controllers/staffController");

router.get("/dashboard", authenticate, staffOrSupervisor, staff.getDashboard);

module.exports = router;
