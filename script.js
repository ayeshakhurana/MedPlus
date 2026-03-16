const TOKEN_KEY = "medplusToken";
const USER_KEY = "medplusUser";

let currentUser = null;
let authToken = localStorage.getItem(TOKEN_KEY) || null;

const loginSection = document.getElementById("login-section");
const dashboardSection = document.getElementById("dashboard-section");
const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");
const authModeInput = document.getElementById("auth-mode");
const authTabs = document.querySelectorAll(".auth-tab");

const welcomeText = document.getElementById("welcome-text");
const dashboardTitle = document.getElementById("dashboard-title");

const doctorDashboard = document.getElementById("doctor-dashboard");
const patientDashboard = document.getElementById("patient-dashboard");

const logoutBtn = document.getElementById("logout-btn");

const doctorAppointmentsBody = document.getElementById("doctor-appointments-body");
const doctorRecordForm = document.getElementById("doctor-record-form");
const doctorRecordMessage = document.getElementById("doctor-record-message");

const inventoryBody = document.getElementById("inventory-body");
const billingForm = document.getElementById("billing-form");
const billingMessage = document.getElementById("billing-message");

const appointmentForm = document.getElementById("appointment-form");
const appointmentMessage = document.getElementById("appointment-message");

const patientRecordsList = document.getElementById("patient-records-list");
const patientBillsBody = document.getElementById("patient-bills-body");

const appointmentDoctorSelect = document.getElementById("appointment-doctor");

async function api(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data && data.error ? data.error : "Request failed";
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}
function showSectionForRole() {

  doctorDashboard.classList.add("hidden");
  patientDashboard.classList.add("hidden");

  dashboardSection.classList.remove("hidden");
  loginSection.classList.add("hidden");

  welcomeText.textContent =
    `Logged in as ${currentUser.fullName} (${currentUser.role})`;

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
async function renderDoctorView() {
  resetMessages();

  doctorAppointmentsBody.innerHTML = "";
  inventoryBody.innerHTML = "";

  const [apps, inv] = await Promise.all([
    api("/api/appointments"),
    api("/api/inventory"),
  ]);

  if (!apps.appointments || apps.appointments.length === 0) {
    const row = document.createElement("tr");
    row.innerHTML = `<td colspan="4">No appointments yet.</td>`;
    doctorAppointmentsBody.appendChild(row);
  } else {
    apps.appointments.forEach((a) => {
      const row = document.createElement("tr");
      row.innerHTML = `
        <td>${a.patientName || a.patientUsername || ""}</td>
        <td>${a.date}</td>
        <td>${a.time}</td>
        <td>${a.reason}</td>
      `;
      doctorAppointmentsBody.appendChild(row);
    });
  }

  inv.inventory.forEach((item) => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${item.medicine}</td>
      <td>${item.stock}</td>
      <td>${item.price}</td>
    `;
    inventoryBody.appendChild(row);
  });
}

async function renderPatientView() {
  resetMessages();

  patientRecordsList.innerHTML = "";
  patientBillsBody.innerHTML = "";
  appointmentDoctorSelect.innerHTML = "";

  const [doctorsRes, recordsRes, billsRes] = await Promise.all([
    api("/api/doctors"),
    api("/api/records"),
    api("/api/bills"),
  ]);

  // doctors dropdown
  if (!doctorsRes.doctors || doctorsRes.doctors.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No doctors found";
    appointmentDoctorSelect.appendChild(opt);
  } else {
    doctorsRes.doctors.forEach((d) => {
      const opt = document.createElement("option");
      opt.value = String(d.id);
      opt.textContent = `${d.fullName} (${d.username})`;
      appointmentDoctorSelect.appendChild(opt);
    });
  }

  // records
  if (!recordsRes.records || recordsRes.records.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No records yet.";
    patientRecordsList.appendChild(li);
  } else {
    recordsRes.records.forEach((r) => {
      const li = document.createElement("li");
      li.textContent = `${r.notes} — ${r.doctorName || "Doctor"}`;
      patientRecordsList.appendChild(li);
    });
  }

  // bills
  if (!billsRes.bills || billsRes.bills.length === 0) {
    const row = document.createElement("tr");
    row.innerHTML = `<td colspan="4">No bills yet.</td>`;
    patientBillsBody.appendChild(row);
  } else {
    billsRes.bills.forEach((b) => {
      const row = document.createElement("tr");
      row.innerHTML = `
        <td>${b.medicine}</td>
        <td>${b.quantity}</td>
        <td>${b.total}</td>
        <td><button class="btn btn-sm" type="button">View Bill</button></td>
      `;
      const btn = row.querySelector("button");
      btn.addEventListener("click", () => {
        const billForView = {
          number: `BILL-${b.id}`,
          dateTime: b.createdAt || "",
          patient: currentUser.fullName,
          medicine: b.medicine,
          quantity: b.quantity,
          unitPrice: b.unitPrice,
          total: b.total,
        };
        localStorage.setItem("lastBill", JSON.stringify(billForView));
        window.open("bill.html", "_blank");
      });
      patientBillsBody.appendChild(row);
    });
  }
}

function resetMessages(){

  if (loginError) loginError.textContent = "";
  if (doctorRecordMessage) doctorRecordMessage.textContent = "";
  if (billingMessage) billingMessage.textContent = "";
  if (appointmentMessage) appointmentMessage.textContent = "";

}
// switch between Login and Sign up
authTabs.forEach((btn) => {
  btn.addEventListener("click", () => {
    authTabs.forEach((b) => b.classList.remove("auth-tab-active"));
    btn.classList.add("auth-tab-active");
    const mode = btn.getAttribute("data-mode") || "login";
    authModeInput.value = mode;
  });
});

loginForm.addEventListener("submit", function(event){

  event.preventDefault();

  resetMessages();

  const role =
    document.getElementById("role").value;

  const username =
    document.getElementById("username").value.trim();

  const password =
    document.getElementById("password").value;

  const mode = authModeInput ? authModeInput.value : "login";

  const endpoint = mode === "signup" ? "/api/auth/signup" : "/api/auth/login";

  api(endpoint, {
    method: "POST",
    body: JSON.stringify({ role, username, password }),
  })
    .then(({ token, user }) => {
      authToken = token;
      currentUser = user;
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(USER_KEY, JSON.stringify(user));
      showSectionForRole();
    })
    .catch((e) => {
      loginError.textContent = e.message || "Login failed";
    });

});

logoutBtn.addEventListener("click",function(){

  currentUser = null;
  authToken = null;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);

  dashboardSection.classList.add("hidden");
  loginSection.classList.remove("hidden");

  resetMessages();

});

doctorRecordForm.addEventListener("submit",function(event){

  event.preventDefault();

  resetMessages();

  const patientUsername =
    document.getElementById("record-patient-name").value.trim();
  const notes =
    document.getElementById("record-notes").value.trim();

  api("/api/records", {
    method: "POST",
    body: JSON.stringify({ patientUsername, notes }),
  })
    .then(() => {
      doctorRecordMessage.textContent = "Record saved successfully.";
      doctorRecordForm.reset();
    })
    .catch((e) => {
      doctorRecordMessage.textContent = e.message || "Failed to save record";
    });

});

billingForm.addEventListener("submit",function(event){

  event.preventDefault();

  resetMessages();

  const patientUsername =
    document.getElementById("bill-patient-name").value.trim();
  const medicine =
    document.getElementById("bill-medicine").value.trim();
  const quantity =
    parseInt(document.getElementById("bill-quantity").value, 10);

  api("/api/bills", {
    method: "POST",
    body: JSON.stringify({ patientUsername, medicine, quantity }),
  })
    .then((bill) => {
      localStorage.setItem("lastBill", JSON.stringify(bill));
      billingMessage.textContent = `Bill generated ₹${bill.total}`;
      billingForm.reset();
      renderDoctorView();
      window.open("bill.html", "_blank");
    })
    .catch((e) => {
      billingMessage.textContent = e.message || "Failed to generate bill";
    });

});

appointmentForm.addEventListener("submit",function(event){

  event.preventDefault();

  resetMessages();

  const doctorId =
    Number(document.getElementById("appointment-doctor").value);

  const date =
    document.getElementById("appointment-date").value;

  const time =
    document.getElementById("appointment-time").value;

  const reason =
    document.getElementById("appointment-reason").value;

  api("/api/appointments", {
    method: "POST",
    body: JSON.stringify({ doctorId, date, time, reason }),
  })
    .then(() => {
      appointmentMessage.textContent = "Appointment booked successfully.";
      appointmentForm.reset();
    })
    .catch((e) => {
      appointmentMessage.textContent = e.message || "Failed to book appointment";
    });

});

async function tryAutoLogin() {
  resetMessages();
  dashboardSection.classList.add("hidden");

  // restore cached user for faster UI, then validate token
  try {
    const cached = JSON.parse(localStorage.getItem(USER_KEY) || "null");
    if (cached && authToken) currentUser = cached;
  } catch {
    // ignore
  }

  if (!authToken) return;
  try {
    const me = await api("/api/me");
    currentUser = me.user;
    localStorage.setItem(USER_KEY, JSON.stringify(currentUser));
    showSectionForRole();
  } catch {
    authToken = null;
    currentUser = null;
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }
}

tryAutoLogin();