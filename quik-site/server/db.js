const path = require('path');
const Database = require('better-sqlite3');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'quik.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS squares (
    x INTEGER NOT NULL,
    y INTEGER NOT NULL,
    color TEXT NOT NULL,
    label TEXT,
    price_paid INTEGER NOT NULL DEFAULT 0,
    claimed_at INTEGER NOT NULL,
    PRIMARY KEY (x, y)
  );

  CREATE TABLE IF NOT EXISTS reservations (
    x INTEGER NOT NULL,
    y INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    color TEXT NOT NULL,
    label TEXT,
    reserved_at INTEGER NOT NULL,
    PRIMARY KEY (x, y)
  );

  CREATE TABLE IF NOT EXISTS claims_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    x0 INTEGER, y0 INTEGER, x1 INTEGER, y1 INTEGER,
    count INTEGER NOT NULL,
    color TEXT,
    label TEXT,
    price INTEGER NOT NULL DEFAULT 0,
    is_system INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    ts INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

function getMeta(key, fallback) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setMeta(key, value) {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

// First-ever boot: stamp the launch date (starts the free-period clock)
// and set the starting grid size. Both live in the database, not in code,
// so they survive restarts and deploys.
if (getMeta('launch_ts', null) === null) setMeta('launch_ts', Date.now());
if (getMeta('grid_size', null) === null) setMeta('grid_size', 200);

module.exports = { db, getMeta, setMeta };
