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
const Shift = require("./models/Shift");
const OffDay = require("./models/OffDay");
const AttendanceReport = require("./models/AttendanceReport");

const { calcAnnualLeaveAccrual } = require("./utils/dateHelpers");
const { nextYPStaffId } = require("./utils/staffId");
const { addShiftHours } = require("./utils/shiftTime");

async function seed() {
  await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/wms_db");
  console.log("✅  Connected to MongoDB\n");

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
  console.log("🧹  Cleared existing data\n");

  const branch = await Branch.create({
    name: "Nairobi CBD Branch",
    address: "Kenyatta Avenue, Nairobi, Kenya",
    latitude: -1.2921,
    longitude: 36.8219,
    radius_meters: 1000,
  });
  console.log(`🏢  Branch: ${branch.name}`);

  const admin = await User.create({
    name: "System Admin",
    email: "admin@wms.co.ke",
    password: "Admin@1234",
    role: "admin",
    branch_id: branch._id,
    is_active: true,
  });
  console.log(`👑  Admin: ${admin.email}  /  Admin@1234`);

  const supervisor = await User.create({
    name: "Jane Supervisor",
    email: "supervisor@wms.co.ke",
    password: "Supervisor@1234",
    role: "supervisor",
    branch_id: branch._id,
    is_active: true,
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
  console.log(`🔷  Supervisor: ${supervisor.email}  (${supStaffId})  /  Supervisor@1234`);

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
      is_active: true,
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
    console.log(`👤  Staff: ${user.email}  (${staffId})  /  Staff@1234`);

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

  console.log(`
╔══════════════════════════════════════════════════════╗
║              YPPEOPLE WMS SEED COMPLETE               ║
╠══════════════════════════════════════════════════════╣
║  Admin       admin@wms.co.ke        Admin@1234       ║
║  Supervisor  supervisor@wms.co.ke  Supervisor@1234 ║
║  Staff       alice@wms.co.ke        Staff@1234       ║
╚══════════════════════════════════════════════════════╝

Start: npm start
Open:  http://localhost:5000/
`);

  await mongoose.disconnect();
  process.exit(0);
}

seed().catch((e) => {
  console.error(e);
  process.exit(1);
});
