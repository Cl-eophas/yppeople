const express = require("express");
const { body } = require("express-validator");
const router = express.Router();
const { authenticate, staffOrSupervisor } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const staff = require("../controllers/staffController");

router.get("/dashboard", authenticate, staffOrSupervisor, staff.getDashboard);
router.get("/branches/available", authenticate, staffOrSupervisor, staff.listBranchesAvailable);
router.put(
  "/my-branch",
  authenticate,
  staffOrSupervisor,
  [body("branch_id").isMongoId()],
  validate,
  staff.selectCasualBranch
);

module.exports = router;
