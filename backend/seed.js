/**
 * WMS Seed — run from project root: npm run seed
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const mongoose = require("mongoose");

const User = require("./models/User");
const StaffProfile = require("./models/StaffProfile");
const Branch = require("./models/Branch");
const LeaveBalance = require("./models/LeaveBalance");
const Notification = require("./models/Notification");
const Session = require("./models/Session");
const Attendance = require("./models/Attendance");
const Leave = require("./models/Leave");
const Uniform = require("./models/Uniform");
const AuditLog = require("./models/AuditLog");
const SecurityEvent = require("./models/SecurityEvent");
const Contract = require("./models/Contract");
const Shift = require("./models/Shift");
const OffDay = require("./models/OffDay");
const AttendanceReport = require("./models/AttendanceReport");

const { calcAnnualLeaveAccrual } = require("./utils/dateHelpers");
const { nextYPStaffId } = require("./utils/staffId");
const { addShiftHours } = require("./utils/shiftTime");

async function seedDatabase({ connect = true, disconnect = true } = {}) {
  if (connect) {
    await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/wms_db");
  } else if (mongoose.connection.readyState !== 1) {
    throw new Error("MongoDB not connected. Start server or call seed with connect=true.");
  }

  await Promise.all([
    User.deleteMany({}),
    StaffProfile.deleteMany({}),
    Branch.deleteMany({}),
    LeaveBalance.deleteMany({}),
    Notification.deleteMany({}),
    Session.deleteMany({}),
    Attendance.deleteMany({}),
    Leave.deleteMany({}),
    Uniform.deleteMany({}),
    AuditLog.deleteMany({}),
    SecurityEvent.deleteMany({}),
    Shift.deleteMany({}),
    OffDay.deleteMany({}),
    AttendanceReport.deleteMany({}),
  ]);

  const summary = { cleared: true };

  const branch = await Branch.create({
    name: "Nairobi CBD Branch",
    address: "Kenyatta Avenue, Nairobi, Kenya",
    latitude: -1.2921,
    longitude: 36.8219,
    radius_meters: 1000,
    default_shift_start_time: "08:00",
    clock_in_window_minutes: 60,
  });
  summary.branch = { id: branch._id.toString(), name: branch.name };

  const admin = await User.create({
    name: "System Admin",
    email: "admin@wms.co.ke",
    password: "Admin@1234",
    role: "admin",
    branch_id: branch._id,
    status: "approved",
    is_active: true,
    profileCompleted: true,
  });
  summary.admin = { email: admin.email, password: "Admin@1234" };

  const supervisor = await User.create({
    name: "Jane Supervisor",
    email: "supervisor@wms.co.ke",
    password: "Supervisor@1234",
    role: "supervisor",
    branch_id: branch._id,
    status: "approved",
    is_active: true,
    profileCompleted: true,
  });
  const supJoin = new Date("2023-01-01");
  const supStaffId = await nextYPStaffId(supJoin);
  await StaffProfile.create({
    user_id: supervisor._id,
    staff_id: supStaffId,
    type: "contract",
    join_date: supJoin,
    pay_rate: 3000,
  });
  summary.supervisor = { email: supervisor.email, password: "Supervisor@1234", staff_id: supStaffId };

  const staffData = [
    { name: "Alice Kamau", email: "alice@wms.co.ke", type: "casual", joined: "2024-01-15", rate: 1500 },
    { name: "Bob Otieno", email: "bob@wms.co.ke", type: "reliever", joined: "2023-11-01", rate: 1800 },
    { name: "Carol Njeri", email: "carol@wms.co.ke", type: "contract", joined: "2023-06-01", rate: 2200 },
  ];

  const seedStartTime = "08:00";
  const seedEnd = addShiftHours(seedStartTime);

  for (const s of staffData) {
    const user = await User.create({
      name: s.name,
      email: s.email,
      password: "Staff@1234",
      role: "staff",
      branch_id: branch._id,
      status: "approved",
      is_active: true,
      profileCompleted: true,
    });
    const joinDate = new Date(s.joined);
    const accrued = calcAnnualLeaveAccrual(joinDate);
    const staffId = await nextYPStaffId(joinDate);

    await StaffProfile.create({
      user_id: user._id,
      staff_id: staffId,
      type: s.type,
      join_date: joinDate,
      pay_rate: s.rate,
    });
    user.staffId = staffId;
    await user.save({ validateModifiedOnly: true });

    // Ensure contract-type staff can clock in immediately (seed accepted active contract)
    if (s.type === "contract") {
      await Contract.create({
        staff_id: user._id,
        contract_text: "Seed contract: Staff employment agreement (test environment).",
        start_date: new Date(Date.now() - 30 * 86400000),
        end_date: new Date(Date.now() + 365 * 86400000),
        accepted: true,
        signed_at: new Date(),
        created_by: admin._id,
      });
    }
    await LeaveBalance.create({
      staff_id: user._id,
      annual_balance: accrued,
      sick_full_used: 0,
      sick_half_used: 0,
    });
    await Notification.create({
      user_id: user._id,
      message: `Welcome to YPPEOPLE WMS, ${s.name.split(" ")[0]}! Clock-in window is 08:00 – 09:00 daily.`,
      type: "info",
    });

    if (!summary.staff) summary.staff = [];
    summary.staff.push({ email: user.email, password: "Staff@1234", staff_id: staffId, type: s.type });

    for (let add = 0; add < 21; add++) {
      const d = new Date();
      d.setDate(d.getDate() + add);
      const ymd = d.toISOString().slice(0, 10);
      await Shift.create({
        staff_id: user._id,
        branch_id: branch._id,
        shift_date: ymd,
        start_time: seedStartTime,
        end_time: seedEnd.end_time,
        end_next_day: seedEnd.end_next_day,
        assigned_by: admin._id,
      });
    }
  }

  supervisor.staffId = supStaffId;
  await supervisor.save({ validateModifiedOnly: true });

  // Ensure contract-type supervisor can clock in immediately (seed accepted active contract)
  await Contract.create({
    staff_id: supervisor._id,
    contract_text: "Seed contract: Supervisor employment agreement (test environment).",
    start_date: new Date(Date.now() - 30 * 86400000),
    end_date: new Date(Date.now() + 365 * 86400000),
    accepted: true,
    signed_at: new Date(),
    created_by: admin._id,
  });

  for (let add = 0; add < 21; add++) {
    const d = new Date();
    d.setDate(d.getDate() + add);
    const ymd = d.toISOString().slice(0, 10);
    await Shift.create({
      staff_id: supervisor._id,
      branch_id: branch._id,
      shift_date: ymd,
      start_time: seedStartTime,
      end_time: seedEnd.end_time,
      end_next_day: seedEnd.end_next_day,
      assigned_by: admin._id,
    });
  }

  if (disconnect) await mongoose.disconnect();
  return summary;
}

module.exports = { seedDatabase };

if (require.main === module) {
  seedDatabase({ connect: true, disconnect: true })
    .then((s) => {
      console.log("✅ Seed complete");
      console.log(s);
      process.exit(0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
