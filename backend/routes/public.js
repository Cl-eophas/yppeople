const express = require("express");
const router = express.Router();
const publicCtrl = require("../controllers/publicController");

router.get("/landing-stats", publicCtrl.getLandingStats);

module.exports = router;
