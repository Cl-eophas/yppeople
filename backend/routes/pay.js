const express = require("express");
const router = express.Router();
const { authenticate, staffOrSupervisor } = require("../middleware/auth");
const pay = require("../controllers/payController");

router.get("/summary", authenticate, staffOrSupervisor, pay.getPaySummary);

module.exports = router;
