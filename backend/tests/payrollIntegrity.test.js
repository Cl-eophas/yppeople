const { test } = require("node:test");
const assert = require("node:assert");

// Unit-level sanity: ensure attendance enum includes 'off' (completeness support).
test("attendance status enum includes off", async () => {
  // eslint-disable-next-line global-require
  const Attendance = require("../models/Attendance");
  const statuses = Attendance.schema.path("status").enumValues;
  assert.ok(statuses.includes("off"));
});

