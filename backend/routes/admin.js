const express = require("express");
const { body, param, query } = require("express-validator");
const router = express.Router();
const { authenticate, requireRole } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const { destructiveLimiter, geoSearchLimiter, exportLimiter } = require("../middleware/rateLimiter");
const admin = require("../controllers/adminController");
const geo = require("../controllers/geoController");
const contract = require("../controllers/contractController");

const guard = [authenticate, requireRole("admin")];

router.get("/stats", guard, admin.getStats);
router.get("/security-events", guard, admin.getSecurityEvents);
router.patch(
  "/security-events/:id/resolve",
  guard,
  [param("id").isMongoId()],
  validate,
  admin.resolveSecurityEvent
);

router.get("/users", guard, admin.getAllUsers);
router.get(
  "/users/search",
  guard,
  [query("q").trim().isLength({ min: 1, max: 200 })],
  validate,
  admin.searchUsers
);
router.get("/users/pending", guard, admin.getPendingUsers);
router.get("/users/approved", guard, admin.getApprovedUsers);
router.get("/users/rejected", guard, admin.getRejectedUsers);
router.put(
  "/users/:id/review",
  guard,
  [param("id").isMongoId()],
  validate,
  admin.reviewRejectedUser
);
router.put(
  "/users/:id/promote",
  guard,
  [param("id").isMongoId(), body("branch_id").optional({ checkFalsy: true }).isMongoId()],
  validate,
  admin.promoteUser
);
router.get("/users/:id", guard, [param("id").isMongoId()], validate, admin.getUserById);
router.put(
  "/users/:id/role",
  guard,
  [param("id").isMongoId(), body("role").isIn(["general_supervisor", "supervisor", "staff"])],
  validate,
  admin.updateUserRole
);
router.put(
  "/users/:id/employment",
  guard,
  [
    param("id").isMongoId(),
    body("type").isIn(["casual", "reliever", "contract"]),
    body("allow_downgrade").optional().isBoolean(),
    body("branch_id").optional({ checkFalsy: true }).isMongoId(),
  ],
  validate,
  admin.updateEmploymentType
);
router.patch("/users/:id", guard, [param("id").isMongoId()], validate, admin.updateUser);
router.put(
  "/users/:id/approve",
  guard,
  [
    param("id").isMongoId(),
    body("role").isIn(["general_supervisor", "supervisor", "staff"]),
    body("employment_type").optional().isIn(["casual", "reliever", "contract", "supervisor", "general_supervisor"]),
    body("branch_id").optional({ checkFalsy: true }).isMongoId(),
  ],
  validate,
  admin.approveUser
);
router.put(
  "/users/:id/branch",
  guard,
  [param("id").isMongoId(), body("branch_id").isMongoId()],
  validate,
  admin.setUserBranch
);
router.put(
  "/users/:id/reject",
  guard,
  [param("id").isMongoId(), body("reason").trim().isLength({ min: 2, max: 300 })],
  validate,
  admin.rejectUser
);
router.put("/users/:id/verify", guard, [param("id").isMongoId()], validate, admin.verifyUserProfile);
router.put(
  "/users/:id/reject-profile",
  guard,
  [param("id").isMongoId(), body("reason").trim().isLength({ min: 2, max: 500 })],
  validate,
  admin.rejectProfileVerification
);
router.post(
  "/create-user",
  guard,
  [
    body("fullName").trim().isLength({ min: 2, max: 120 }),
    body("email").isEmail().normalizeEmail(),
    body("role").isIn(["admin", "general_supervisor", "supervisor", "staff"]),
    body("branch_id").optional({ checkFalsy: true }).isMongoId(),
    body("employment_type").optional().isIn(["casual", "reliever", "contract", "supervisor", "general_supervisor"]),
  ],
  validate,
  admin.createUserByAdmin
);
router.get(
  "/export/users",
  guard,
  exportLimiter,
  [query("q").optional().trim().isLength({ max: 200 }), query("format").optional().isIn(["csv", "xlsx"])],
  validate,
  admin.exportUsersXlsx
);
router.get(
  "/export-users",
  guard,
  exportLimiter,
  [query("q").optional().trim().isLength({ max: 200 }), query("format").optional().isIn(["csv", "xlsx"])],
  validate,
  admin.exportUsersXlsx
);
router.patch(
  "/users/:id/staff-profile",
  guard,
  [param("id").isMongoId(), body("type").isIn(["casual", "reliever", "contract", "supervisor"])],
  validate,
  admin.updateStaffProfileType
);

router.patch(
  "/users/:id/deactivate",
  guard,
  destructiveLimiter,
  [param("id").isMongoId()],
  validate,
  admin.deactivateUser
);
router.put(
  "/users/:id/deactivate",
  guard,
  destructiveLimiter,
  [param("id").isMongoId()],
  validate,
  admin.deactivateUser
);
router.put(
  "/users/:id/activate",
  guard,
  destructiveLimiter,
  [param("id").isMongoId()],
  validate,
  admin.activateUser
);

router.delete(
  "/users/:id",
  guard,
  destructiveLimiter,
  [
    param("id").isMongoId(),
    body("confirmation").equals("DELETE"),
    body("admin_password").notEmpty(),
  ],
  validate,
  admin.deleteUser
);

router.patch(
  "/users/:id/pay-rate",
  guard,
  [param("id").isMongoId(), body("rate").isFloat({ gt: 0 })],
  validate,
  admin.setPayRate
);

router.get("/sessions", guard, admin.getActiveSessions);
router.delete("/sessions/:id", guard, [param("id").isMongoId()], validate, admin.revokeUserSessions);

router.get("/geo/search", guard, geoSearchLimiter, [query("q").trim().isLength({ min: 2, max: 200 })], validate, geo.searchPlaces);

router.get("/branches", guard, admin.getBranches);
router.post(
  "/branches",
  guard,
  [
    body("name").trim().notEmpty().isLength({ max: 120 }),
    body("address").trim().isLength({ min: 5, max: 500 }),
    body("latitude").isFloat({ min: -90, max: 90 }),
    body("longitude").isFloat({ min: -180, max: 180 }),
    body("radius_meters").optional().isFloat({ min: 50, max: 10000 }),
    body("default_shift_start_time").optional().matches(/^\d{1,2}:\d{2}$/),
    body("clock_in_window_minutes").optional().isInt({ min: 10, max: 240 }),
  ],
  validate,
  admin.createBranch
);
router.patch("/branches/:id", guard, [param("id").isMongoId()], validate, admin.updateBranch);
router.delete("/branches/:id", guard, destructiveLimiter, [param("id").isMongoId()], validate, admin.deleteBranch);
router.get("/branches/:id/monitor", guard, [param("id").isMongoId()], validate, admin.getBranchMonitor);
router.get("/branches/:id/report", guard, [param("id").isMongoId()], validate, admin.getBranchReport);
router.post(
  "/branches/transfer-users",
  guard,
  [
    body("user_ids").isArray({ min: 1 }),
    body("user_ids.*").isMongoId(),
    body("to_branch_id").isMongoId(),
  ],
  validate,
  admin.transferUsersToBranch
);

router.get("/attendance", guard, admin.getAllAttendance);
router.get("/attendance/forced-clock-requests", guard, admin.getForcedClockRequests);
router.get("/attendance/forced-clockout-requests", guard, admin.getForcedClockOutRequests);
router.put(
  "/attendance/forced-clock-requests/:id/approve",
  guard,
  [param("id").isMongoId(), body("note").optional().trim().isLength({ max: 500 })],
  validate,
  admin.approveForcedClockRequest
);
router.put(
  "/attendance/forced-clock-requests/:id/reject",
  guard,
  [param("id").isMongoId(), body("note").trim().isLength({ min: 2, max: 500 })],
  validate,
  admin.rejectForcedClockRequest
);
router.put(
  "/attendance/forced-clockout-requests/:id/approve",
  guard,
  [param("id").isMongoId(), body("note").optional().trim().isLength({ max: 500 })],
  validate,
  admin.approveForcedClockOutRequest
);
router.put(
  "/attendance/forced-clockout-requests/:id/reject",
  guard,
  [param("id").isMongoId(), body("note").trim().isLength({ min: 2, max: 500 })],
  validate,
  admin.rejectForcedClockOutRequest
);
router.get(
  "/attendance/export",
  guard,
  exportLimiter,
  [
    query("month").optional().isInt({ min: 1, max: 12 }),
    query("year").optional().isInt({ min: 2020, max: 2100 }),
  ],
  validate,
  admin.exportAttendance
);
router.patch(
  "/attendance/:id",
  guard,
  [param("id").isMongoId(), body("reason").notEmpty()],
  validate,
  admin.editAttendance
);

router.get("/leave", guard, admin.getAllLeave);
router.patch(
  "/leave/:id/approve",
  guard,
  [param("id").isMongoId()],
  validate,
  admin.approveLeave
);
router.patch(
  "/leave/:id/reject",
  guard,
  [param("id").isMongoId(), body("reason").notEmpty()],
  validate,
  admin.rejectLeave
);

router.get("/leave-accrual", guard, admin.getLeaveAccrualReport);

const contractCreateValidators = [
  body("staff_id").isMongoId(),
  body("contract_text").trim().isLength({ min: 10, max: 50000 }),
  body("start_date").isISO8601(),
  body("end_date").isISO8601(),
];
router.post("/contracts", guard, contractCreateValidators, validate, contract.createContract);
router.post("/contract/create", guard, contractCreateValidators, validate, contract.createContract);
router.get("/contracts", guard, contract.listContracts);

router.post(
  "/uniforms/issue",
  guard,
  [body("staff_id").isMongoId(), body("item_type").notEmpty()],
  validate,
  admin.issueUniform
);
router.get("/uniforms/grid", guard, admin.getUniformsGrid);
router.patch("/uniforms/:id/return", guard, [param("id").isMongoId()], validate, admin.returnUniform);
router.patch(
  "/uniforms/:id/replacement",
  guard,
  [param("id").isMongoId(), body("reason").optional().trim().isLength({ max: 500 })],
  validate,
  admin.requestUniformReplacement
);

router.post(
  "/notify",
  guard,
  [body("message").notEmpty().isLength({ max: 500 })],
  validate,
  admin.broadcastNotification
);

router.get("/audit", guard, admin.getAuditLogs);

module.exports = router;
