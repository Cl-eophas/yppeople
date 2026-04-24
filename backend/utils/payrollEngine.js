/**
 * Kenya payslip-style statutory lines (YP People Ltd–aligned percentages).
 * All amounts rounded to whole KES (server-side only).
 */
const HOUSING_LEVY_RATE = 0.015;
const NSSF_STATUTORY_RATE = 0.06;
const SHA_RATE = 0.0275;

const roundKes = (n) => Math.round(Number(n) || 0);

/**
 * @param {number} grossPay - pre-deduction gross for the period
 */
function computeKenyaStatutoryDeductions(grossPay) {
  const g = roundKes(grossPay);
  const housing_levy = roundKes(g * HOUSING_LEVY_RATE);
  const nssf_statutory = roundKes(g * NSSF_STATUTORY_RATE);
  const sha = roundKes(g * SHA_RATE);
  const total_deductions = housing_levy + nssf_statutory + sha;
  const net_pay = roundKes(g - total_deductions);
  return {
    gross_pay: g,
    housing_levy,
    nssf_statutory,
    sha,
    total_deductions,
    net_pay,
  };
}

/**
 * @param {"daily"|"hourly"} rate_type
 * @param {number} pay_rate
 * @param {number} days_worked — present + late (calendar days with valid clock-in)
 * @param {number} total_hours_worked — sum of hours_worked for the month
 */
function computeGrossPay({ rate_type, pay_rate, days_worked, total_hours_worked }) {
  const rate = Number(pay_rate) || 0;
  if (rate_type === "hourly") {
    const h = Number(total_hours_worked) || 0;
    return roundKes(h * rate);
  }
  const d = Number(days_worked) || 0;
  return roundKes(d * rate);
}

module.exports = {
  HOUSING_LEVY_RATE,
  NSSF_STATUTORY_RATE,
  SHA_RATE,
  roundKes,
  computeKenyaStatutoryDeductions,
  computeGrossPay,
};
