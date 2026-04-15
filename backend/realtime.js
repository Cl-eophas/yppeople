let io = null;

exports.setSocketIO = (instance) => {
  io = instance;
};

/**
 * Broadcast after clock-in/out or manual attendance so dashboards refresh.
 * @param {{ branch_id?: import("mongoose").Types.ObjectId, date: string }} payload
 */
exports.emitAttendanceChanged = (payload) => {
  if (!io) return;
  try {
    if (payload.branch_id) io.to(`branch:${payload.branch_id.toString()}`).emit("attendance:changed", payload);
    io.to("admins").emit("attendance:changed", payload);
  } catch (e) {
    console.error("[emitAttendanceChanged]", e.message);
  }
};
