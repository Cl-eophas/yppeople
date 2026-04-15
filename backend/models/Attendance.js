const mongoose = require("mongoose");

const attendanceSchema = new mongoose.Schema(
  {
    staff_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    date: { type: String, required: true },
    clock_in: Date,
    clock_out: Date,
    location_in: { latitude: Number, longitude: Number },
    location_out: { latitude: Number, longitude: Number },
    is_forced: { type: Boolean, default: false },
    is_supervisor_entry: { type: Boolean, default: false },
    auto_clocked_out: { type: Boolean, default: false },
    status: {
      type: String,
      enum: ["present", "late", "forced", "supervisor_assisted", "absent", "leave", "unscheduled"],
      default: "present",
    },
    shift_start: Date,
    late_minutes: { type: Number, default: 0 },
    notes: String,
  },
  { timestamps: true }
);

attendanceSchema.index({ staff_id: 1, date: 1 }, { unique: true });
attendanceSchema.index({ date: 1 });

module.exports = mongoose.model("Attendance", attendanceSchema);
