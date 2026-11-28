/*
  Database layer. Two backends, same async API:
  - PostgreSQL (when DATABASE_URL is set, e.g. a free Neon database) -- data survives restarts anywhere
  - SQLite file (otherwise) in DATA_DIR -- for a computer or a paid Render disk

  API: q1(sql, ...args) -> first row | undefined
       qa(sql, ...args) -> rows
       run(sql, ...args) -> { changes }
       insert(sql, ...args) -> new id   (INSERT into a table with an "id" column)
       tx(async fn)      -> runs fn inside one transaction
  SQL is written once with "?" placeholders and SQLite spellings; it is translated for PostgreSQL here.
*/
"use strict";
const path = require("path");
const fs = require("fs");
const { AsyncLocalStorage } = require("node:async_hooks");

const TABLES = [
  `zones (id {ID}, name TEXT NOT NULL UNIQUE)`,
  `campuses (id {ID}, zone_id INTEGER NOT NULL REFERENCES zones(id), name TEXT NOT NULL, UNIQUE(zone_id, name))`,
  `batches (id {ID}, campus_id INTEGER NOT NULL REFERENCES campuses(id), name TEXT NOT NULL,
     level TEXT NOT NULL DEFAULT '11', year TEXT DEFAULT '', UNIQUE(campus_id, name))`,
  `users (id {ID}, username TEXT NOT NULL {USERNAME}, pass TEXT NOT NULL,
     role TEXT NOT NULL CHECK(role IN ('central','zone','campus','student')), name TEXT NOT NULL DEFAULT '',
     zone_id INTEGER REFERENCES zones(id), campus_id INTEGER REFERENCES campuses(id), batch_id INTEGER REFERENCES batches(id),
     roll TEXT UNIQUE, active INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT {NOW})`,
  `sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires BIGINT NOT NULL)`,
  `questions (id {ID}, subject TEXT NOT NULL, chapter TEXT DEFAULT '', topic TEXT DEFAULT '',
     qtype TEXT NOT NULL, difficulty TEXT DEFAULT 'Medium', text TEXT DEFAULT '', image TEXT DEFAULT '', options TEXT DEFAULT '[]',
     answer TEXT NOT NULL DEFAULT '', solution TEXT DEFAULT '', created_by INTEGER, created_at TEXT DEFAULT {NOW},
     fmt TEXT DEFAULT '', source TEXT DEFAULT '', ref TEXT DEFAULT '', year INTEGER, exam TEXT DEFAULT '')`,
  `tests (id {ID}, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, test_date TEXT DEFAULT '',
     sheet TEXT NOT NULL, answer_key TEXT DEFAULT '{}', published INTEGER NOT NULL DEFAULT 0, created_by INTEGER,
     created_at TEXT DEFAULT {NOW})`,
  `test_batches (test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
     batch_id INTEGER NOT NULL REFERENCES batches(id), PRIMARY KEY(test_id, batch_id))`,
  `attempts (id {ID}, test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE, student_id INTEGER NOT NULL REFERENCES users(id),
     started_at BIGINT NOT NULL, ends_at BIGINT NOT NULL, state TEXT NOT NULL DEFAULT '{}', saved_at BIGINT, submitted_at BIGINT, UNIQUE(test_id, student_id))`,
  `settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '')`,
  `images (id TEXT PRIMARY KEY, type TEXT NOT NULL, data TEXT NOT NULL)`,
  `test_questions (test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE, qno INTEGER NOT NULL,
     question_id INTEGER NOT NULL REFERENCES questions(id), PRIMARY KEY(test_id, qno))`,
  `results (id {ID}, test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
     student_id INTEGER NOT NULL REFERENCES users(id), answers TEXT NOT NULL, source TEXT DEFAULT '', uploaded_by INTEGER,
     uploaded_at TEXT DEFAULT {NOW}, UNIQUE(test_id, student_id))`,
];
const TABLE_NAMES = TABLES.map(t => t.split(" ")[0]);
// columns added after the first release; older databases get them on start-up
const ADDED_COLUMNS = [["questions", "fmt", "TEXT DEFAULT ''"], ["questions", "source", "TEXT DEFAULT ''"], ["questions", "ref", "TEXT DEFAULT ''"], ["questions", "year", "INTEGER"], ["questions", "exam", "TEXT DEFAULT ''"],
  ["tests", "mode", "TEXT DEFAULT 'omr'"], ["tests", "duration", "INTEGER"], ["tests", "opens_at", "BIGINT"], ["tests", "closes_at", "BIGINT"],
  ["tests", "max_exits", "INTEGER DEFAULT 0"], ["attempts", "exits", "TEXT DEFAULT '[]'"],
  ["questions", "hidden", "INTEGER DEFAULT 0"]];
const INDEXES = ["CREATE INDEX IF NOT EXISTS questions_ref ON questions (ref)", "CREATE INDEX IF NOT EXISTS questions_chapter ON questions (subject, chapter)"];
const PG_NOW = "to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')";

// PostgreSQL error -> the same messages the SQLite backend gives, so callers handle one kind
const PG_UNIQUE = { users_username_lower: "users.username", users_roll_key: "users.roll", tests_code_key: "tests.code" };
function normalizePgError(e) {
  if (e && e.code === "23505") { const err = new Error(`UNIQUE constraint failed: ${PG_UNIQUE[e.constraint] || e.constraint || "unknown"}`); err.cause = e; return err; }
  if (e && e.code === "23503") { const err = new Error("FOREIGN KEY constraint failed"); err.cause = e; return err; }
  return e;
}

async function openPostgres(url) {
  const { Pool, types } = require("pg");
  types.setTypeParser(20, v => (v === null ? null : Number(v)));   // COUNT(*) and BIGINT as numbers
  const pool = new Pool({ connectionString: url, max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 20000 });
  pool.on("error", e => console.warn("Database connection dropped (will reconnect):", e.message));
  const als = new AsyncLocalStorage();
  const toPg = sql => { let i = 0; return sql.replace(/datetime\('now'\)/g, PG_NOW).replace(/ LIKE /g, " ILIKE ").replace(/\?/g, () => "$" + ++i); };
  const exec = async (sql, args) => {
    try { return await (als.getStore() || pool).query(toPg(sql), args); }
    catch (e) { throw normalizePgError(e); }
  };
  for (const t of TABLES)
    await pool.query("CREATE TABLE IF NOT EXISTS " + t.replace(/\{ID\}/g, "SERIAL PRIMARY KEY").replace("{USERNAME}", "").replace(/\{NOW\}/g, `(${PG_NOW})`));
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower ON users (lower(username))");
  for (const [t, c, def] of ADDED_COLUMNS) await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS ${c} ${def}`);
  for (const i of INDEXES) await pool.query(i);
  return {
    kind: "postgres",
    q1: async (sql, ...a) => (await exec(sql, a)).rows[0],
    qa: async (sql, ...a) => (await exec(sql, a)).rows,
    run: async (sql, ...a) => ({ changes: (await exec(sql, a)).rowCount }),
    insert: async (sql, ...a) => (await exec(sql + " RETURNING id", a)).rows[0].id,
    async tx(fn) {
      if (als.getStore()) return fn();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const r = await als.run(client, fn);
        await client.query("COMMIT");
        return r;
      } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw normalizePgError(e); }
      finally { client.release(); }
    },
    async dump() { const out = {}; for (const t of TABLE_NAMES) out[t] = (await pool.query(`SELECT * FROM ${t}`)).rows; return out; },
  };
}

function openSqlite(dataDir) {
  const { DatabaseSync } = require("node:sqlite");
  const file = path.join(dataDir, "portal.db");
  const d = new DatabaseSync(file);
  d.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  for (const t of TABLES)
    d.exec("CREATE TABLE IF NOT EXISTS " + t.replace(/\{ID\}/g, "INTEGER PRIMARY KEY").replace("{USERNAME}", "UNIQUE COLLATE NOCASE").replace(/\{NOW\}/g, "(datetime('now'))"));
  for (const [t, c, def] of ADDED_COLUMNS)
    if (!d.prepare(`PRAGMA table_info(${t})`).all().some(r => r.name === c)) d.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`);
  for (const i of INDEXES) d.exec(i);
  let inTx = false;
  return {
    kind: "sqlite", file,
    q1: async (sql, ...a) => d.prepare(sql).get(...a),
    qa: async (sql, ...a) => d.prepare(sql).all(...a),
    run: async (sql, ...a) => ({ changes: Number(d.prepare(sql).run(...a).changes) }),
    insert: async (sql, ...a) => Number(d.prepare(sql).run(...a).lastInsertRowid),
    // SQLite calls finish synchronously, so nothing else can run between BEGIN and COMMIT
    async tx(fn) {
      if (inTx) return fn();
      d.exec("BEGIN"); inTx = true;
      try { const r = await fn(); d.exec("COMMIT"); return r; }
      catch (e) { d.exec("ROLLBACK"); throw e; }
      finally { inTx = false; }
    },
    backupTo(target) { d.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`); },
    async dump() { const out = {}; for (const t of TABLE_NAMES) out[t] = d.prepare(`SELECT * FROM ${t}`).all(); return out; },
  };
}

// Returns { db, dataDir, temporary } -- temporary = data will not survive a restart (Render without disk or database)
async function openDatabase(env, appDir) {
  if (env.DATABASE_URL) return { db: await openPostgres(env.DATABASE_URL), dataDir: null, temporary: false };
  let dataDir = env.DATA_DIR || path.join(appDir, "data");
  let temporary = !env.DATA_DIR && !!env.RENDER;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.accessSync(dataDir, fs.constants.W_OK);
  } catch (e) {
    const fallback = path.join(appDir, "data");
    console.warn(`WARNING: cannot write to ${dataDir} (${e.code}). No disk attached? Using ${fallback} instead. DATA WILL BE LOST on every restart or deploy. Set DATABASE_URL to keep data.`);
    dataDir = fallback; temporary = true;
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return { db: openSqlite(dataDir), dataDir, temporary };
}

module.exports = { openDatabase };
