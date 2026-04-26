const TOKEN_KEY = "medplusToken";
const USER_KEY  = "medplusUser";

let currentUser = null;
let authToken   = localStorage.getItem(TOKEN_KEY) || null;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const loginSection     = document.getElementById("login-section");
const dashboardSection = document.getElementById("dashboard-section");
const loginForm        = document.getElementById("login-form");
const loginError       = document.getElementById("login-error");
const authModeInput    = document.getElementById("auth-mode");
const authTabs         = document.querySelectorAll(".auth-tab");

const welcomeText    = document.getElementById("welcome-text");
const dashboardTitle = document.getElementById("dashboard-title");
const doctorDashboard  = document.getElementById("doctor-dashboard");
const patientDashboard = document.getElementById("patient-dashboard");
const logoutBtn = document.getElementById("logout-btn");

// Doctor DOM
const doctorAppointmentsBody = document.getElementById("doctor-appointments-body");
const doctorRecordForm       = document.getElementById("doctor-record-form");
const doctorRecordMessage    = document.getElementById("doctor-record-message");
const inventoryBody          = document.getElementById("inventory-body");
const billingForm            = document.getElementById("billing-form");
const billingMessage         = document.getElementById("billing-message");
const doctorRxBody           = document.getElementById("doctor-rx-body");
const doctorScansBody        = document.getElementById("doctor-scans-body");

// Patient DOM
const appointmentForm         = document.getElementById("appointment-form");
const appointmentMessage      = document.getElementById("appointment-message");
const patientRecordsList      = document.getElementById("patient-records-list");
const patientBillsBody        = document.getElementById("patient-bills-body");
const patientAppointmentsBody = document.getElementById("patient-appointments-body");
const appointmentDoctorSelect = document.getElementById("appointment-doctor");
const patientRxBody           = document.getElementById("patient-rx-body");
const patientScansBody        = document.getElementById("patient-scans-body");

// Health metrics DOM
const metricsForm    = document.getElementById("metrics-form");
const metricsMessage = document.getElementById("metrics-message");
const riskDisplay    = document.getElementById("risk-display");

// Chat DOM
const chatMessages = document.getElementById("chat-messages");
const chatForm     = document.getElementById("chat-form");
const chatInput    = document.getElementById("chat-input");

// ── API helper ────────────────────────────────────────────────────────────────
async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  const res  = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((data && data.error) ? data.error : "Request failed");
    err.status = res.status;
    throw err;
  }
  return data;
}

// ── Auth-tab toggle ───────────────────────────────────────────────────────────
authTabs.forEach((btn) => {
  btn.addEventListener("click", () => {
    authTabs.forEach((b) => b.classList.remove("auth-tab-active"));
    btn.classList.add("auth-tab-active");
    authModeInput.value = btn.getAttribute("data-mode") || "login";
    const submitBtn = loginForm.querySelector("button[type=submit]");
    submitBtn.textContent = authModeInput.value === "signup" ? "📝 Sign Up" : "🔐 Login";
  });
});

// ── Route to the right dashboard ──────────────────────────────────────────────
function showSectionForRole() {
  doctorDashboard.classList.add("hidden");
  patientDashboard.classList.add("hidden");

  dashboardSection.classList.remove("hidden");
  loginSection.classList.add("hidden");

  welcomeText.textContent = `Logged in as ${currentUser.fullName} (${currentUser.role})`;

  if (currentUser.role === "pharmacist") {
    window.location.href = "/pharmacist.html";
    return;
  }

  if (currentUser.role === "doctor") {
    dashboardTitle.textContent = "Doctor Dashboard";
    doctorDashboard.classList.remove("hidden");
    renderDoctorView();
  } else {
    dashboardTitle.textContent = "Patient Dashboard";
    patientDashboard.classList.remove("hidden");
    renderPatientView();
  }
}

// ── DOCTOR VIEW ───────────────────────────────────────────────────────────────
async function renderDoctorView() {
  resetMessages();
  doctorAppointmentsBody.innerHTML = "";
  inventoryBody.innerHTML          = "";
  doctorRxBody.innerHTML           = "";
  doctorScansBody.innerHTML        = "";

  // Populate pharmacist dropdown in prescription form
  try {
    const { pharmacists } = await api("/api/pharmacists");
    const sel = document.getElementById("rx-pharmacist");
    sel.innerHTML = '<option value="">— Select Pharmacist (optional) —</option>';
    (pharmacists || []).forEach((p) => {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = `${p.fullName} (${p.username})`;
      sel.appendChild(opt);
    });
  } catch { /* no pharmacists yet — ignore */ }

  const [apps, inv, rxRes, scansRes] = await Promise.all([
    api("/api/appointments"),
    api("/api/inventory"),
    api("/api/prescriptions"),
    api("/api/scans"),
  ]);

  // ── Appointments ──
  if (!apps.appointments || apps.appointments.length === 0) {
    doctorAppointmentsBody.innerHTML = `<tr><td colspan="6">No appointments yet.</td></tr>`;
  } else {
    apps.appointments.forEach((a) => {
      const canDecide = a.status === "pending";
      const row = document.createElement("tr");
      row.innerHTML = `
        <td>${a.patientName || a.patientUsername || ""}</td>
        <td>${a.date}</td><td>${a.time}</td><td>${a.reason}</td>
        <td>${a.status}</td>
        <td>${canDecide
          ? `<button class="btn btn-sm" data-action="book">Book</button>
             <button class="btn btn-sm" data-action="deny" style="background:transparent;color:#ff5c72;border:2px solid #ff5c72;box-shadow:none;">Deny</button>`
          : "—"}</td>`;
      if (canDecide) {
        row.querySelector('[data-action="book"]').addEventListener("click", async () => {
          await api(`/api/appointments/${a.id}/status`, { method: "PATCH", body: JSON.stringify({ status: "booked" }) });
          renderDoctorView();
        });
        row.querySelector('[data-action="deny"]').addEventListener("click", async () => {
          await api(`/api/appointments/${a.id}/status`, { method: "PATCH", body: JSON.stringify({ status: "denied" }) });
          renderDoctorView();
        });
      }
      doctorAppointmentsBody.appendChild(row);
    });
  }

  // ── Inventory ──
  (inv.inventory || []).forEach((item) => {
    const row = document.createElement("tr");
    row.innerHTML = `<td>${item.medicine}</td><td>${item.stock}</td><td>₹${item.price}</td>`;
    inventoryBody.appendChild(row);
  });

  // ── Prescriptions ──
  const rxList = rxRes.prescriptions || [];
  if (rxList.length === 0) {
    doctorRxBody.innerHTML = `<tr><td colspan="6">No prescriptions created yet.</td></tr>`;
  } else {
    rxList.forEach((rx) => {
      const meds = parseMeds(rx.medicines);
      const row = document.createElement("tr");
      row.innerHTML = `
        <td>${rx.patientName || rx.patientUsername}</td>
        <td>${(rx.createdAt || "").slice(0, 10)}</td>
        <td>${meds.map((m) => m.name).join(", ")}</td>
        <td><span class="badge badge-${rx.status}">${rx.status}</span></td>
        <td>${rx.pharmacistName || "—"}</td>
        <td>${rx.pharmacistNotes || "—"}</td>`;
      doctorRxBody.appendChild(row);
    });
  }

  // ── Scans ──
  const scanList = scansRes.scans || [];
  if (scanList.length === 0) {
    doctorScansBody.innerHTML = `<tr><td colspan="7">No scan reports yet.</td></tr>`;
  } else {
    scanList.forEach((s) => {
      const ai = safeJson(s.aiResult);
      const fr = safeJson(s.finalReport);
      const findings = (fr && fr.findings) || (ai && ai.findings) || "—";
      const anomaly  = (fr !== null ? fr.anomalyDetected : ai?.anomalyDetected);
      const anomalyCell = anomaly === true
        ? `<span style="color:#e74c3c;font-weight:700;">⚠ Yes</span>`
        : anomaly === false
        ? `<span style="color:#27ae60;font-weight:700;">✓ No</span>`
        : "—";
      const statusBadge = s.approved
        ? `<span class="badge badge-approved">✅ Approved</span>`
        : `<span class="badge badge-pending">Draft</span>`;
      const row = document.createElement("tr");
      row.innerHTML = `
        <td>${s.patientName}</td>
        <td>${s.scanType}</td>
        <td style="max-width:220px;font-size:.82em;">${findings.slice(0, 100)}${findings.length > 100 ? "…" : ""}</td>
        <td>${anomalyCell}</td>
        <td>${statusBadge}</td>
        <td>${(s.createdAt || "").slice(0, 10)}</td>
        <td><a href="/scan-report.html?id=${s.id}"
               style="background:#2980b9;color:#fff;padding:5px 12px;border-radius:7px;
                      font-size:.8rem;font-weight:700;text-decoration:none;white-space:nowrap;">
             ${s.approved ? "View / Edit" : "✏ Review"}
           </a></td>`;
      doctorScansBody.appendChild(row);
    });
  }
}

// ── PATIENT VIEW ──────────────────────────────────────────────────────────────
async function renderPatientView() {
  resetMessages();
  patientRecordsList.innerHTML      = "";
  patientBillsBody.innerHTML        = "";
  appointmentDoctorSelect.innerHTML = "";
  patientAppointmentsBody.innerHTML = "";
  patientRxBody.innerHTML           = "";
  patientScansBody.innerHTML        = "";
  riskDisplay.innerHTML             = "";

  const [doctorsRes, recordsRes, billsRes, appsRes, rxRes, scansRes, metricsRes] =
    await Promise.all([
      api("/api/doctors"),
      api("/api/records"),
      api("/api/bills"),
      api("/api/appointments"),
      api("/api/prescriptions"),
      api("/api/scans"),
      api("/api/health-metrics"),
    ]);

  // ── Doctors dropdown ──
  if (!doctorsRes.doctors || doctorsRes.doctors.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No doctors found";
    appointmentDoctorSelect.appendChild(opt);
  } else {
    doctorsRes.doctors.forEach((d) => {
      const opt = document.createElement("option");
      opt.value = d.id;
      opt.textContent = `${d.fullName} (${d.username})`;
      appointmentDoctorSelect.appendChild(opt);
    });
  }

  // ── Records ──
  if (!recordsRes.records || recordsRes.records.length === 0) {
    patientRecordsList.innerHTML = "<li>No records yet.</li>";
  } else {
    recordsRes.records.forEach((r) => {
      const li = document.createElement("li");
      li.textContent = `${r.notes} — ${r.doctorName || "Doctor"}`;
      patientRecordsList.appendChild(li);
    });
  }

  // ── Bills ──
  if (!billsRes.bills || billsRes.bills.length === 0) {
    patientBillsBody.innerHTML = `<tr><td colspan="4">No bills yet.</td></tr>`;
  } else {
    billsRes.bills.forEach((b) => {
      const row = document.createElement("tr");
      row.innerHTML = `<td>${b.medicine}</td><td>${b.quantity}</td><td>₹${b.total}</td>
        <td><button class="btn btn-sm">View Bill</button></td>`;
      row.querySelector("button").addEventListener("click", () => {
        localStorage.setItem("lastBill", JSON.stringify({
          number: `BILL-${b.id}`, dateTime: b.createdAt || "",
          patient: currentUser.fullName, medicine: b.medicine,
          quantity: b.quantity, unitPrice: b.unitPrice, total: b.total,
        }));
        window.open("bill.html", "_blank");
      });
      patientBillsBody.appendChild(row);
    });
  }

  // ── Appointments ──
  if (!appsRes.appointments || appsRes.appointments.length === 0) {
    patientAppointmentsBody.innerHTML = `<tr><td colspan="5">No appointments yet.</td></tr>`;
  } else {
    appsRes.appointments.forEach((a) => {
      const row = document.createElement("tr");
      row.innerHTML = `<td>${a.doctorName || a.doctorUsername}</td><td>${a.date}</td>
        <td>${a.time}</td><td>${a.reason}</td><td>${a.status}</td>`;
      patientAppointmentsBody.appendChild(row);
    });
  }

  // ── Prescriptions ──
  const rxList = rxRes.prescriptions || [];
  if (rxList.length === 0) {
    patientRxBody.innerHTML = `<tr><td colspan="6">No prescriptions yet.</td></tr>`;
  } else {
    rxList.forEach((rx) => {
      const meds = parseMeds(rx.medicines);
      const row = document.createElement("tr");
      row.innerHTML = `
        <td>${rx.doctorName}</td>
        <td>${(rx.createdAt || "").slice(0, 10)}</td>
        <td style="font-size:.85em;">${meds.map((m) => `${m.name} ${m.dosage ? `(${m.dosage})` : ""}`).join(", ")}</td>
        <td><span class="badge badge-${rx.status}">${rx.status}</span></td>
        <td>${rx.pharmacistName || "—"}</td>
        <td style="font-size:.85em;">${rx.pharmacistNotes || "—"}</td>`;
      patientRxBody.appendChild(row);
    });
  }

  // ── Scans ──
  const scanList = scansRes.scans || [];
  // Cache for modal lookups
  window._patientScanCache = {};
  scanList.forEach((s) => { window._patientScanCache[s.id] = s; });

  if (scanList.length === 0) {
    patientScansBody.innerHTML = `<tr><td colspan="6">No scan reports yet.</td></tr>`;
  } else {
    scanList.forEach((s) => {
      const fr = safeJson(s.finalReport);
      const row = document.createElement("tr");

      if (s.approved && fr) {
        const anomalyCell = fr.anomalyDetected
          ? `<span style="color:#e74c3c;font-weight:700;">⚠ Anomaly detected</span>`
          : `<span style="color:#27ae60;font-weight:700;">✓ No anomaly</span>`;
        row.innerHTML = `
          <td>${s.scanType}</td>
          <td>${s.doctorName}</td>
          <td><span class="badge badge-approved">✅ Approved</span></td>
          <td style="font-size:.83em;max-width:240px;">${(fr.findings || "").slice(0, 90)}${(fr.findings || "").length > 90 ? "…" : ""}</td>
          <td>${(s.createdAt || "").slice(0, 10)}</td>
          <td><button class="btn btn-sm" style="background:#2980b9;color:#fff;"
                onclick="openPatientReport(${s.id})">View Report</button></td>`;
        row._scanData = s; // stash for modal
      } else {
        row.innerHTML = `
          <td>${s.scanType}</td>
          <td>${s.doctorName}</td>
          <td><span class="badge badge-pending">🔍 Pending Review</span></td>
          <td style="color:#888;font-size:.83em;">Report pending doctor approval</td>
          <td>${(s.createdAt || "").slice(0, 10)}</td>
          <td>—</td>`;
      }
      patientScansBody.appendChild(row);
    });

    // Wire up View Report buttons via data attribute
    patientScansBody.querySelectorAll("button[onclick]").forEach((btn) => {
      // onclick already set inline
    });
  }

  // ── Health metrics latest reading + risk ──
  const metricsList = metricsRes.metrics || [];
  if (metricsList.length > 0) {
    try {
      const { risks } = await api("/api/health-metrics/risk");
      renderRiskDisplay(risks);
    } catch { /* ignore */ }
  }

  // Init chatbot greeting
  if (chatMessages && chatMessages.innerHTML === "") {
    appendChat("assistant", "👋 Hi! I'm your MedPlus AI assistant. Ask me about your health, appointments, or medicines.");
  }
}

// ── Image helpers ─────────────────────────────────────────────────────────────

// Reads a File and returns a data-URL (base64). Resizes images > maxPx to save DB space.
function readFileAsDataURL(file, maxPx = 1400) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = (e) => {
      if (file.type === "application/pdf") {
        resolve(e.target.result); // PDFs: return as-is
        return;
      }
      const img = new Image();
      img.onerror = () => resolve(e.target.result); // fallback: raw
      img.onload = () => {
        let { width, height } = img;
        if (width <= maxPx && height <= maxPx) { resolve(e.target.result); return; }
        const ratio = Math.min(maxPx / width, maxPx / height);
        width  = Math.round(width  * ratio);
        height = Math.round(height * ratio);
        const canvas = document.createElement("canvas");
        canvas.width  = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", 0.88));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function parseMeds(raw) {
  try {
    const parsed = JSON.parse(raw || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.map((m) =>
      typeof m === "string"
        ? { name: m, dosage: "", frequency: "", duration: "" }
        : { name: m.name || "", dosage: m.dosage || "", frequency: m.frequency || "", duration: m.duration || "" }
    );
  } catch {
    return [{ name: raw || "", dosage: "", frequency: "", duration: "" }];
  }
}

function safeJson(str) {
  try { return str ? JSON.parse(str) : null; } catch { return null; }
}

function resetMessages() {
  [loginError, doctorRecordMessage, billingMessage, appointmentMessage,
   document.getElementById("rx-message"), document.getElementById("scan-message"), metricsMessage]
    .forEach((el) => { if (el) el.textContent = ""; });
}

function renderRiskDisplay(risks) {
  if (!riskDisplay || !risks || risks.length === 0) return;
  const colors = { HIGH: "#e74c3c", MODERATE: "#f39c12", LOW: "#27ae60" };
  riskDisplay.innerHTML = `
    <strong style="font-size:.9rem;">Disease Risk Prediction</strong>
    ${risks.map((r) => `
      <div style="margin-top:6px;display:flex;align-items:center;gap:8px;font-size:.85rem;">
        <span style="width:140px;">${r.condition}</span>
        <div style="flex:1;height:10px;background:#e0e0e0;border-radius:5px;overflow:hidden;">
          <div style="width:${r.score}%;height:100%;background:${colors[r.level]};border-radius:5px;"></div>
        </div>
        <span style="color:${colors[r.level]};font-weight:700;width:80px;">${r.level} (${r.score}%)</span>
      </div>`).join("")}`;
}

function appendChat(role, text) {
  if (!chatMessages) return;
  const div = document.createElement("div");
  div.style.cssText = `margin-bottom:8px;${role === "user"
    ? "text-align:right;color:#1e3a5f;"
    : "text-align:left;color:#444;"}`;
  div.innerHTML = `<strong>${role === "user" ? "You" : "🤖 MedPlus AI"}:</strong> ${text.replace(/\n/g, "<br>")}`;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ── Form: Login / Signup ──────────────────────────────────────────────────────
loginForm.addEventListener("submit", function (e) {
  e.preventDefault();
  resetMessages();

  const role     = document.getElementById("role").value;
  const username = document.getElementById("username").value.trim();
  const password = document.getElementById("password").value;
  const mode     = authModeInput ? authModeInput.value : "login";
  const endpoint = mode === "signup" ? "/api/auth/signup" : "/api/auth/login";

  api(endpoint, { method: "POST", body: JSON.stringify({ role, username, password }) })
    .then(({ token, user }) => {
      authToken   = token;
      currentUser = user;
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(USER_KEY, JSON.stringify(user));
      showSectionForRole();
    })
    .catch((e) => { loginError.textContent = e.message || "Login failed"; });
});

// ── Form: Logout ──────────────────────────────────────────────────────────────
logoutBtn.addEventListener("click", function () {
  currentUser = null;
  authToken   = null;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  dashboardSection.classList.add("hidden");
  loginSection.classList.remove("hidden");
  resetMessages();
});

// ── Form: Patient record (doctor) ─────────────────────────────────────────────
doctorRecordForm.addEventListener("submit", function (e) {
  e.preventDefault();
  resetMessages();
  const patientUsername = document.getElementById("record-patient-name").value.trim();
  const notes           = document.getElementById("record-notes").value.trim();
  api("/api/records", { method: "POST", body: JSON.stringify({ patientUsername, notes }) })
    .then(() => {
      doctorRecordMessage.textContent = "Record saved successfully.";
      doctorRecordForm.reset();
    })
    .catch((e) => { doctorRecordMessage.textContent = e.message || "Failed to save record"; });
});

// ── Form: Create Prescription (doctor) ───────────────────────────────────────
document.getElementById("prescription-form").addEventListener("submit", function (e) {
  e.preventDefault();
  resetMessages();
  const msg = document.getElementById("rx-message");

  const patientUsername = document.getElementById("rx-patient").value.trim();
  const rawMeds         = document.getElementById("rx-medicines").value.trim();
  const pharmacistId    = document.getElementById("rx-pharmacist").value || null;

  // Parse textarea lines → medicine objects
  const medicines = rawMeds
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(",").map((s) => s.trim());
      return {
        name:      parts[0] || line,
        dosage:    parts[1] || "",
        frequency: parts[2] || "",
        duration:  parts[3] || "",
      };
    });

  if (medicines.length === 0) {
    msg.textContent = "Add at least one medicine.";
    return;
  }

  api("/api/prescriptions", {
    method: "POST",
    body: JSON.stringify({ patientUsername, medicines, pharmacistId }),
  })
    .then(() => {
      msg.textContent = "Prescription created successfully.";
      document.getElementById("prescription-form").reset();
      renderDoctorView();
    })
    .catch((e) => { msg.textContent = e.message || "Failed to create prescription"; });
});

// ── File preview (doctor scan form) ──────────────────────────────────────────
const scanFileInput = document.getElementById("scan-file");
if (scanFileInput) {
  scanFileInput.addEventListener("change", function () {
    const file    = this.files[0];
    const preview = document.getElementById("scan-preview");
    const img     = document.getElementById("scan-preview-img");
    const name    = document.getElementById("scan-preview-name");
    if (!file) { preview.style.display = "none"; return; }
    name.textContent = `${file.name}  (${(file.size / 1024 / 1024).toFixed(2)} MB)`;
    if (file.type.startsWith("image/")) {
      const reader = new FileReader();
      reader.onload = (e) => { img.src = e.target.result; preview.style.display = "block"; };
      reader.readAsDataURL(file);
    } else {
      img.style.display = "none";
      preview.style.display = "block";
    }
  });
}

// ── Form: Scan Report (doctor) — upload + redirect to editor ─────────────────
document.getElementById("scan-form").addEventListener("submit", async function (e) {
  e.preventDefault();
  resetMessages();
  const msg    = document.getElementById("scan-message");
  const btn    = document.getElementById("scan-submit-btn");

  const patientUsername = document.getElementById("scan-patient").value.trim();
  const scanType        = document.getElementById("scan-type").value;
  const doctorNotes     = document.getElementById("scan-notes").value.trim();
  const file            = document.getElementById("scan-file").files[0];

  btn.disabled = true;
  msg.textContent = "Uploading and analyzing…";

  try {
    let imageData = null;
    if (file) {
      if (file.size > 10 * 1024 * 1024) {
        msg.textContent = "File too large — maximum 10 MB.";
        btn.disabled = false;
        return;
      }
      imageData = await readFileAsDataURL(file);
    }

    const { id } = await api("/api/scans", {
      method: "POST",
      body: JSON.stringify({ patientUsername, scanType, doctorNotes, imageData }),
    });

    // Open the full report editor
    window.location.href = `/scan-report.html?id=${id}`;
  } catch (err) {
    msg.textContent = err.message || "Failed to analyze scan";
    btn.disabled = false;
  }
});

// ── Patient: open approved report in modal ────────────────────────────────────
function openPatientReport(scanId) {
  // Find scan data already loaded on the page
  const rows = Array.from(patientScansBody.querySelectorAll("tr"));
  // We stored the scan in the cell's parent — but easier to re-find from the original list
  // Re-fetch from server isn't needed since we have the data in the DOM table.
  // Use a dataset approach: add data-scan on the button itself (done below via inline onclick).
  // Instead: call the public patient GET and filter — but patient can't GET /api/scans/:id (doctor only).
  // So we cache it in a module-level map.
  const scan = window._patientScanCache && window._patientScanCache[scanId];
  if (!scan) return;

  const fr = safeJson(scan.finalReport);
  if (!fr) return;

  const modal    = document.getElementById("report-modal");
  const imgWrap  = document.getElementById("rm-image-wrap");
  const imgEl    = document.getElementById("rm-image");
  const title    = document.getElementById("rm-title");
  const subtitle = document.getElementById("rm-subtitle");
  const body     = document.getElementById("rm-body");

  title.textContent    = `${scan.scanType} Report`;
  subtitle.textContent = `Dr. ${scan.doctorName}  ·  ${(scan.createdAt || "").slice(0, 10)}`;

  // Show scan image if any
  if (scan.imageData && scan.imageData.startsWith("data:image")) {
    imgEl.src = scan.imageData;
    imgWrap.style.display = "block";
  } else {
    imgWrap.style.display = "none";
  }

  const anomalyColor = fr.anomalyDetected ? "#e74c3c" : "#27ae60";
  const anomalyLabel = fr.anomalyDetected
    ? `<span style="color:#e74c3c;font-weight:700;">⚠ Anomaly Detected</span>`
    : `<span style="color:#27ae60;font-weight:700;">✓ No Anomaly Found</span>`;

  body.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:.87rem;margin-bottom:18px;
                padding-bottom:14px;border-bottom:1px solid #eef2f6;">
      <div><b>Scan Type:</b> ${scan.scanType}</div>
      <div><b>Attending Doctor:</b> ${scan.doctorName}</div>
      <div><b>Date:</b> ${(scan.createdAt || "").slice(0, 16).replace("T", " ")}</div>
      <div><b>Anomaly:</b> ${anomalyLabel}</div>
    </div>

    <div style="margin-bottom:16px;">
      <div style="font-weight:700;font-size:.9rem;margin-bottom:6px;color:#1e3a5f;">📋 Findings</div>
      <div style="background:#f8fbff;border-left:4px solid ${anomalyColor};padding:12px 14px;
                  border-radius:6px;font-size:.88rem;line-height:1.65;">${(fr.findings || "").replace(/\n/g, "<br>")}</div>
    </div>

    <div style="margin-bottom:16px;">
      <div style="font-weight:700;font-size:.9rem;margin-bottom:6px;color:#1e3a5f;">💡 Recommendation</div>
      <div style="background:#f0fff4;border-left:4px solid #27ae60;padding:12px 14px;
                  border-radius:6px;font-size:.88rem;line-height:1.65;">${(fr.recommendation || "").replace(/\n/g, "<br>")}</div>
    </div>

    ${fr.additionalNotes ? `
    <div>
      <div style="font-weight:700;font-size:.9rem;margin-bottom:6px;color:#1e3a5f;">📝 Doctor's Notes</div>
      <div style="background:#fffdf0;border-left:4px solid #e67e22;padding:12px 14px;
                  border-radius:6px;font-size:.88rem;line-height:1.65;">${fr.additionalNotes.replace(/\n/g, "<br>")}</div>
    </div>` : ""}

    <div style="margin-top:16px;padding-top:12px;border-top:1px solid #eef2f6;
                font-size:.78rem;color:#888;display:flex;align-items:center;gap:8px;">
      <span>✅ Approved by Dr. ${scan.doctorName}</span>
      ${fr.approvedAt ? `<span>·</span><span>${fr.approvedAt.slice(0,16).replace("T"," ")} UTC</span>` : ""}
    </div>`;

  modal.style.display = "block";
}

// ── Form: Billing (doctor) ────────────────────────────────────────────────────
billingForm.addEventListener("submit", function (e) {
  e.preventDefault();
  resetMessages();
  const patientUsername = document.getElementById("bill-patient-name").value.trim();
  const medicine        = document.getElementById("bill-medicine").value.trim();
  const quantity        = parseInt(document.getElementById("bill-quantity").value, 10);

  api("/api/bills", { method: "POST", body: JSON.stringify({ patientUsername, medicine, quantity }) })
    .then((bill) => {
      localStorage.setItem("lastBill", JSON.stringify(bill));
      billingMessage.textContent = `Bill generated: ₹${bill.total}`;
      billingForm.reset();
      renderDoctorView();
      window.open("bill.html", "_blank");
    })
    .catch((e) => { billingMessage.textContent = e.message || "Failed to generate bill"; });
});

// ── Form: Book Appointment (patient) ──────────────────────────────────────────
appointmentForm.addEventListener("submit", function (e) {
  e.preventDefault();
  resetMessages();
  const doctorId = Number(document.getElementById("appointment-doctor").value);
  const date     = document.getElementById("appointment-date").value;
  const time     = document.getElementById("appointment-time").value;
  const reason   = document.getElementById("appointment-reason").value;

  api("/api/appointments", { method: "POST", body: JSON.stringify({ doctorId, date, time, reason }) })
    .then(() => {
      appointmentMessage.textContent = "Appointment request sent (pending).";
      appointmentForm.reset();
      renderPatientView();
    })
    .catch((e) => { appointmentMessage.textContent = e.message || "Failed to book appointment"; });
});

// ── Form: Health Metrics (patient) ────────────────────────────────────────────
metricsForm.addEventListener("submit", function (e) {
  e.preventDefault();
  resetMessages();

  const body = {
    bp_systolic:  document.getElementById("m-systolic").value || undefined,
    bp_diastolic: document.getElementById("m-diastolic").value || undefined,
    blood_sugar:  document.getElementById("m-sugar").value || undefined,
    weight:       document.getElementById("m-weight").value || undefined,
    temperature:  document.getElementById("m-temp").value || undefined,
  };
  // Remove undefined
  Object.keys(body).forEach((k) => { if (!body[k]) delete body[k]; });

  api("/api/health-metrics", { method: "POST", body: JSON.stringify(body) })
    .then(({ risks }) => {
      metricsMessage.textContent = "Metrics saved.";
      metricsForm.reset();
      renderRiskDisplay(risks);
    })
    .catch((e) => { metricsMessage.textContent = e.message || "Failed to save metrics"; });
});

// ── AI Chatbot (patient) ──────────────────────────────────────────────────────
if (chatForm) {
  chatForm.addEventListener("submit", function (e) {
    e.preventDefault();
    const message = chatInput.value.trim();
    if (!message) return;

    appendChat("user", message);
    chatInput.value = "";

    api("/api/ai/chat", { method: "POST", body: JSON.stringify({ message }) })
      .then(({ reply }) => { appendChat("assistant", reply); })
      .catch(() => { appendChat("assistant", "Sorry, I couldn't process that. Please try again."); });
  });
}

// ── Auto-login on page load ───────────────────────────────────────────────────
async function tryAutoLogin() {
  resetMessages();
  dashboardSection.classList.add("hidden");

  try {
    const cached = JSON.parse(localStorage.getItem(USER_KEY) || "null");
    if (cached && authToken) currentUser = cached;
  } catch { /* ignore */ }

  if (!authToken) return;

  try {
    const me = await api("/api/me");
    currentUser = me.user;
    localStorage.setItem(USER_KEY, JSON.stringify(currentUser));
    showSectionForRole();
  } catch {
    authToken   = null;
    currentUser = null;
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }
}

tryAutoLogin();
