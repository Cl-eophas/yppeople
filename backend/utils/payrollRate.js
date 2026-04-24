/**
 * Normalizes admin request bodies that may send `pay_rate` (canonical) or `rate` (legacy).
 */
const parsePayRateBody = (body) => {
  const raw = body.pay_rate != null ? body.pay_rate : body.rate;
  if (raw == null || raw === "") return { error: "Rate must be a positive number." };
  const rate = parseFloat(raw);
  if (isNaN(rate) || rate <= 0) return { error: "Rate must be a positive number." };
  if (rate > 50000) return { error: "Rate exceeds maximum allowed (KES 50,000/day). Flag for review." };
  return { rate };
};

module.exports = { parsePayRateBody };
