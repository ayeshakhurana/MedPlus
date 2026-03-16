const path = require("path");
const Database = require("better-sqlite3");

const DB_PATH = path.join(__dirname, "medplus.sqlite");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL CHECK(role IN ('doctor','patient')),
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
      stock INTEGER NOT NULL,
      price INTEGER NOT NULL
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
  `);

  // migrate older status values (from earlier versions)
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
    ];
    const tx = db.transaction((rows) => rows.forEach((r) => insert.run(r)));
    tx(seed);
  }
}

module.exports = { db, initDb };

