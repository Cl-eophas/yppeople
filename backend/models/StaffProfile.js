const mongoose = require("mongoose");

const staffProfileSchema = new mongoose.Schema(
  {
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    staff_id: { type: String, required: true, unique: true },
    type: { type: String, enum: ["casual", "reliever", "contract", "supervisor"], required: true },
    join_date: { type: Date, required: true },
    phone: { type: String, trim: true },
    address: { type: String, trim: true },
    pay_rate: { type: Number, default: 0 },
    /** bank | mpesa — how net pay is disbursed (admin-managed). */
    payment_mode: { type: String, enum: ["bank", "mpesa"], default: "bank" },
    rate_history: [
      {
        rate: Number,
        effective_date: Date,
        set_by: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      },
    ],
  },
  { timestamps: true }
);

module.exports = mongoose.model("StaffProfile", staffProfileSchema);
