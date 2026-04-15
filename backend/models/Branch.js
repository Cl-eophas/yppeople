const mongoose = require("mongoose");

const branchSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    address: { type: String, required: true },
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true },
    radius_meters: { type: Number, default: 1000 },

    // Branch-level shift settings (used for clock-in rules + defaults)
    default_shift_start_time: { type: String, default: "08:00" }, // "HH:mm"
    clock_in_window_minutes: { type: Number, default: 60 }, // minutes after shift start

    is_active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Branch", branchSchema);
