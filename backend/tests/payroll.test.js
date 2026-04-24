const { test, describe } = require("node:test");
const assert = require("node:assert");
const { STATUS, classifyDay } = require("../utils/attendanceAnalytics");
const { parsePayRateBody } = require("../utils/payrollRate");

describe("payroll / attendance classification", () => {
  test("self clock-in counts as work (present/late) — source agnostic for payroll", () => {
    const att = { clock_in: new Date("2026-04-10T10:00:00Z"), status: "present" };
    const s = classifyDay("2026-04-10", att, null, false, true, "casual");
    assert(s === STATUS.PRESENT || s === STATUS.LATE);
  });

  test("supervisor_assisted with clock_in is a normal work day, not downgraded in classification", () => {
    const att = { clock_in: new Date("2026-04-10T09:00:00Z"), status: "supervisor_assisted" };
    const s = classifyDay("2026-04-10", att, null, false, true, "casual");
    assert(s === STATUS.PRESENT || s === STATUS.LATE);
  });

  test("no clock-in on scheduled day is absent (gap filled by backfill or analytics)", () => {
    const s = classifyDay("2026-04-10", null, null, false, true, "casual");
    assert.strictEqual(s, STATUS.ABSENT);
  });
});

describe("parsePayRateBody (admin pay fields)", () => {
  test("accepts pay_rate", () => {
    const r = parsePayRateBody({ pay_rate: 800 });
    assert.strictEqual(r.rate, 800);
  });
  test("accepts rate alias", () => {
    const r = parsePayRateBody({ rate: 1200 });
    assert.strictEqual(r.rate, 1200);
  });
  test("pay_rate takes precedence over rate", () => {
    const r = parsePayRateBody({ pay_rate: 100, rate: 200 });
    assert.strictEqual(r.rate, 100);
  });
});
