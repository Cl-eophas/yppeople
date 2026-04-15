const express = require("express");
const router = express.Router();
const publicCtrl = require("../controllers/publicController");
const { validate } = require("../middleware/validate");
const { body } = require("express-validator");

router.get("/landing-stats", publicCtrl.getLandingStats);
router.post("/seed", [body("key").optional().isString().isLength({ min: 6, max: 200 })], validate, publicCtrl.seed);

module.exports = router;
