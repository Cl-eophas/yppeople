const express = require("express");
const router = express.Router();
const { authenticate, staffOrSupervisor } = require("../middleware/auth");
const uniform = require("../controllers/uniformController");

router.get("/my", authenticate, staffOrSupervisor, uniform.getMyUniforms);

module.exports = router;
