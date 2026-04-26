const express = require("express");
const cors = require("cors");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const { db, initDb } = require("./db");

initDb();

const app = express();

app.use(cors());
app.use(express.json({ limit: "15mb" }));

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const PORT = process.env.PORT || 3000;

// ─── Auth helpers ────────────────────────────────────────────────────────────

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

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    if (!roles.includes(req.user.role))
      return res.status(403).json({ error: "Forbidden" });
    next();
  };
}

function validateAuthInput(req, res) {
  const role = String(req.body.role || "");
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const fullNameInput = String(req.body.fullName || "").trim();

  if (!["doctor", "patient", "pharmacist"].includes(role)) {
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

// ─── AI helpers ──────────────────────────────────────────────────────────────

const DRUG_CLASS_MAP = {
  aspirin: ["aspirin"],
  warfarin: ["warfarin", "coumadin"],
  ibuprofen: ["ibuprofen", "advil", "motrin", "brufen"],
  naproxen: ["naproxen", "aleve"],
  paracetamol: ["paracetamol", "acetaminophen", "tylenol"],
  metformin: ["metformin", "glucophage"],
  ssri: ["fluoxetine", "sertraline", "paroxetine", "escitalopram", "citalopram"],
  "ace inhibitor": ["lisinopril", "enalapril", "ramipril", "captopril", "perindopril"],
  statin: ["atorvastatin", "simvastatin", "rosuvastatin", "lovastatin", "pravastatin"],
  "beta blocker": ["metoprolol", "atenolol", "propranolol", "bisoprolol", "carvedilol"],
  "calcium channel blocker": ["amlodipine", "nifedipine", "diltiazem", "verapamil"],
  nsaid: ["ibuprofen", "naproxen", "diclofenac", "celecoxib", "indomethacin", "aspirin"],
  amiodarone: ["amiodarone"],
  digoxin: ["digoxin", "digitalis"],
  tramadol: ["tramadol", "ultram"],
  erythromycin: ["erythromycin", "clarithromycin", "azithromycin"],
  linezolid: ["linezolid"],
  methotrexate: ["methotrexate"],
  potassium: ["potassium", "potassium chloride", "k-dur", "kalium"],
  alcohol: ["alcohol", "ethanol"],
  clopidogrel: ["clopidogrel", "plavix"],
  sildenafil: ["sildenafil", "viagra", "tadalafil", "cialis"],
  nitrate: ["nitroglycerin", "isosorbide", "nitrate"],
};

const DRUG_INTERACTIONS = [
  { drugs: ["warfarin", "aspirin"], risk: "HIGH", message: "Increased bleeding risk — monitor INR closely" },
  { drugs: ["warfarin", "nsaid"], risk: "HIGH", message: "NSAIDs significantly increase warfarin effect — serious bleeding risk" },
  { drugs: ["warfarin", "erythromycin"], risk: "HIGH", message: "Macrolides inhibit warfarin metabolism — INR may spike" },
  { drugs: ["ssri", "tramadol"], risk: "HIGH", message: "Risk of serotonin syndrome — potentially life-threatening" },
  { drugs: ["ssri", "linezolid"], risk: "HIGH", message: "Serotonin syndrome risk — contraindicated combination" },
  { drugs: ["digoxin", "amiodarone"], risk: "HIGH", message: "Amiodarone raises digoxin levels — toxicity risk" },
  { drugs: ["methotrexate", "nsaid"], risk: "HIGH", message: "NSAIDs reduce methotrexate clearance — serious toxicity" },
  { drugs: ["clopidogrel", "aspirin"], risk: "MODERATE", message: "Dual antiplatelet therapy increases bleeding risk" },
  { drugs: ["sildenafil", "nitrate"], risk: "HIGH", message: "Severe hypotension — contraindicated combination" },
  { drugs: ["ace inhibitor", "potassium"], risk: "MODERATE", message: "Hyperkalemia risk — monitor potassium levels" },
  { drugs: ["ace inhibitor", "nsaid"], risk: "MODERATE", message: "Reduced antihypertensive effect; nephrotoxicity risk" },
  { drugs: ["statin", "amiodarone"], risk: "MODERATE", message: "Increased risk of myopathy and rhabdomyolysis" },
  { drugs: ["statin", "erythromycin"], risk: "MODERATE", message: "Macrolides raise statin levels — myopathy risk" },
  { drugs: ["beta blocker", "calcium channel blocker"], risk: "MODERATE", message: "Additive effect may cause bradycardia or heart block" },
  { drugs: ["paracetamol", "alcohol"], risk: "MODERATE", message: "Excessive alcohol with paracetamol causes hepatotoxicity" },
  { drugs: ["aspirin", "ibuprofen"], risk: "LOW", message: "Ibuprofen may reduce aspirin's antiplatelet cardioprotective effect" },
  { drugs: ["metformin", "alcohol"], risk: "MODERATE", message: "Increased risk of lactic acidosis" },
];

function checkDrugInteractions(medicineNames) {
  const lowered = medicineNames.map((m) => m.toLowerCase().trim());

  const classSet = new Set(lowered);
  lowered.forEach((med) => {
    for (const [cls, drugs] of Object.entries(DRUG_CLASS_MAP)) {
      if (drugs.some((d) => med.includes(d) || d.includes(med))) {
        classSet.add(cls);
      }
    }
  });
  const classes = Array.from(classSet);

  const warnings = [];
  DRUG_INTERACTIONS.forEach((interaction) => {
    const [d1, d2] = interaction.drugs;
    const hit1 = classes.some((c) => c.includes(d1) || d1.includes(c));
    const hit2 = classes.some((c) => c.includes(d2) || d2.includes(c));
    if (hit1 && hit2 && !warnings.find((w) => w.message === interaction.message)) {
      warnings.push({ drugs: interaction.drugs, risk: interaction.risk, message: interaction.message });
    }
  });

  const riskLevel = warnings.some((w) => w.risk === "HIGH")
    ? "HIGH"
    : warnings.some((w) => w.risk === "MODERATE")
    ? "MODERATE"
    : "SAFE";

  return {
    riskLevel,
    warnings,
    recommendation:
      riskLevel === "HIGH"
        ? "Prescription flagged — pharmacist review required before dispensing"
        : riskLevel === "MODERATE"
        ? "Minor interactions found — use with caution and monitor patient"
        : "No significant drug interactions detected",
    checkedAt: new Date().toISOString(),
    model: "MedPlus Drug Interaction Engine v1.0",
  };
}

function predictDiseaseRisk(metrics = {}) {
  const risks = [];

  let cvScore = 0;
  if (metrics.bp_systolic > 140) cvScore += 35;
  else if (metrics.bp_systolic > 130) cvScore += 20;
  else if (metrics.bp_systolic > 120) cvScore += 10;
  if (metrics.bp_diastolic > 90) cvScore += 25;
  else if (metrics.bp_diastolic > 80) cvScore += 10;
  if (metrics.blood_sugar > 200) cvScore += 25;
  else if (metrics.blood_sugar > 125) cvScore += 15;
  risks.push({
    condition: "Cardiovascular Disease",
    score: Math.min(cvScore, 100),
    level: cvScore >= 50 ? "HIGH" : cvScore >= 25 ? "MODERATE" : "LOW",
  });

  let dbScore = 0;
  if (metrics.blood_sugar > 200) dbScore += 65;
  else if (metrics.blood_sugar > 125) dbScore += 45;
  else if (metrics.blood_sugar > 100) dbScore += 20;
  if (metrics.weight > 95) dbScore += 20;
  else if (metrics.weight > 80) dbScore += 10;
  risks.push({
    condition: "Type 2 Diabetes",
    score: Math.min(dbScore, 100),
    level: dbScore >= 50 ? "HIGH" : dbScore >= 25 ? "MODERATE" : "LOW",
  });

  let htScore = 0;
  if (metrics.bp_systolic > 140) htScore += 70;
  else if (metrics.bp_systolic > 130) htScore += 45;
  else if (metrics.bp_systolic > 120) htScore += 20;
  if (metrics.bp_diastolic > 90) htScore += 30;
  else if (metrics.bp_diastolic > 80) htScore += 15;
  risks.push({
    condition: "Hypertension",
    score: Math.min(htScore, 100),
    level: htScore >= 50 ? "HIGH" : htScore >= 25 ? "MODERATE" : "LOW",
  });

  return risks;
}

const SCAN_TEMPLATES = {
  MRI: [
    { anomaly: false, confidence: 0.91, findings: "No significant intracranial abnormality detected. Brain parenchyma appears normal." },
    { anomaly: true, confidence: 0.78, findings: "Small T2 hyperintense lesion in right temporal lobe (~8 mm). Recommend clinical correlation." },
    { anomaly: true, confidence: 0.83, findings: "Mild periventricular white matter changes consistent with small vessel disease." },
  ],
  CT: [
    { anomaly: false, confidence: 0.93, findings: "Normal CT scan. No acute intracranial hemorrhage, mass, or midline shift." },
    { anomaly: true, confidence: 0.74, findings: "Hypodense area noted in right basal ganglia — likely lacunar infarct. Clinical correlation needed." },
    { anomaly: true, confidence: 0.86, findings: "Mild cerebral volume loss consistent with age-related atrophy." },
  ],
  "X-ray": [
    { anomaly: false, confidence: 0.95, findings: "Clear lung fields. Cardiac silhouette normal. No active pulmonary disease." },
    { anomaly: true, confidence: 0.80, findings: "Increased bronchovascular markings bilaterally — suggestive of early bronchitis or mild congestion." },
    { anomaly: true, confidence: 0.82, findings: "Cardiomegaly detected. Cardiac silhouette is enlarged (CTR > 0.5). Echo recommended." },
  ],
  Ultrasound: [
    { anomaly: false, confidence: 0.90, findings: "Normal abdominal ultrasound. Liver, kidneys, spleen, pancreas within normal limits." },
    { anomaly: true, confidence: 0.77, findings: "Mild hepatomegaly — liver measures 15.8 cm. Consider LFT workup." },
    { anomaly: true, confidence: 0.94, findings: "Cholelithiasis: 3 calculi detected in gallbladder (average 9 mm). Surgical consult advised." },
  ],
  ECG: [
    { anomaly: false, confidence: 0.96, findings: "Normal sinus rhythm. Rate 74 bpm. No significant ST-T changes or conduction abnormalities." },
    { anomaly: true, confidence: 0.97, findings: "Sinus tachycardia — rate 112 bpm. No acute ischemic changes." },
    { anomaly: true, confidence: 0.81, findings: "Left ventricular hypertrophy pattern with repolarisation changes. Cardiology review recommended." },
  ],
};

const SCAN_TEMPLATES_EXTRA = {
  "Blood Test": [
    { anomaly: false, confidence: 0.97, findings: "CBC, LFT, RFT all within normal reference ranges. No significant abnormalities detected." },
    { anomaly: true,  confidence: 0.89, findings: "Elevated WBC (14,200/µL) suggesting infection or inflammation. CRP raised at 28 mg/L. Haemoglobin mildly low at 10.8 g/dL." },
    { anomaly: true,  confidence: 0.92, findings: "HbA1c 8.4% — poor glycaemic control. Fasting glucose 198 mg/dL. LDL cholesterol elevated at 168 mg/dL." },
  ],
};

function analyzeScan(scanType) {
  const allTemplates = { ...SCAN_TEMPLATES, ...SCAN_TEMPLATES_EXTRA };
  const templates = allTemplates[scanType] || SCAN_TEMPLATES["X-ray"];
  const t = templates[Math.floor(Math.random() * templates.length)];
  return {
    scanType,
    anomalyDetected: t.anomaly,
    confidenceScore: t.confidence,
    findings: t.findings,
    recommendation: t.anomaly
      ? "Recommend clinical correlation and possible follow-up imaging or specialist referral."
      : "No immediate follow-up required. Routine monitoring advised.",
    analyzedAt: new Date().toISOString(),
    model: "MedPlus Scan AI v1.0",
  };
}

function generateChatResponse(message, history) {
  const msg = message.toLowerCase();
  const { appointments = [], records = [], prescriptions = [], metrics } = history;

  if (/^(hi|hello|hey|good morning|good evening|howdy)/i.test(msg)) {
    return `Hello! I'm your MedPlus AI health assistant. I can help you with:\n• Your appointments & schedules\n• Your prescriptions & medicines\n• Your medical records\n• Your health metrics & risk assessment\n\nWhat would you like to know?`;
  }

  if (/emergency|urgent|chest pain|heart attack|stroke|can't breathe/i.test(msg)) {
    return "🚨 If you are experiencing a medical emergency, call 108 immediately or go to the nearest emergency room. Do not rely on this chatbot for emergencies.";
  }

  if (/appointment|booking|schedule|visit|doctor.*when/i.test(msg)) {
    const upcoming = appointments.filter((a) => a.status === "booked");
    if (upcoming.length > 0) {
      const n = upcoming[0];
      return `You have ${upcoming.length} confirmed appointment${upcoming.length > 1 ? "s" : ""}. Next: ${n.doctorName} on ${n.date} at ${n.time} — "${n.reason}".`;
    }
    const pending = appointments.filter((a) => a.status === "pending");
    if (pending.length > 0)
      return `You have ${pending.length} pending appointment request${pending.length > 1 ? "s" : ""} awaiting doctor confirmation.`;
    return "You have no upcoming appointments. Use the Book Appointment section to schedule one.";
  }

  if (/prescription|medicine|medication|drug|tablet|capsule/i.test(msg)) {
    if (prescriptions.length > 0) {
      const latest = prescriptions[0];
      let meds = [];
      try { meds = JSON.parse(latest.medicines || "[]"); } catch { meds = []; }
      const medList = meds
        .map((m) => (typeof m === "string" ? m : `${m.name} (${m.dosage || ""}, ${m.frequency || ""})`))
        .join(", ");
      return `Latest prescription from Dr. ${latest.doctorName} (Status: ${latest.status}): ${medList || "details unavailable"}.${latest.pharmacist_notes ? ` Pharmacist note: ${latest.pharmacist_notes}` : ""}`;
    }
    return "No prescriptions found in your records.";
  }

  if (/record|report|diagnosis|result/i.test(msg)) {
    if (records.length > 0) {
      const r = records[0];
      return `Latest medical record from Dr. ${r.doctorName}: "${r.notes}"`;
    }
    return "No medical records found.";
  }

  if (/blood pressure|bp|hypertension|systolic|diastolic/i.test(msg)) {
    if (metrics && metrics.bp_systolic) {
      const s = metrics.bp_systolic;
      const status = s > 140 ? "high (Stage 2 hypertension)" : s > 130 ? "elevated (Stage 1 hypertension)" : s > 120 ? "slightly elevated" : "normal";
      return `Last recorded BP: ${metrics.bp_systolic}/${metrics.bp_diastolic} mmHg — ${status}.${s > 130 ? " Please consult your doctor." : " Keep it up!"}`;
    }
    return "No blood pressure data recorded yet. Add readings in Health Metrics.";
  }

  if (/blood sugar|glucose|sugar|diabetes|hba1c/i.test(msg)) {
    if (metrics && metrics.blood_sugar) {
      const sg = metrics.blood_sugar;
      const status = sg > 200 ? "very high (diabetic range)" : sg > 125 ? "high (pre-diabetic)" : sg > 100 ? "slightly elevated" : "normal";
      return `Last blood sugar: ${sg} mg/dL — ${status}.${sg > 125 ? " Please consult your doctor." : ""}`;
    }
    return "No blood sugar data recorded. Add it in Health Metrics.";
  }

  if (/weight|bmi|obesity|overweight/i.test(msg)) {
    if (metrics && metrics.weight)
      return `Recorded weight: ${metrics.weight} kg. Regular monitoring helps track health trends.`;
    return "No weight data recorded.";
  }

  if (/temperature|fever|temp/i.test(msg)) {
    if (metrics && metrics.temperature) {
      const status = metrics.temperature > 38.0 ? "elevated — possible fever" : "normal";
      return `Last temperature: ${metrics.temperature}°C — ${status}.`;
    }
    return "No temperature data recorded.";
  }

  if (/risk|danger|concern|health status/i.test(msg)) {
    if (metrics) {
      const risks = predictDiseaseRisk(metrics);
      const high = risks.filter((r) => r.level === "HIGH");
      const mod = risks.filter((r) => r.level === "MODERATE");
      if (high.length > 0)
        return `⚠️ Based on your metrics, HIGH risk for: ${high.map((r) => r.condition).join(", ")}. Please consult your doctor immediately.`;
      if (mod.length > 0)
        return `Based on your metrics, moderate risk for: ${mod.map((r) => r.condition).join(", ")}. Regular monitoring and lifestyle changes recommended.`;
      return "Your metrics indicate low risk across all tracked conditions. Keep it up!";
    }
    return "Add health metrics (BP, blood sugar, weight) to get a risk assessment.";
  }

  return `I can help you with:\n• "What are my upcoming appointments?"\n• "What medicines am I prescribed?"\n• "What's my blood pressure / blood sugar?"\n• "What's my health risk?"\n• "What does my latest report say?"`;
}

// ─── Auth ────────────────────────────────────────────────────────────────────

app.post("/api/auth/login", (req, res) => {
  const input = validateAuthInput(req, res);
  if (!input) return;

  const { role, username, password } = input;

  const existing = db
    .prepare(
      "SELECT id, role, username, password_hash as passwordHash, full_name as fullName FROM users WHERE username = ? AND role = ?"
    )
    .get(username, role);

  if (!existing)
    return res.status(404).json({ error: "Profile not found. Please sign up first." });

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
    .prepare("SELECT id FROM users WHERE username = ? AND role = ?")
    .get(username, role);

  if (existing)
    return res.status(409).json({ error: "Profile already exists. Please log in instead." });

  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const fullName =
    fullNameInput ||
    (role === "doctor"
      ? `Dr. ${cap(username)}`
      : role === "pharmacist"
      ? `Pharm. ${cap(username)}`
      : cap(username));

  const passwordHash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare("INSERT INTO users (role, username, password_hash, full_name) VALUES (?,?,?,?)")
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

app.get("/api/pharmacists", auth, (req, res) => {
  const pharmacists = db
    .prepare("SELECT id, full_name as fullName, username FROM users WHERE role = 'pharmacist' ORDER BY full_name")
    .all();
  res.json({ pharmacists });
});

// ─── Appointments ─────────────────────────────────────────────────────────────

app.get("/api/appointments", auth, (req, res) => {
  if (req.user.role === "doctor") {
    const rows = db
      .prepare(
        `SELECT a.id, a.date, a.time, a.reason, a.status,
                p.full_name as patientName, p.username as patientUsername
         FROM appointments a JOIN users p ON p.id = a.patient_id
         WHERE a.doctor_id = ? ORDER BY a.date, a.time`
      )
      .all(req.user.id);
    return res.json({ appointments: rows });
  }

  const rows = db
    .prepare(
      `SELECT a.id, a.date, a.time, a.reason, a.status,
              d.full_name as doctorName, d.username as doctorUsername
       FROM appointments a JOIN users d ON d.id = a.doctor_id
       WHERE a.patient_id = ? ORDER BY a.date, a.time`
    )
    .all(req.user.id);
  return res.json({ appointments: rows });
});

app.post("/api/appointments", auth, requireRole("patient"), (req, res) => {
  const doctorId = Number(req.body.doctorId);
  const date = String(req.body.date || "");
  const time = String(req.body.time || "");
  const reason = String(req.body.reason || "").trim();

  if (!doctorId || !date || !time || !reason)
    return res.status(400).json({ error: "Missing fields" });

  const doctor = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'doctor'").get(doctorId);
  if (!doctor) return res.status(400).json({ error: "Invalid doctor" });

  const exists = db
    .prepare("SELECT id FROM appointments WHERE doctor_id = ? AND patient_id = ? AND date = ? AND time = ?")
    .get(doctorId, req.user.id, date, time);
  if (exists) return res.status(409).json({ error: "Slot already booked by you" });

  const info = db
    .prepare("INSERT INTO appointments (doctor_id, patient_id, date, time, reason, status) VALUES (?,?,?,?,?, 'pending')")
    .run(doctorId, req.user.id, date, time, reason);
  res.json({ id: info.lastInsertRowid });
});

app.patch("/api/appointments/:id/status", auth, requireRole("doctor"), (req, res) => {
  const id = Number(req.params.id);
  const status = String(req.body.status || "");

  if (!id) return res.status(400).json({ error: "Invalid appointment id" });
  if (status !== "booked" && status !== "denied")
    return res.status(400).json({ error: "Invalid status" });

  const appt = db
    .prepare("SELECT id, doctor_id as doctorId, status FROM appointments WHERE id = ?")
    .get(id);
  if (!appt) return res.status(404).json({ error: "Appointment not found" });
  if (appt.doctorId !== req.user.id) return res.status(403).json({ error: "Forbidden" });
  if (appt.status !== "pending")
    return res.status(409).json({ error: "Appointment already decided" });

  db.prepare("UPDATE appointments SET status = ? WHERE id = ?").run(status, id);
  res.json({ ok: true });
});

// ─── Records ──────────────────────────────────────────────────────────────────

app.get("/api/records", auth, (req, res) => {
  if (req.user.role === "patient") {
    const rows = db
      .prepare(
        `SELECT r.id, r.notes, r.created_at as createdAt, d.full_name as doctorName
         FROM records r JOIN users d ON d.id = r.doctor_id
         WHERE r.patient_id = ? ORDER BY r.created_at DESC`
      )
      .all(req.user.id);
    return res.json({ records: rows });
  }

  const patientUsername = String(req.query.patientUsername || "").trim();
  let rows;
  if (patientUsername) {
    rows = db
      .prepare(
        `SELECT r.id, r.notes, r.created_at as createdAt,
                p.full_name as patientName, p.username as patientUsername
         FROM records r JOIN users p ON p.id = r.patient_id
         WHERE r.doctor_id = ? AND p.username = ? ORDER BY r.created_at DESC`
      )
      .all(req.user.id, patientUsername);
  } else {
    rows = db
      .prepare(
        `SELECT r.id, r.notes, r.created_at as createdAt,
                p.full_name as patientName, p.username as patientUsername
         FROM records r JOIN users p ON p.id = r.patient_id
         WHERE r.doctor_id = ? ORDER BY r.created_at DESC`
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

// ─── Inventory ────────────────────────────────────────────────────────────────

app.get("/api/inventory", auth, requireRole("doctor", "pharmacist"), (req, res) => {
  const items = db
    .prepare("SELECT id, medicine, stock, price FROM inventory ORDER BY medicine")
    .all();
  res.json({ inventory: items });
});

app.post("/api/inventory", auth, requireRole("pharmacist", "doctor"), (req, res) => {
  const medicine = String(req.body.medicine || "").trim();
  const stock = Number(req.body.stock);
  const price = Number(req.body.price);

  if (!medicine || isNaN(stock) || isNaN(price) || stock < 0 || price < 0)
    return res.status(400).json({ error: "Invalid fields" });

  const exists = db
    .prepare("SELECT id FROM inventory WHERE lower(medicine) = lower(?)")
    .get(medicine);
  if (exists) return res.status(409).json({ error: "Medicine already exists" });

  const info = db
    .prepare("INSERT INTO inventory (medicine, stock, price) VALUES (?,?,?)")
    .run(medicine, stock, price);
  res.json({ id: info.lastInsertRowid });
});

app.patch("/api/inventory/:id", auth, requireRole("pharmacist", "doctor"), (req, res) => {
  const id = Number(req.params.id);
  const item = db.prepare("SELECT * FROM inventory WHERE id = ?").get(id);
  if (!item) return res.status(404).json({ error: "Medicine not found" });

  const stock = req.body.stock !== undefined ? Number(req.body.stock) : null;
  const price = req.body.price !== undefined ? Number(req.body.price) : null;

  if (stock !== null && (isNaN(stock) || stock < 0))
    return res.status(400).json({ error: "Invalid stock" });
  if (price !== null && (isNaN(price) || price < 0))
    return res.status(400).json({ error: "Invalid price" });

  db.prepare("UPDATE inventory SET stock = COALESCE(?, stock), price = COALESCE(?, price) WHERE id = ?")
    .run(stock, price, id);
  res.json({ ok: true });
});

app.delete("/api/inventory/:id", auth, requireRole("pharmacist"), (req, res) => {
  const id = Number(req.params.id);
  const item = db.prepare("SELECT id FROM inventory WHERE id = ?").get(id);
  if (!item) return res.status(404).json({ error: "Medicine not found" });
  db.prepare("DELETE FROM inventory WHERE id = ?").run(id);
  res.json({ ok: true });
});

// ─── Billing ──────────────────────────────────────────────────────────────────

app.get("/api/bills", auth, (req, res) => {
  if (req.user.role === "patient") {
    const rows = db
      .prepare(
        `SELECT b.id, b.medicine, b.quantity, b.unit_price as unitPrice, b.total,
                b.created_at as createdAt, d.full_name as doctorName
         FROM bills b JOIN users d ON d.id = b.doctor_id
         WHERE b.patient_id = ? ORDER BY b.created_at DESC`
      )
      .all(req.user.id);
    return res.json({ bills: rows });
  }

  const rows = db
    .prepare(
      `SELECT b.id, b.medicine, b.quantity, b.unit_price as unitPrice, b.total,
              b.created_at as createdAt, p.full_name as patientName, p.username as patientUsername
       FROM bills b JOIN users p ON p.id = b.patient_id
       WHERE b.doctor_id = ? ORDER BY b.created_at DESC`
    )
    .all(req.user.id);
  return res.json({ bills: rows });
});

app.post("/api/bills", auth, requireRole("doctor"), (req, res) => {
  const patientUsername = String(req.body.patientUsername || "").trim();
  const medicineName = String(req.body.medicine || "").trim();
  const quantity = Number(req.body.quantity);
  if (!patientUsername || !medicineName || !quantity || quantity <= 0)
    return res.status(400).json({ error: "Missing fields" });

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
    db.prepare("UPDATE inventory SET stock = stock - ? WHERE medicine = ?").run(quantity, item.medicine);
    const info = db
      .prepare("INSERT INTO bills (doctor_id, patient_id, medicine, quantity, unit_price, total) VALUES (?,?,?,?,?,?)")
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

// ─── Prescriptions ────────────────────────────────────────────────────────────

app.get("/api/prescriptions", auth, (req, res) => {
  if (req.user.role === "doctor") {
    const rows = db
      .prepare(
        `SELECT p.id, p.medicines, p.status, p.ai_analysis as aiAnalysis,
                p.pharmacist_notes as pharmacistNotes, p.created_at as createdAt,
                u.full_name as patientName, u.username as patientUsername,
                ph.full_name as pharmacistName
         FROM prescriptions p
         JOIN users u ON u.id = p.patient_id
         LEFT JOIN users ph ON ph.id = p.pharmacist_id
         WHERE p.doctor_id = ? ORDER BY p.created_at DESC`
      )
      .all(req.user.id);
    return res.json({ prescriptions: rows });
  }

  if (req.user.role === "patient") {
    const rows = db
      .prepare(
        `SELECT p.id, p.medicines, p.status, p.ai_analysis as aiAnalysis,
                p.pharmacist_notes as pharmacistNotes, p.created_at as createdAt,
                d.full_name as doctorName, ph.full_name as pharmacistName
         FROM prescriptions p
         JOIN users d ON d.id = p.doctor_id
         LEFT JOIN users ph ON ph.id = p.pharmacist_id
         WHERE p.patient_id = ? ORDER BY p.created_at DESC`
      )
      .all(req.user.id);
    return res.json({ prescriptions: rows });
  }

  if (req.user.role === "pharmacist") {
    const rows = db
      .prepare(
        `SELECT p.id, p.medicines, p.status, p.ai_analysis as aiAnalysis,
                p.pharmacist_notes as pharmacistNotes, p.created_at as createdAt,
                u.full_name as patientName, u.username as patientUsername,
                d.full_name as doctorName
         FROM prescriptions p
         JOIN users u ON u.id = p.patient_id
         JOIN users d ON d.id = p.doctor_id
         WHERE p.pharmacist_id = ? OR p.pharmacist_id IS NULL
         ORDER BY (p.status = 'pending') DESC, p.created_at DESC`
      )
      .all(req.user.id);
    return res.json({ prescriptions: rows });
  }

  return res.status(403).json({ error: "Forbidden" });
});

app.post("/api/prescriptions", auth, requireRole("doctor"), (req, res) => {
  const patientUsername = String(req.body.patientUsername || "").trim();
  const medicines = req.body.medicines;
  const pharmacistId = req.body.pharmacistId ? Number(req.body.pharmacistId) : null;

  if (!patientUsername || !Array.isArray(medicines) || medicines.length === 0)
    return res.status(400).json({ error: "Missing fields" });

  const patient = db
    .prepare("SELECT id FROM users WHERE username = ? AND role = 'patient'")
    .get(patientUsername);
  if (!patient) return res.status(404).json({ error: "Patient not found" });

  if (pharmacistId) {
    const ph = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'pharmacist'").get(pharmacistId);
    if (!ph) return res.status(400).json({ error: "Invalid pharmacist" });
  }

  const info = db
    .prepare(
      "INSERT INTO prescriptions (patient_id, doctor_id, pharmacist_id, medicines, status) VALUES (?, ?, ?, ?, 'pending')"
    )
    .run(patient.id, req.user.id, pharmacistId, JSON.stringify(medicines));

  res.json({ id: info.lastInsertRowid });
});

app.patch("/api/prescriptions/:id", auth, requireRole("pharmacist", "doctor"), (req, res) => {
  const id = Number(req.params.id);
  const rx = db.prepare("SELECT * FROM prescriptions WHERE id = ?").get(id);
  if (!rx) return res.status(404).json({ error: "Prescription not found" });

  if (req.user.role === "pharmacist") {
    const validStatuses = ["pending", "verified", "approved", "dispensed", "flagged", "rejected"];
    const status = req.body.status ? String(req.body.status) : null;
    if (status && !validStatuses.includes(status))
      return res.status(400).json({ error: "Invalid status" });

    const notes =
      req.body.pharmacist_notes !== undefined ? String(req.body.pharmacist_notes) : null;
    const aiAnalysis =
      req.body.ai_analysis !== undefined ? JSON.stringify(req.body.ai_analysis) : null;

    db.prepare(
      `UPDATE prescriptions SET
         status = COALESCE(?, status),
         pharmacist_notes = COALESCE(?, pharmacist_notes),
         ai_analysis = COALESCE(?, ai_analysis),
         pharmacist_id = COALESCE(pharmacist_id, ?)
       WHERE id = ?`
    ).run(status, notes, aiAnalysis, req.user.id, id);

    return res.json({ ok: true });
  }

  if (req.user.role === "doctor" && rx.doctor_id === req.user.id) {
    if (req.body.medicines) {
      db.prepare("UPDATE prescriptions SET medicines = ? WHERE id = ?").run(
        JSON.stringify(req.body.medicines),
        id
      );
    }
    return res.json({ ok: true });
  }

  return res.status(403).json({ error: "Forbidden" });
});

app.post("/api/prescriptions/:id/ai-check", auth, requireRole("pharmacist", "doctor"), (req, res) => {
  const id = Number(req.params.id);
  const rx = db.prepare("SELECT * FROM prescriptions WHERE id = ?").get(id);
  if (!rx) return res.status(404).json({ error: "Prescription not found" });

  let medicines = [];
  try { medicines = JSON.parse(rx.medicines || "[]"); } catch { medicines = []; }
  const names = medicines.map((m) => (typeof m === "string" ? m : m.name || ""));

  const analysis = checkDrugInteractions(names);

  db.prepare("UPDATE prescriptions SET ai_analysis = ? WHERE id = ?").run(
    JSON.stringify(analysis),
    id
  );

  res.json({ analysis });
});

// ─── Scan Reports ─────────────────────────────────────────────────────────────

app.get("/api/scans", auth, (req, res) => {
  if (req.user.role === "doctor") {
    const rows = db
      .prepare(
        `SELECT s.id, s.scan_type as scanType, s.ai_result as aiResult,
                s.doctor_notes as doctorNotes, s.created_at as createdAt,
                s.approved, s.final_report as finalReport,
                u.full_name as patientName, u.username as patientUsername
         FROM scan_reports s JOIN users u ON u.id = s.patient_id
         WHERE s.doctor_id = ? ORDER BY s.created_at DESC`
      )
      .all(req.user.id);
    return res.json({ scans: rows });
  }

  if (req.user.role === "patient") {
    const rows = db
      .prepare(
        `SELECT s.id, s.scan_type as scanType, s.ai_result as aiResult,
                s.doctor_notes as doctorNotes, s.created_at as createdAt,
                s.approved, s.final_report as finalReport,
                d.full_name as doctorName
         FROM scan_reports s JOIN users d ON d.id = s.doctor_id
         WHERE s.patient_id = ? ORDER BY s.created_at DESC`
      )
      .all(req.user.id);
    return res.json({ scans: rows });
  }

  return res.status(403).json({ error: "Forbidden" });
});

app.post("/api/scans", auth, requireRole("doctor"), (req, res) => {
  const patientUsername = String(req.body.patientUsername || "").trim();
  const scanType        = String(req.body.scanType || "").trim();
  const doctorNotes     = String(req.body.doctorNotes || "").trim();
  const imageData       = req.body.imageData ? String(req.body.imageData) : null;

  if (!patientUsername || !scanType) return res.status(400).json({ error: "Missing fields" });

  const validTypes = ["MRI", "CT", "X-ray", "Ultrasound", "ECG", "Blood Test"];
  if (!validTypes.includes(scanType))
    return res.status(400).json({ error: `Invalid scan type. Valid: ${validTypes.join(", ")}` });

  const patient = db
    .prepare("SELECT id FROM users WHERE username = ? AND role = 'patient'")
    .get(patientUsername);
  if (!patient) return res.status(404).json({ error: "Patient not found" });

  const aiResult = analyzeScan(scanType);

  const info = db
    .prepare(
      `INSERT INTO scan_reports
         (patient_id, doctor_id, scan_type, ai_result, doctor_notes, image_data)
       VALUES (?,?,?,?,?,?)`
    )
    .run(patient.id, req.user.id, scanType, JSON.stringify(aiResult), doctorNotes, imageData);

  res.json({ id: info.lastInsertRowid, aiResult });
});

// Single scan — used by the report-editor page
app.get("/api/scans/:id", auth, requireRole("doctor"), (req, res) => {
  const id = Number(req.params.id);
  const scan = db
    .prepare(
      `SELECT s.id, s.scan_type as scanType, s.ai_result as aiResult,
              s.doctor_notes as doctorNotes, s.created_at as createdAt,
              s.approved, s.final_report as finalReport, s.image_data as imageData,
              u.full_name as patientName, u.username as patientUsername,
              d.full_name as doctorName
       FROM scan_reports s
       JOIN users u ON u.id = s.patient_id
       JOIN users d ON d.id = s.doctor_id
       WHERE s.id = ? AND s.doctor_id = ?`
    )
    .get(id, req.user.id);
  if (!scan) return res.status(404).json({ error: "Scan not found or access denied" });
  res.json({ scan });
});

app.patch("/api/scans/:id", auth, requireRole("doctor"), (req, res) => {
  const id = Number(req.params.id);
  const scan = db.prepare("SELECT * FROM scan_reports WHERE id = ?").get(id);
  if (!scan) return res.status(404).json({ error: "Scan not found" });
  if (scan.doctor_id !== req.user.id) return res.status(403).json({ error: "Forbidden" });

  const doctorNotes  = req.body.doctorNotes  !== undefined ? String(req.body.doctorNotes)          : null;
  const finalReport  = req.body.finalReport  !== undefined ? JSON.stringify(req.body.finalReport)  : null;
  const approved     = req.body.approved     !== undefined ? (req.body.approved ? 1 : 0)           : null;

  db.prepare(
    `UPDATE scan_reports SET
       doctor_notes = COALESCE(?, doctor_notes),
       final_report = COALESCE(?, final_report),
       approved     = COALESCE(?, approved)
     WHERE id = ?`
  ).run(doctorNotes, finalReport, approved, id);

  res.json({ ok: true });
});

// ─── Health Metrics ───────────────────────────────────────────────────────────

app.get("/api/health-metrics", auth, (req, res) => {
  if (req.user.role === "patient") {
    const rows = db
      .prepare("SELECT * FROM health_metrics WHERE patient_id = ? ORDER BY recorded_at DESC LIMIT 30")
      .all(req.user.id);
    return res.json({ metrics: rows });
  }

  if (req.user.role === "doctor") {
    const patientUsername = String(req.query.patientUsername || "").trim();
    if (!patientUsername) return res.status(400).json({ error: "patientUsername required" });
    const patient = db
      .prepare("SELECT id FROM users WHERE username = ? AND role = 'patient'")
      .get(patientUsername);
    if (!patient) return res.status(404).json({ error: "Patient not found" });
    const rows = db
      .prepare("SELECT * FROM health_metrics WHERE patient_id = ? ORDER BY recorded_at DESC LIMIT 30")
      .all(patient.id);
    return res.json({ metrics: rows });
  }

  return res.status(403).json({ error: "Forbidden" });
});

app.post("/api/health-metrics", auth, requireRole("patient"), (req, res) => {
  const { bp_systolic, bp_diastolic, blood_sugar, weight, temperature } = req.body;

  if (!bp_systolic && !bp_diastolic && !blood_sugar && !weight && !temperature)
    return res.status(400).json({ error: "At least one metric required" });

  const info = db
    .prepare(
      `INSERT INTO health_metrics (patient_id, bp_systolic, bp_diastolic, blood_sugar, weight, temperature)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.user.id,
      bp_systolic ? Number(bp_systolic) : null,
      bp_diastolic ? Number(bp_diastolic) : null,
      blood_sugar ? Number(blood_sugar) : null,
      weight ? Number(weight) : null,
      temperature ? Number(temperature) : null
    );

  const latest = db
    .prepare("SELECT * FROM health_metrics WHERE patient_id = ? ORDER BY recorded_at DESC LIMIT 1")
    .get(req.user.id);
  const risks = predictDiseaseRisk(latest || {});

  res.json({ id: info.lastInsertRowid, risks });
});

app.get("/api/health-metrics/risk", auth, requireRole("patient"), (req, res) => {
  const latest = db
    .prepare("SELECT * FROM health_metrics WHERE patient_id = ? ORDER BY recorded_at DESC LIMIT 1")
    .get(req.user.id);

  if (!latest) return res.json({ risks: [], message: "No metrics recorded yet" });
  const risks = predictDiseaseRisk(latest);
  res.json({ risks, metrics: latest });
});

// ─── AI Chatbot ───────────────────────────────────────────────────────────────

app.post("/api/ai/chat", auth, requireRole("patient"), (req, res) => {
  const message = String(req.body.message || "").trim();
  if (!message) return res.status(400).json({ error: "Message required" });

  const appointments = db
    .prepare(
      `SELECT a.date, a.time, a.reason, a.status, d.full_name as doctorName
       FROM appointments a JOIN users d ON d.id = a.doctor_id
       WHERE a.patient_id = ? ORDER BY a.date DESC LIMIT 5`
    )
    .all(req.user.id);

  const records = db
    .prepare(
      `SELECT r.notes, r.created_at as createdAt, d.full_name as doctorName
       FROM records r JOIN users d ON d.id = r.doctor_id
       WHERE r.patient_id = ? ORDER BY r.created_at DESC LIMIT 3`
    )
    .all(req.user.id);

  const prescriptions = db
    .prepare(
      `SELECT p.medicines, p.status, p.pharmacist_notes, d.full_name as doctorName
       FROM prescriptions p JOIN users d ON d.id = p.doctor_id
       WHERE p.patient_id = ? ORDER BY p.created_at DESC LIMIT 3`
    )
    .all(req.user.id);

  const metrics = db
    .prepare("SELECT * FROM health_metrics WHERE patient_id = ? ORDER BY recorded_at DESC LIMIT 1")
    .get(req.user.id);

  const reply = generateChatResponse(message, { appointments, records, prescriptions, metrics });
  res.json({ reply });
});

// ─── Static frontend ──────────────────────────────────────────────────────────

app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`MedPlus server running on http://localhost:${PORT}`);
});
