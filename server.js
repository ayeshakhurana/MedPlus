const express = require("express");
const cors = require("cors");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const { db, initDb } = require("./db");

initDb();

const app = express();

app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const PORT = process.env.PORT || 3000;

function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, username: user.username },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing auth token" });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db
      .prepare("SELECT id, role, username, full_name as fullName FROM users WHERE id = ?")
      .get(payload.sub);
    if (!user) return res.status(401).json({ error: "Invalid token" });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    if (req.user.role !== role) return res.status(403).json({ error: "Forbidden" });
    next();
  };
}

// ---------- Auth ----------
// /api/auth/login  -> only logs in existing profiles
// /api/auth/signup -> creates new profiles if they don't exist

function validateAuthInput(req, res) {
  const role = String(req.body.role || "");
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const fullNameInput = String(req.body.fullName || "").trim();

  if (role !== "doctor" && role !== "patient") {
    res.status(400).json({ error: "Invalid role" });
    return null;
  }
  if (!username || username.length < 3) {
    res.status(400).json({ error: "Username too short" });
    return null;
  }
  if (!password || password.length < 4) {
    res.status(400).json({ error: "Password too short" });
    return null;
  }

  return { role, username, password, fullNameInput };
}

app.post("/api/auth/login", (req, res) => {
  const input = validateAuthInput(req, res);
  if (!input) return;

  const { role, username, password } = input;

  const existing = db
    .prepare(
      "SELECT id, role, username, password_hash as passwordHash, full_name as fullName FROM users WHERE username = ? AND role = ?"
    )
    .get(username, role);

  if (!existing) {
    return res
      .status(404)
      .json({ error: "Profile not found. Please sign up first." });
  }

  const ok = bcrypt.compareSync(password, existing.passwordHash);
  if (!ok) return res.status(401).json({ error: "Invalid credentials" });

  const user = { id: existing.id, role: existing.role, username, fullName: existing.fullName };
  return res.json({ token: signToken(user), user, created: false });
});

app.post("/api/auth/signup", (req, res) => {
  const input = validateAuthInput(req, res);
  if (!input) return;

  const { role, username, password, fullNameInput } = input;

  const existing = db
    .prepare(
      "SELECT id FROM users WHERE username = ? AND role = ?"
    )
    .get(username, role);

  if (existing) {
    return res
      .status(409)
      .json({ error: "Profile already exists. Please log in instead." });
  }

  const fullName =
    fullNameInput ||
    (role === "doctor"
      ? `Dr. ${username.charAt(0).toUpperCase()}${username.slice(1)}`
      : `${username.charAt(0).toUpperCase()}${username.slice(1)}`);
  const passwordHash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare(
      "INSERT INTO users (role, username, password_hash, full_name) VALUES (?,?,?,?)"
    )
    .run(role, username, passwordHash, fullName);
  const user = { id: info.lastInsertRowid, role, username, fullName };
  return res.json({ token: signToken(user), user, created: true });
});

app.get("/api/me", auth, (req, res) => {
  res.json({ user: req.user });
});

app.get("/api/doctors", auth, (req, res) => {
  const doctors = db
    .prepare("SELECT id, full_name as fullName, username FROM users WHERE role = 'doctor' ORDER BY full_name")
    .all();
  res.json({ doctors });
});

// ---------- Appointments ----------
app.get("/api/appointments", auth, (req, res) => {
  if (req.user.role === "doctor") {
    const rows = db
      .prepare(
        `
        SELECT a.id, a.date, a.time, a.reason, a.status,
               p.full_name as patientName, p.username as patientUsername
        FROM appointments a
        JOIN users p ON p.id = a.patient_id
        WHERE a.doctor_id = ?
        ORDER BY a.date, a.time
        `
      )
      .all(req.user.id);
    return res.json({ appointments: rows });
  }

  const rows = db
    .prepare(
      `
      SELECT a.id, a.date, a.time, a.reason, a.status,
             d.full_name as doctorName, d.username as doctorUsername
      FROM appointments a
      JOIN users d ON d.id = a.doctor_id
      WHERE a.patient_id = ?
      ORDER BY a.date, a.time
      `
    )
    .all(req.user.id);
  return res.json({ appointments: rows });
});

app.post("/api/appointments", auth, requireRole("patient"), (req, res) => {
  const doctorId = Number(req.body.doctorId);
  const date = String(req.body.date || "");
  const time = String(req.body.time || "");
  const reason = String(req.body.reason || "").trim();

  if (!doctorId || !date || !time || !reason) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const doctor = db
    .prepare("SELECT id FROM users WHERE id = ? AND role = 'doctor'")
    .get(doctorId);
  if (!doctor) return res.status(400).json({ error: "Invalid doctor" });

  // Optional: prevent duplicates (same patient+doctor+date+time)
  const exists = db
    .prepare(
      "SELECT id FROM appointments WHERE doctor_id = ? AND patient_id = ? AND date = ? AND time = ?"
    )
    .get(doctorId, req.user.id, date, time);
  if (exists) return res.status(409).json({ error: "Slot already booked by you" });

  const info = db
    .prepare(
      "INSERT INTO appointments (doctor_id, patient_id, date, time, reason, status) VALUES (?,?,?,?,?, 'pending')"
    )
    .run(doctorId, req.user.id, date, time, reason);
  res.json({ id: info.lastInsertRowid });
});

app.patch("/api/appointments/:id/status", auth, requireRole("doctor"), (req, res) => {
  const id = Number(req.params.id);
  const status = String(req.body.status || "");

  if (!id) return res.status(400).json({ error: "Invalid appointment id" });
  if (status !== "booked" && status !== "denied") {
    return res.status(400).json({ error: "Invalid status" });
  }

  const appt = db
    .prepare("SELECT id, doctor_id as doctorId, status FROM appointments WHERE id = ?")
    .get(id);
  if (!appt) return res.status(404).json({ error: "Appointment not found" });
  if (appt.doctorId !== req.user.id) return res.status(403).json({ error: "Forbidden" });

  // only allow decision when pending (keep simple + predictable)
  if (appt.status !== "pending") {
    return res.status(409).json({ error: "Appointment already decided" });
  }

  db.prepare("UPDATE appointments SET status = ? WHERE id = ?").run(status, id);
  res.json({ ok: true });
});

// ---------- Records ----------
app.get("/api/records", auth, (req, res) => {
  if (req.user.role === "patient") {
    const rows = db
      .prepare(
        `
        SELECT r.id, r.notes, r.created_at as createdAt,
               d.full_name as doctorName
        FROM records r
        JOIN users d ON d.id = r.doctor_id
        WHERE r.patient_id = ?
        ORDER BY r.created_at DESC
        `
      )
      .all(req.user.id);
    return res.json({ records: rows });
  }

  // doctor: optionally filter by patientUsername
  const patientUsername = String(req.query.patientUsername || "").trim();
  let rows;
  if (patientUsername) {
    rows = db
      .prepare(
        `
        SELECT r.id, r.notes, r.created_at as createdAt,
               p.full_name as patientName, p.username as patientUsername
        FROM records r
        JOIN users p ON p.id = r.patient_id
        WHERE r.doctor_id = ? AND p.username = ?
        ORDER BY r.created_at DESC
        `
      )
      .all(req.user.id, patientUsername);
  } else {
    rows = db
      .prepare(
        `
        SELECT r.id, r.notes, r.created_at as createdAt,
               p.full_name as patientName, p.username as patientUsername
        FROM records r
        JOIN users p ON p.id = r.patient_id
        WHERE r.doctor_id = ?
        ORDER BY r.created_at DESC
        `
      )
      .all(req.user.id);
  }
  return res.json({ records: rows });
});

app.post("/api/records", auth, requireRole("doctor"), (req, res) => {
  const patientUsername = String(req.body.patientUsername || "").trim();
  const notes = String(req.body.notes || "").trim();
  if (!patientUsername || !notes) return res.status(400).json({ error: "Missing fields" });

  const patient = db
    .prepare("SELECT id FROM users WHERE username = ? AND role = 'patient'")
    .get(patientUsername);
  if (!patient) return res.status(404).json({ error: "Patient not found" });

  const info = db
    .prepare("INSERT INTO records (doctor_id, patient_id, notes) VALUES (?,?,?)")
    .run(req.user.id, patient.id, notes);
  res.json({ id: info.lastInsertRowid });
});

// ---------- Inventory ----------
app.get("/api/inventory", auth, requireRole("doctor"), (req, res) => {
  const items = db
    .prepare("SELECT medicine, stock, price FROM inventory ORDER BY medicine")
    .all();
  res.json({ inventory: items });
});

// ---------- Billing ----------
app.get("/api/bills", auth, (req, res) => {
  if (req.user.role === "patient") {
    const rows = db
      .prepare(
        `
        SELECT b.id, b.medicine, b.quantity, b.unit_price as unitPrice, b.total,
               b.created_at as createdAt, d.full_name as doctorName
        FROM bills b
        JOIN users d ON d.id = b.doctor_id
        WHERE b.patient_id = ?
        ORDER BY b.created_at DESC
        `
      )
      .all(req.user.id);
    return res.json({ bills: rows });
  }

  const rows = db
    .prepare(
      `
      SELECT b.id, b.medicine, b.quantity, b.unit_price as unitPrice, b.total,
             b.created_at as createdAt, p.full_name as patientName, p.username as patientUsername
      FROM bills b
      JOIN users p ON p.id = b.patient_id
      WHERE b.doctor_id = ?
      ORDER BY b.created_at DESC
      `
    )
    .all(req.user.id);
  return res.json({ bills: rows });
});

app.post("/api/bills", auth, requireRole("doctor"), (req, res) => {
  const patientUsername = String(req.body.patientUsername || "").trim();
  const medicineName = String(req.body.medicine || "").trim();
  const quantity = Number(req.body.quantity);
  if (!patientUsername || !medicineName || !quantity || quantity <= 0) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const patient = db
    .prepare("SELECT id, full_name as fullName FROM users WHERE username = ? AND role = 'patient'")
    .get(patientUsername);
  if (!patient) return res.status(404).json({ error: "Patient not found" });

  const item = db
    .prepare("SELECT medicine, stock, price FROM inventory WHERE lower(medicine) = lower(?)")
    .get(medicineName);
  if (!item) return res.status(404).json({ error: "Medicine not found" });
  if (item.stock < quantity) return res.status(400).json({ error: "Not enough stock" });

  const total = quantity * item.price;

  const tx = db.transaction(() => {
    db.prepare("UPDATE inventory SET stock = stock - ? WHERE medicine = ?").run(
      quantity,
      item.medicine
    );
    const info = db
      .prepare(
        "INSERT INTO bills (doctor_id, patient_id, medicine, quantity, unit_price, total) VALUES (?,?,?,?,?,?)"
      )
      .run(req.user.id, patient.id, item.medicine, quantity, item.price, total);
    return info.lastInsertRowid;
  });

  const billId = tx();
  res.json({
    id: billId,
    patient: patient.fullName,
    medicine: item.medicine,
    quantity,
    unitPrice: item.price,
    total,
    dateTime: new Date().toLocaleString(),
    number: `BILL-${billId}`,
  });
});

// ---------- Static frontend ----------
app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`MedPlus server running on http://localhost:${PORT}`);
});

