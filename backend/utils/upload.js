const path = require("path");
const fs = require("fs");
const multer = require("multer");

const uploadDir = path.join(__dirname, "..", "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uid = req.user?._id?.toString() || "anon";
    const ext = path.extname(file.originalname || "").toLowerCase();
    cb(null, `doc_${uid}_${Date.now()}${ext}`);
  },
});

const fileFilter = (_req, file, cb) => {
  const ok = [".pdf", ".jpg", ".jpeg", ".png"].includes(path.extname(file.originalname || "").toLowerCase());
  if (ok) cb(null, true);
  else cb(new Error("Only PDF, JPG, JPEG, PNG allowed."));
};

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter,
});

module.exports = { upload };
