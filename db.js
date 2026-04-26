const path = require("path");
const Database = require("better-sqlite3");

const DB_PATH = path.join(__dirname, "medplus.sqlite");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

function migrate() {
  const row = db
    .prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='users'")
    .get();

  if (row && row.sql && !row.sql.includes("pharmacist")) {
    db.pragma("foreign_keys = OFF");
    db.exec(`
      CREATE TABLE users_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL CHECK(role IN ('doctor','patient','pharmacist')),
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        full_name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO users_v2 SELECT * FROM users;
      DROP TABLE users;
      ALTER TABLE users_v2 RENAME TO users;
    `);
    db.pragma("foreign_keys = ON");
    console.log("[DB] Migrated users table — pharmacist role added");
  }
}

function initDb() {
  migrate();

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL CHECK(role IN ('doctor','patient','pharmacist')),
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      full_name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS appointments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doctor_id INTEGER NOT NULL REFERENCES users(id),
      patient_id INTEGER NOT NULL REFERENCES users(id),
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doctor_id INTEGER NOT NULL REFERENCES users(id),
      patient_id INTEGER NOT NULL REFERENCES users(id),
      notes TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      medicine TEXT NOT NULL UNIQUE,
      stock INTEGER NOT NULL DEFAULT 0,
      price INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS bills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doctor_id INTEGER NOT NULL REFERENCES users(id),
      patient_id INTEGER NOT NULL REFERENCES users(id),
      medicine TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price INTEGER NOT NULL,
      total INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS prescriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id INTEGER NOT NULL REFERENCES users(id),
      doctor_id INTEGER NOT NULL REFERENCES users(id),
      pharmacist_id INTEGER REFERENCES users(id),
      medicines TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      ai_analysis TEXT,
      pharmacist_notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS scan_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id INTEGER NOT NULL REFERENCES users(id),
      doctor_id INTEGER NOT NULL REFERENCES users(id),
      scan_type TEXT NOT NULL,
      ai_result TEXT,
      doctor_notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS health_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id INTEGER NOT NULL REFERENCES users(id),
      bp_systolic INTEGER,
      bp_diastolic INTEGER,
      blood_sugar INTEGER,
      weight REAL,
      temperature REAL,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Migrate scan_reports — safe ADD COLUMN (ignored if column already exists)
  [
    "ALTER TABLE scan_reports ADD COLUMN approved INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE scan_reports ADD COLUMN final_report TEXT",
    "ALTER TABLE scan_reports ADD COLUMN image_data TEXT",
  ].forEach((sql) => { try { db.exec(sql); } catch { /* already exists */ } });

  db.exec(`
    UPDATE appointments SET status = 'booked' WHERE status = 'approved';
    UPDATE appointments SET status = 'denied' WHERE status = 'declined';
  `);

  const invCount = db.prepare("SELECT COUNT(*) as c FROM inventory").get().c;
  if (invCount === 0) {
    const insert = db.prepare(
      "INSERT INTO inventory (medicine, stock, price) VALUES (@medicine, @stock, @price)"
    );
    const seed = [
      { medicine: "Paracetamol", stock: 100, price: 10 },
      { medicine: "Amoxicillin", stock: 50, price: 25 },
      { medicine: "Cough Syrup", stock: 30, price: 60 },
      { medicine: "Vitamin C", stock: 80, price: 15 },
      { medicine: "Ibuprofen", stock: 60, price: 20 },
      { medicine: "Metformin", stock: 45, price: 35 },
      { medicine: "Aspirin", stock: 90, price: 12 },
      { medicine: "Omeprazole", stock: 40, price: 30 },
      { medicine: "Atorvastatin", stock: 35, price: 45 },
      { medicine: "Amlodipine", stock: 30, price: 40 },
      { medicine: "Warfarin", stock: 20, price: 55 },
      { medicine: "Lisinopril", stock: 40, price: 38 },
    ];
    const tx = db.transaction((rows) => rows.forEach((r) => insert.run(r)));
    tx(seed);
  }
}

module.exports = { db, initDb };
