const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema(
  {
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    message: { type: String, required: true },
    type: {
      type: String,
      enum: ["info", "warning", "leave", "attendance", "pay", "broadcast", "shift", "report"],
      default: "info",
    },
    is_read: { type: Boolean, default: false },
    read_at: Date,
  },
  { timestamps: true }
);

module.exports = mongoose.model("Notification", notificationSchema);
