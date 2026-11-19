/*
  Test Portal server
  - Node.js 22+, Express, built-in SQLite (one file: data/portal.db)
  - Roles: central (everything), zone (one zone), campus (one campus), student (own results)
  Run:  node server.js        (first run creates the central admin from ADMIN_USER / ADMIN_PASSWORD)
*/
"use strict";
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const OMR = require("./public/vendor/omr_core.js");

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, "portal.db"));
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

// ------------------------------------------------------------------ schema
db.exec(`
CREATE TABLE IF NOT EXISTS zones (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS campuses (id INTEGER PRIMARY KEY, zone_id INTEGER NOT NULL REFERENCES zones(id), name TEXT NOT NULL, UNIQUE(zone_id, name));
CREATE TABLE IF NOT EXISTS batches (id INTEGER PRIMARY KEY, campus_id INTEGER NOT NULL REFERENCES campuses(id), name TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT '11', year TEXT DEFAULT '', UNIQUE(campus_id, name));
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, pass TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('central','zone','campus','student')), name TEXT NOT NULL DEFAULT '',
  zone_id INTEGER REFERENCES zones(id), campus_id INTEGER REFERENCES campuses(id), batch_id INTEGER REFERENCES batches(id),
  roll TEXT UNIQUE, active INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS questions (id INTEGER PRIMARY KEY, subject TEXT NOT NULL, chapter TEXT DEFAULT '', topic TEXT DEFAULT '',
  qtype TEXT NOT NULL, difficulty TEXT DEFAULT 'Medium', text TEXT DEFAULT '', image TEXT DEFAULT '', options TEXT DEFAULT '[]',
  answer TEXT NOT NULL DEFAULT '', solution TEXT DEFAULT '', created_by INTEGER, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS tests (id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, test_date TEXT DEFAULT '',
  sheet TEXT NOT NULL, answer_key TEXT DEFAULT '{}', published INTEGER NOT NULL DEFAULT 0, created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS test_batches (test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  batch_id INTEGER NOT NULL REFERENCES batches(id), PRIMARY KEY(test_id, batch_id));
CREATE TABLE IF NOT EXISTS test_questions (test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE, qno INTEGER NOT NULL,
  question_id INTEGER NOT NULL REFERENCES questions(id), PRIMARY KEY(test_id, qno));
CREATE TABLE IF NOT EXISTS results (id INTEGER PRIMARY KEY, test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES users(id), answers TEXT NOT NULL, source TEXT DEFAULT '', uploaded_by INTEGER,
  uploaded_at TEXT DEFAULT (datetime('now')), UNIQUE(test_id, student_id));
`);

// ------------------------------------------------------------------ helpers
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pw), salt, 32);
  return `scrypt$${salt.toString("hex")}$${h.toString("hex")}`;
}
function checkPassword(pw, stored) {
  const [, s, h] = String(stored).split("$");
  if (!s || !h) return false;
  const calc = crypto.scryptSync(String(pw), Buffer.from(s, "hex"), 32);
  return crypto.timingSafeEqual(calc, Buffer.from(h, "hex"));
}
const q1 = (sql, ...a) => db.prepare(sql).get(...a);
const qa = (sql, ...a) => db.prepare(sql).all(...a);
const run = (sql, ...a) => db.prepare(sql).run(...a);
function tx(fn) {
  db.exec("BEGIN");
  try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; }
}
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = msg => { throw new HttpError(400, msg); };
const forbid = (msg = "You don't have access to this.") => { throw new HttpError(403, msg); };
const str = (v, max = 200) => String(v == null ? "" : v).trim().slice(0, max);

// first central admin
if (!q1("SELECT id FROM users WHERE role='central' LIMIT 1")) {
  const u = process.env.ADMIN_USER || "admin";
  const p = process.env.ADMIN_PASSWORD || "change-me-now";
  run("INSERT INTO users (username, pass, role, name) VALUES (?,?,?,?)", u, hashPassword(p), "central", "Central admin");
  console.log(`Created central admin "${u}". Log in and change the password.`);
}

// ------------------------------------------------------------------ app
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "25mb" }));
app.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Referrer-Policy", "same-origin");
  next();
});
app.use(express.static(path.join(__dirname, "public"), { index: "index.html", maxAge: "1h" }));

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function auth(req, res, next) {
  const t = cookies(req).sid;
  const s = t && q1("SELECT s.user_id, s.expires FROM sessions s WHERE s.token=?", t);
  if (!s || s.expires < Date.now()) return res.status(401).json({ error: "Please log in." });
  const u = q1("SELECT id, username, role, name, zone_id, campus_id, batch_id, roll, active FROM users WHERE id=?", s.user_id);
  if (!u || !u.active) return res.status(401).json({ error: "Account is not active." });
  req.user = u;
  next();
}
const admin = (req, res, next) => (req.user.role === "student" ? res.status(403).json({ error: "Admins only." }) : next());
const central = (req, res, next) => (req.user.role !== "central" ? res.status(403).json({ error: "Central team only." }) : next());
const wrap = fn => (req, res) => {
  try { const out = fn(req, res); if (out !== undefined) res.json(out); }
  catch (e) {
    if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
    if (/UNIQUE constraint failed: users.username/.test(e.message)) return res.status(400).json({ error: "That username is already taken." });
    if (/UNIQUE constraint failed: users.roll/.test(e.message)) return res.status(400).json({ error: "That roll number already belongs to another student." });
    if (/UNIQUE constraint failed: tests.code/.test(e.message)) return res.status(400).json({ error: "A test with that code already exists." });
    if (/UNIQUE constraint/.test(e.message)) return res.status(400).json({ error: "That name is already used here." });
    if (/FOREIGN KEY/.test(e.message)) return res.status(400).json({ error: "This is still in use, so it can't be removed." });
    console.error(e);
    res.status(500).json({ error: "Something went wrong on the server." });
  }
};

// scope: which campuses a user may see
function campusScope(u) {
  if (u.role === "central") return null; // all
  if (u.role === "zone") return qa("SELECT id FROM campuses WHERE zone_id=?", u.zone_id).map(r => r.id);
  if (u.role === "campus") return [u.campus_id];
  return [];
}
function canSeeCampus(u, campusId) { const s = campusScope(u); return s === null || s.includes(Number(campusId)); }
function inList(col, ids) { return ids === null ? "1=1" : ids.length ? `${col} IN (${ids.map(Number).join(",")})` : "0=1"; }

// ------------------------------------------------------------------ auth
// simple protection against password guessing: 10 failed tries per username+IP per 15 minutes
const failures = new Map();
app.post("/api/login", wrap((req, res) => {
  const { username, password } = req.body || {};
  const fk = `${String(username).toLowerCase()}|${req.ip}`, now = Date.now();
  const f = failures.get(fk);
  if (f && f.n >= 10 && now - f.t < 15 * 60e3) throw new HttpError(429, "Too many wrong tries. Wait 15 minutes and try again.");
  const u = q1("SELECT * FROM users WHERE username=?", str(username, 80));
  if (!u || !u.active || !checkPassword(password || "", u.pass)) {
    const cur = f && now - f.t < 15 * 60e3 ? f : { n: 0, t: now };
    failures.set(fk, { n: cur.n + 1, t: cur.t });
    throw new HttpError(401, "Wrong username or password.");
  }
  failures.delete(fk);
  const token = crypto.randomBytes(32).toString("hex");
  const days = 14;
  run("INSERT INTO sessions (token, user_id, expires) VALUES (?,?,?)", token, u.id, Date.now() + days * 864e5);
  run("DELETE FROM sessions WHERE expires < ?", Date.now());
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  res.set("Set-Cookie", `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${days * 86400}${secure}`);
  return { ok: true };
}));
app.post("/api/logout", (req, res) => {
  const t = cookies(req).sid;
  if (t) run("DELETE FROM sessions WHERE token=?", t);
  res.set("Set-Cookie", "sid=; Path=/; Max-Age=0");
  res.json({ ok: true });
});
app.get("/api/me", auth, wrap(req => {
  const u = req.user;
  const extra = {};
  if (u.zone_id) extra.zone = q1("SELECT name FROM zones WHERE id=?", u.zone_id)?.name;
  if (u.campus_id) extra.campus = q1("SELECT name FROM campuses WHERE id=?", u.campus_id)?.name;
  if (u.batch_id) extra.batch = q1("SELECT name, level FROM batches WHERE id=?", u.batch_id);
  return { ...u, ...extra };
}));
app.post("/api/me/password", auth, wrap(req => {
  const { current, next } = req.body || {};
  const u = q1("SELECT pass FROM users WHERE id=?", req.user.id);
  if (!checkPassword(current || "", u.pass)) bad("Current password is wrong.");
  if (String(next || "").length < 6) bad("New password must be at least 6 characters.");
  run("UPDATE users SET pass=? WHERE id=?", hashPassword(next), req.user.id);
  return { ok: true };
}));

// ------------------------------------------------------------------ structure
app.get("/api/structure", auth, admin, wrap(req => {
  const scope = campusScope(req.user);
  const campuses = qa(`SELECT c.id, c.name, c.zone_id, (SELECT COUNT(*) FROM users u WHERE u.campus_id=c.id AND u.role='student' AND u.active=1) AS students
                       FROM campuses c WHERE ${inList("c.id", scope)} ORDER BY c.name`);
  const zoneIds = [...new Set(campuses.map(c => c.zone_id))];
  const zones = req.user.role === "central" ? qa("SELECT id, name FROM zones ORDER BY name")
    : qa(`SELECT id, name FROM zones WHERE ${inList("id", req.user.role === "zone" ? [req.user.zone_id] : zoneIds)} ORDER BY name`);
  const batches = qa(`SELECT b.id, b.name, b.level, b.year, b.campus_id,
                      (SELECT COUNT(*) FROM users u WHERE u.batch_id=b.id AND u.role='student' AND u.active=1) AS students
                      FROM batches b WHERE ${inList("b.campus_id", scope)} ORDER BY b.level, b.name`);
  return { zones, campuses, batches };
}));
app.post("/api/zones", auth, central, wrap(req => ({ id: Number(run("INSERT INTO zones (name) VALUES (?)", str(req.body.name, 80) || bad("Zone name is needed.")).lastInsertRowid) })));
app.patch("/api/zones/:id", auth, central, wrap(req => { run("UPDATE zones SET name=? WHERE id=?", str(req.body.name, 80) || bad("Name is needed."), req.params.id); return { ok: true }; }));
app.delete("/api/zones/:id", auth, central, wrap(req => { run("DELETE FROM zones WHERE id=?", req.params.id); return { ok: true }; }));
app.post("/api/campuses", auth, central, wrap(req => {
  if (!q1("SELECT id FROM zones WHERE id=?", req.body.zone_id)) bad("Choose a zone.");
  return { id: Number(run("INSERT INTO campuses (zone_id, name) VALUES (?,?)", req.body.zone_id, str(req.body.name, 80) || bad("Campus name is needed.")).lastInsertRowid) };
}));
app.patch("/api/campuses/:id", auth, central, wrap(req => { run("UPDATE campuses SET name=? WHERE id=?", str(req.body.name, 80) || bad("Name is needed."), req.params.id); return { ok: true }; }));
app.delete("/api/campuses/:id", auth, central, wrap(req => { run("DELETE FROM campuses WHERE id=?", req.params.id); return { ok: true }; }));
const LEVELS = ["11", "12", "Dropper"];
app.post("/api/batches", auth, central, wrap(req => {
  if (!q1("SELECT id FROM campuses WHERE id=?", req.body.campus_id)) bad("Choose a campus.");
  const level = LEVELS.includes(req.body.level) ? req.body.level : bad("Choose 11, 12 or Dropper.");
  return { id: Number(run("INSERT INTO batches (campus_id, name, level, year) VALUES (?,?,?,?)", req.body.campus_id, str(req.body.name, 60) || bad("Batch name is needed."), level, str(req.body.year, 20)).lastInsertRowid) };
}));
app.patch("/api/batches/:id", auth, central, wrap(req => {
  const level = LEVELS.includes(req.body.level) ? req.body.level : bad("Choose 11, 12 or Dropper.");
  run("UPDATE batches SET name=?, level=?, year=? WHERE id=?", str(req.body.name, 60) || bad("Name is needed."), level, str(req.body.year, 20), req.params.id);
  return { ok: true };
}));
app.delete("/api/batches/:id", auth, central, wrap(req => { run("DELETE FROM batches WHERE id=?", req.params.id); return { ok: true }; }));

// ------------------------------------------------------------------ people
function placeFor(batchId, campusId, zoneId) {
  if (batchId) {
    const b = q1("SELECT b.id, b.campus_id, c.zone_id FROM batches b JOIN campuses c ON c.id=b.campus_id WHERE b.id=?", batchId) || bad("Unknown batch.");
    return { batch_id: b.id, campus_id: b.campus_id, zone_id: b.zone_id };
  }
  if (campusId) {
    const c = q1("SELECT id, zone_id FROM campuses WHERE id=?", campusId) || bad("Unknown campus.");
    return { batch_id: null, campus_id: c.id, zone_id: c.zone_id };
  }
  if (zoneId) { q1("SELECT id FROM zones WHERE id=?", zoneId) || bad("Unknown zone."); return { batch_id: null, campus_id: null, zone_id: Number(zoneId) }; }
  return { batch_id: null, campus_id: null, zone_id: null };
}
const cleanRoll = r => { const s = str(r, 20).replace(/\s/g, ""); if (s && !/^\d{1,8}$/.test(s)) bad(`Roll number "${s}" must be digits only (up to 8).`); return s || null; };
const cleanUser = u => { const s = str(u, 40); if (!/^[A-Za-z0-9._@-]{3,40}$/.test(s)) bad(`Username "${s}" must be 3-40 letters, digits, dot, dash or underscore.`); return s; };

app.get("/api/students", auth, admin, wrap(req => {
  const scope = campusScope(req.user);
  const where = [inList("u.campus_id", scope), "u.role='student'"];
  const args = [];
  if (req.query.batch) { where.push("u.batch_id=?"); args.push(req.query.batch); }
  if (req.query.campus) { where.push("u.campus_id=?"); args.push(req.query.campus); }
  if (req.query.zone) { where.push("u.zone_id=?"); args.push(req.query.zone); }
  if (req.query.q) { where.push("(u.name LIKE ? OR u.roll LIKE ? OR u.username LIKE ?)"); const like = `%${str(req.query.q, 40)}%`; args.push(like, like, like); }
  return qa(`SELECT u.id, u.username, u.name, u.roll, u.active, u.batch_id, u.campus_id, u.zone_id FROM users u
             WHERE ${where.join(" AND ")} ORDER BY u.roll, u.name LIMIT 5000`, ...args);
}));
app.post("/api/students", auth, central, wrap(req => {
  const b = req.body || {};
  const place = placeFor(b.batch_id || bad("Choose a batch."));
  const roll = cleanRoll(b.roll) || bad("Roll number is needed.");
  const username = b.username ? cleanUser(b.username) : roll;
  if (String(b.password || "").length < 6) bad("Password must be at least 6 characters.");
  const r = run(`INSERT INTO users (username, pass, role, name, zone_id, campus_id, batch_id, roll) VALUES (?,?,?,?,?,?,?,?)`,
    username, hashPassword(b.password), "student", str(b.name, 80), place.zone_id, place.campus_id, place.batch_id, roll);
  return { id: Number(r.lastInsertRowid) };
}));
// bulk import: rows of {roll, name, username?, password?, batch_id}
app.post("/api/students/bulk", auth, central, wrap(req => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows : bad("No rows.");
  if (rows.length > 10000) bad("At most 10,000 students at a time.");
  const errors = [], created = [];
  const seenRoll = new Set(), seenUser = new Set();
  rows.forEach((r, i) => {
    try {
      const roll = cleanRoll(r.roll) || bad("roll number missing");
      const username = r.username ? cleanUser(r.username) : roll;
      if (seenRoll.has(roll)) bad("roll number repeated in the file");
      if (seenUser.has(username.toLowerCase())) bad("username repeated in the file");
      seenRoll.add(roll); seenUser.add(username.toLowerCase());
      if (q1("SELECT id FROM users WHERE roll=?", roll)) bad("roll number already exists");
      if (q1("SELECT id FROM users WHERE username=?", username)) bad("username already exists");
      placeFor(r.batch_id || bad("batch not found"));
      const pw = r.password ? String(r.password) : null;
      if (pw && pw.length < 6) bad("password shorter than 6 characters");
      created.push({ roll, username, name: str(r.name, 80), batch_id: r.batch_id, password: pw });
    } catch (e) { errors.push({ row: r.row || i + 2, error: e.message }); }
  });
  if (errors.length) return { ok: false, errors };
  const out = [];
  tx(() => {
    const st = db.prepare(`INSERT INTO users (username, pass, role, name, zone_id, campus_id, batch_id, roll) VALUES (?,?,?,?,?,?,?,?)`);
    for (const c of created) {
      const pw = c.password || crypto.randomBytes(6).toString("base64").replace(/[^A-Za-z0-9]/g, "x").slice(0, 8);
      const p = placeFor(c.batch_id);
      st.run(c.username, hashPassword(pw), "student", c.name, p.zone_id, p.campus_id, p.batch_id, c.roll);
      out.push({ roll: c.roll, name: c.name, username: c.username, password: pw });
    }
  });
  return { ok: true, created: out };
}));
app.patch("/api/users/:id", auth, central, wrap(req => {
  const u = q1("SELECT * FROM users WHERE id=?", req.params.id) || bad("Unknown user.");
  const b = req.body || {};
  if (b.name !== undefined) run("UPDATE users SET name=? WHERE id=?", str(b.name, 80), u.id);
  if (b.active !== undefined) {
    if (u.id === req.user.id) bad("You can't deactivate your own account.");
    run("UPDATE users SET active=? WHERE id=?", b.active ? 1 : 0, u.id);
    if (!b.active) run("DELETE FROM sessions WHERE user_id=?", u.id);
  }
  if (b.username !== undefined) run("UPDATE users SET username=? WHERE id=?", cleanUser(b.username), u.id);
  if (u.role === "student") {
    if (b.roll !== undefined) run("UPDATE users SET roll=? WHERE id=?", cleanRoll(b.roll) || bad("Roll number is needed."), u.id);
    if (b.batch_id !== undefined) { const p = placeFor(b.batch_id); run("UPDATE users SET batch_id=?, campus_id=?, zone_id=? WHERE id=?", p.batch_id, p.campus_id, p.zone_id, u.id); }
  }
  if (b.password !== undefined) {
    if (String(b.password).length < 6) bad("Password must be at least 6 characters.");
    run("UPDATE users SET pass=? WHERE id=?", hashPassword(b.password), u.id);
    run("DELETE FROM sessions WHERE user_id=?", u.id);
  }
  return { ok: true };
}));
app.get("/api/admins", auth, central, wrap(() =>
  qa(`SELECT u.id, u.username, u.name, u.role, u.active, u.zone_id, u.campus_id FROM users u WHERE u.role IN ('central','zone','campus') ORDER BY u.role, u.name`)));
app.post("/api/admins", auth, central, wrap(req => {
  const b = req.body || {};
  const role = ["central", "zone", "campus"].includes(b.role) ? b.role : bad("Choose a level.");
  if (String(b.password || "").length < 6) bad("Password must be at least 6 characters.");
  const place = role === "zone" ? placeFor(null, null, b.zone_id || bad("Choose a zone.")) : role === "campus" ? placeFor(null, b.campus_id || bad("Choose a campus.")) : placeFor();
  const r = run("INSERT INTO users (username, pass, role, name, zone_id, campus_id) VALUES (?,?,?,?,?,?)",
    cleanUser(b.username), hashPassword(b.password), role, str(b.name, 80), place.zone_id, place.campus_id);
  return { id: Number(r.lastInsertRowid) };
}));

// ------------------------------------------------------------------ question bank
const QTYPES = ["single", "multi", "integer", "decimal"];
function cleanQuestion(b) {
  const qtype = QTYPES.includes(b.qtype) ? b.qtype : bad("Choose a question type.");
  let options = Array.isArray(b.options) ? b.options.map(o => str(o, 4000)) : [];
  let answer = str(b.answer, 40).toUpperCase().replace(/[\s,]/g, "");
  if (qtype === "single" && !/^[A-D]$/.test(answer)) bad("Answer must be one of A, B, C, D.");
  if (qtype === "multi") { if (!/^[A-D]{1,4}$/.test(answer)) bad("Answer must be letters like AC."); answer = [...new Set(answer)].sort().join(""); }
  if ((qtype === "integer" || qtype === "decimal") && !/^-?\d+(\.\d+)?(:-?\d+(\.\d+)?)?$/.test(answer)) bad("Answer must be a number like 12 or a range like 4.5:4.6.");
  if (qtype === "single" || qtype === "multi") options = options.slice(0, 4); else options = [];
  const image = str(b.image, 3_000_000);
  if (image && !/^data:image\/(png|jpeg|webp|gif);base64,/.test(image)) bad("Image must be PNG, JPG, WEBP or GIF.");
  if (!str(b.text, 20000) && !image) bad("Add the question text or an image.");
  return {
    subject: str(b.subject, 40) || bad("Subject is needed."), chapter: str(b.chapter, 120), topic: str(b.topic, 120), qtype,
    difficulty: ["Easy", "Medium", "Hard"].includes(b.difficulty) ? b.difficulty : "Medium",
    text: str(b.text, 20000), image, options: JSON.stringify(options), answer, solution: str(b.solution, 20000),
  };
}
app.get("/api/questions", auth, admin, wrap(req => {
  const where = ["1=1"], args = [];
  for (const k of ["subject", "chapter", "qtype", "difficulty"]) if (req.query[k]) { where.push(`${k}=?`); args.push(str(req.query[k], 120)); }
  if (req.query.q) { where.push("(text LIKE ? OR topic LIKE ? OR chapter LIKE ?)"); const l = `%${str(req.query.q, 60)}%`; args.push(l, l, l); }
  const rows = qa(`SELECT id, subject, chapter, topic, qtype, difficulty, substr(text,1,300) AS text, image != '' AS has_image, answer
                   FROM questions WHERE ${where.join(" AND ")} ORDER BY subject, chapter, id DESC LIMIT 1000`, ...args);
  const facets = { subjects: qa("SELECT DISTINCT subject FROM questions ORDER BY subject").map(r => r.subject),
                   chapters: qa("SELECT DISTINCT subject, chapter FROM questions WHERE chapter != '' ORDER BY chapter") };
  return { rows, facets, total: q1("SELECT COUNT(*) AS n FROM questions").n };
}));
app.get("/api/questions/:id", auth, admin, wrap(req => {
  const q = q1("SELECT * FROM questions WHERE id=?", req.params.id) || new HttpError(404, "Not found");
  if (q instanceof HttpError) throw q;
  q.options = JSON.parse(q.options || "[]");
  return q;
}));
app.post("/api/questions", auth, central, wrap(req => {
  const q = cleanQuestion(req.body || {});
  const r = run(`INSERT INTO questions (subject, chapter, topic, qtype, difficulty, text, image, options, answer, solution, created_by)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?)`, q.subject, q.chapter, q.topic, q.qtype, q.difficulty, q.text, q.image, q.options, q.answer, q.solution, req.user.id);
  return { id: Number(r.lastInsertRowid) };
}));
app.put("/api/questions/:id", auth, central, wrap(req => {
  const q = cleanQuestion(req.body || {});
  run(`UPDATE questions SET subject=?, chapter=?, topic=?, qtype=?, difficulty=?, text=?, image=?, options=?, answer=?, solution=? WHERE id=?`,
    q.subject, q.chapter, q.topic, q.qtype, q.difficulty, q.text, q.image, q.options, q.answer, q.solution, req.params.id);
  return { ok: true };
}));
app.delete("/api/questions/:id", auth, central, wrap(req => {
  if (q1("SELECT 1 FROM test_questions WHERE question_id=?", req.params.id)) bad("This question is used in a test, so it can't be deleted.");
  run("DELETE FROM questions WHERE id=?", req.params.id); return { ok: true };
}));

// ------------------------------------------------------------------ tests
const layoutOf = t => OMR.getLayout(t.sheet) || bad("Unknown sheet type.");
function testRow(t) {
  const layout = OMR.getLayout(t.sheet);
  return { ...t, answer_key: JSON.parse(t.answer_key || "{}"), sheet_title: layout ? layout.title : t.sheet, questions: layout ? OMR.totalQ(layout) : 0,
           batch_ids: qa("SELECT batch_id FROM test_batches WHERE test_id=?", t.id).map(r => r.batch_id) };
}
function visibleTest(u, id) {
  const t = q1("SELECT * FROM tests WHERE id=?", id);
  if (!t) throw new HttpError(404, "Test not found.");
  if (u.role === "central") return t;
  const scope = campusScope(u);
  const ok = q1(`SELECT 1 FROM test_batches tb JOIN batches b ON b.id=tb.batch_id WHERE tb.test_id=? AND ${inList("b.campus_id", scope)} LIMIT 1`, id);
  if (!ok) forbid();
  return t;
}
app.get("/api/tests", auth, admin, wrap(req => {
  const scope = campusScope(req.user);
  const rows = req.user.role === "central" ? qa("SELECT * FROM tests ORDER BY test_date DESC, id DESC")
    : qa(`SELECT DISTINCT t.* FROM tests t JOIN test_batches tb ON tb.test_id=t.id JOIN batches b ON b.id=tb.batch_id
          WHERE ${inList("b.campus_id", scope)} ORDER BY t.test_date DESC, t.id DESC`);
  return rows.map(t => {
    const r = testRow(t);
    r.result_count = q1(`SELECT COUNT(*) AS n FROM results r JOIN users u ON u.id=r.student_id WHERE r.test_id=? AND ${inList("u.campus_id", scope)}`, t.id).n;
    r.student_count = q1(`SELECT COUNT(*) AS n FROM users u JOIN test_batches tb ON tb.batch_id=u.batch_id WHERE tb.test_id=? AND u.role='student' AND u.active=1 AND ${inList("u.campus_id", scope)}`, t.id).n;
    return r;
  });
}));
function saveTest(req, id) {
  const b = req.body || {};
  const sheet = OMR.PRESETS[b.sheet] ? b.sheet : bad("Choose an OMR sheet type.");
  const code = str(b.code, 16).replace(/[^A-Za-z0-9_-]/g, "") || bad("Test code is needed (letters, digits, - or _).");
  const batchIds = (Array.isArray(b.batch_ids) ? b.batch_ids : []).map(Number).filter(n => q1("SELECT id FROM batches WHERE id=?", n));
  if (!batchIds.length) bad("Choose at least one batch.");
  return tx(() => {
    if (id) {
      const t = q1("SELECT * FROM tests WHERE id=?", id) || bad("Unknown test.");
      if (t.sheet !== sheet && q1("SELECT 1 FROM results WHERE test_id=? LIMIT 1", id)) bad("Sheets are already read for this test, so its sheet type can't change.");
      run("UPDATE tests SET code=?, name=?, test_date=?, sheet=? WHERE id=?", code, str(b.name, 100) || bad("Test name is needed."), str(b.test_date, 20), sheet, id);
    } else {
      id = Number(run("INSERT INTO tests (code, name, test_date, sheet, created_by) VALUES (?,?,?,?,?)", code, str(b.name, 100) || bad("Test name is needed."), str(b.test_date, 20), sheet, req.user.id).lastInsertRowid);
    }
    run("DELETE FROM test_batches WHERE test_id=?", id);
    for (const bid of batchIds) run("INSERT INTO test_batches (test_id, batch_id) VALUES (?,?)", id, bid);
    return { id };
  });
}
app.post("/api/tests", auth, central, wrap(req => saveTest(req, null)));
app.put("/api/tests/:id", auth, central, wrap(req => saveTest(req, Number(req.params.id))));
app.delete("/api/tests/:id", auth, central, wrap(req => { run("DELETE FROM tests WHERE id=?", req.params.id); return { ok: true }; }));
app.get("/api/tests/:id", auth, admin, wrap(req => {
  const t = testRow(visibleTest(req.user, req.params.id));
  t.layout = OMR.getLayout(t.sheet);
  t.linked = qa(`SELECT tq.qno, q.id, q.subject, q.chapter, q.qtype, substr(q.text,1,160) AS text, q.answer FROM test_questions tq
                 JOIN questions q ON q.id=tq.question_id WHERE tq.test_id=? ORDER BY tq.qno`, t.id);
  return t;
}));
// answer key: {qno: answer}; can also pull answers from linked bank questions
app.put("/api/tests/:id/key", auth, central, wrap(req => {
  const t = visibleTest(req.user, req.params.id);
  const layout = layoutOf(t), n = OMR.totalQ(layout);
  const key = {};
  for (const [k, v] of Object.entries(req.body.key || {})) {
    const q = Number(k), a = str(v, 30).toUpperCase().replace(/[\s,]/g, "");
    if (q >= 1 && q <= n && a) key[q] = a;
  }
  run("UPDATE tests SET answer_key=? WHERE id=?", JSON.stringify(key), t.id);
  return { ok: true, count: Object.keys(key).length };
}));
app.put("/api/tests/:id/questions", auth, central, wrap(req => {
  const t = visibleTest(req.user, req.params.id);
  const layout = layoutOf(t), idx = OMR.questionIndex(layout);
  const links = req.body.links || {}; // {qno: question_id}
  return tx(() => {
    run("DELETE FROM test_questions WHERE test_id=?", t.id);
    const key = JSON.parse(t.answer_key || "{}");
    for (const [k, v] of Object.entries(links)) {
      const qno = Number(k), qid = Number(v);
      const slot = idx.find(x => x.qno === qno);
      const q = q1("SELECT id, qtype, answer FROM questions WHERE id=?", qid);
      if (!slot || !q) continue;
      const wantNum = slot.sec.qtype === "integer" || slot.sec.qtype === "decimal", isNum = q.qtype === "integer" || q.qtype === "decimal";
      if (wantNum !== isNum) bad(`Q${qno} needs a ${wantNum ? "numerical" : "multiple-choice"} question.`);
      run("INSERT INTO test_questions (test_id, qno, question_id) VALUES (?,?,?)", t.id, qno, qid);
      key[qno] = slot.sec.options === "1234" && /^[A-D]$/.test(q.answer) ? String("ABCD".indexOf(q.answer) + 1) : q.answer;
    }
    run("UPDATE tests SET answer_key=? WHERE id=?", JSON.stringify(key), t.id);
    return { ok: true };
  });
}));
app.post("/api/tests/:id/publish", auth, central, wrap(req => {
  const t = visibleTest(req.user, req.params.id);
  run("UPDATE tests SET published=? WHERE id=?", req.body.published ? 1 : 0, t.id);
  return { ok: true };
}));
// students who sit this test (for printing personalised sheets), limited to the admin's campuses
app.get("/api/tests/:id/roster", auth, admin, wrap(req => {
  const t = visibleTest(req.user, req.params.id);
  const scope = campusScope(req.user);
  return qa(`SELECT u.id, u.roll, u.name, u.batch_id, u.campus_id FROM users u JOIN test_batches tb ON tb.batch_id=u.batch_id
             WHERE tb.test_id=? AND u.role='student' AND u.active=1 AND ${inList("u.campus_id", scope)} ORDER BY u.roll`, t.id);
}));
// save answers read from OMR scans (the browser reads the sheets; the server checks and stores)
app.post("/api/tests/:id/results", auth, admin, wrap(req => {
  const t = visibleTest(req.user, req.params.id);
  const layout = layoutOf(t), n = OMR.totalQ(layout);
  const rows = Array.isArray(req.body.rows) ? req.body.rows : bad("No sheets sent.");
  const scope = campusScope(req.user);
  const saved = [], rejected = [];
  tx(() => {
    for (const r of rows) {
      const roll = str(r.roll, 20).replace(/^0+/, "");
      const st = q1(`SELECT u.id, u.campus_id FROM users u JOIN test_batches tb ON tb.batch_id=u.batch_id
                     WHERE tb.test_id=? AND u.role='student' AND ltrim(u.roll,'0')=?`, t.id, roll);
      if (!st) { rejected.push({ roll: r.roll, error: "No student with this roll number in this test's batches." }); continue; }
      if (!canSeeCampus(req.user, st.campus_id)) { rejected.push({ roll: r.roll, error: "This student belongs to another campus." }); continue; }
      const answers = {};
      for (const [k, v] of Object.entries(r.answers || {})) { const q = Number(k); if (q >= 1 && q <= n) answers[q] = str(v, 12); }
      run(`INSERT INTO results (test_id, student_id, answers, source, uploaded_by) VALUES (?,?,?,?,?)
           ON CONFLICT(test_id, student_id) DO UPDATE SET answers=excluded.answers, source=excluded.source, uploaded_by=excluded.uploaded_by, uploaded_at=datetime('now')`,
        t.id, st.id, JSON.stringify(answers), str(r.source, 200), req.user.id);
      saved.push(r.roll);
    }
  });
  return { saved: saved.length, rejected };
}));

// marks for every result of a test, scored now from the stored key (so key changes re-score instantly)
function scoreTest(t) {
  const layout = layoutOf(t);
  const key = JSON.parse(t.answer_key || "{}");
  const rows = qa(`SELECT r.student_id, r.answers, r.uploaded_at, u.roll, u.name, u.batch_id, u.campus_id, u.zone_id
                   FROM results r JOIN users u ON u.id=r.student_id WHERE r.test_id=?`, t.id);
  const scored = OMR.scoreAll(rows.map(r => ({ roll: r.roll, test: t.code, paper: "", layout: t.sheet, status: "OK", answers: JSON.parse(r.answers) })),
    { "*": key }, OMR.getLayout);
  scored.forEach((s, i) => Object.assign(s, { student_id: rows[i].student_id, name: rows[i].name, batch_id: rows[i].batch_id,
    campus_id: rows[i].campus_id, zone_id: rows[i].zone_id }));
  // ranks: overall, within campus, within batch
  const rankBy = (k, field) => {
    const groups = {};
    scored.forEach(s => (groups[k(s)] = groups[k(s)] || []).push(s));
    for (const g of Object.values(groups)) {
      g.sort((a, b) => b.total - a.total);
      g.forEach((s, i) => (s[field] = i > 0 && g[i - 1].total === s.total ? g[i - 1][field] : i + 1));
      g.forEach(s => (s[field + "_of"] = g.length));
    }
  };
  rankBy(() => "all", "rank_all"); rankBy(s => s.campus_id, "rank_campus"); rankBy(s => s.batch_id, "rank_batch");
  const max = layout.sections.reduce((a, s) => a + s.count * s.marks.correct, 0);
  return { scored, max, layout, keyCount: Object.keys(key).length };
}
app.get("/api/tests/:id/analysis", auth, admin, wrap(req => {
  const t = visibleTest(req.user, req.params.id);
  const { scored, max, layout, keyCount } = scoreTest(t);
  const scope = campusScope(req.user);
  const mine = scored.filter(s => scope === null || scope.includes(s.campus_id));
  const subjects = [...new Set(layout.sections.map(s => s.subject))];
  const group = (k, label) => {
    const g = {};
    for (const s of mine) { const id = s[k]; (g[id] = g[id] || []).push(s.total); }
    return Object.entries(g).map(([id, a]) => ({ id: Number(id), name: label(Number(id)), n: a.length,
      avg: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1), top: Math.max(...a) }));
  };
  const nameOf = (tbl, id) => q1(`SELECT name FROM ${tbl} WHERE id=?`, id)?.name || "?";
  const perQ = {};
  for (const s of mine) for (const d of s.detail) {
    if (d.result === "nokey") continue;
    const p = (perQ[d.q] = perQ[d.q] || { q: d.q, subject: d.subject, n: 0, right: 0, blank: 0 });
    p.n++; if (d.result === "correct" || d.result === "bonus") p.right++; if (d.result === "blank") p.blank++;
  }
  const expected = q1(`SELECT COUNT(*) AS n FROM users u JOIN test_batches tb ON tb.batch_id=u.batch_id
                       WHERE tb.test_id=? AND u.role='student' AND u.active=1 AND ${inList("u.campus_id", scope)}`, t.id).n;
  return {
    test: testRow(t), max, subjects, keyCount, total_questions: OMR.totalQ(layout), expected,
    students: mine.map(s => ({ student_id: s.student_id, roll: s.roll, name: s.name, batch_id: s.batch_id, campus_id: s.campus_id,
      zone_id: s.zone_id, total: s.total, subjects: s.subjects, correct: s.correct, partial: s.partial, wrong: s.wrong, blank: s.blank,
      rank_all: s.rank_all, rank_all_of: s.rank_all_of, rank_campus: s.rank_campus, rank_batch: s.rank_batch })),
    by_zone: req.user.role === "central" ? group("zone_id", id => nameOf("zones", id)) : [],
    by_campus: req.user.role !== "campus" ? group("campus_id", id => nameOf("campuses", id)) : [],
    by_batch: group("batch_id", id => nameOf("batches", id)),
    questions: Object.values(perQ).sort((a, b) => a.q - b.q),
  };
}));
app.get("/api/tests/:id/student/:sid", auth, admin, wrap(req => {
  const t = visibleTest(req.user, req.params.id);
  const st = q1("SELECT id, campus_id FROM users WHERE id=?", req.params.sid) || bad("Unknown student.");
  if (!canSeeCampus(req.user, st.campus_id)) forbid();
  return studentReport(t, st.id);
}));
function studentReport(t, studentId) {
  const { scored, max, layout } = scoreTest(t);
  const s = scored.find(x => x.student_id === studentId);
  if (!s) throw new HttpError(404, "No sheet read for this student yet.");
  const linked = Object.fromEntries(qa(`SELECT tq.qno, q.text, q.image, q.options, q.solution, q.chapter FROM test_questions tq JOIN questions q ON q.id=tq.question_id WHERE tq.test_id=?`, t.id)
    .map(r => [r.qno, { text: r.text, image: r.image, options: JSON.parse(r.options || "[]"), solution: r.solution, chapter: r.chapter }]));
  return { test: { id: t.id, code: t.code, name: t.name, test_date: t.test_date, sheet_title: layout.title }, max,
    subjects: [...new Set(layout.sections.map(x => x.subject))],
    subject_max: layout.sections.reduce((m, x) => ((m[x.subject] = (m[x.subject] || 0) + x.count * x.marks.correct), m), {}),
    total: s.total, by_subject: s.subjects, correct: s.correct, partial: s.partial, wrong: s.wrong, blank: s.blank,
    rank_all: s.rank_all, rank_all_of: s.rank_all_of, rank_campus: s.rank_campus, rank_campus_of: s.rank_campus_of,
    rank_batch: s.rank_batch, rank_batch_of: s.rank_batch_of,
    detail: s.detail.map(d => ({ ...d, question: linked[d.q] || null })) };
}

// ------------------------------------------------------------------ student side
app.get("/api/my/tests", auth, wrap(req => {
  if (req.user.role !== "student") forbid();
  return qa(`SELECT t.id, t.code, t.name, t.test_date, t.sheet FROM tests t JOIN results r ON r.test_id=t.id
             WHERE r.student_id=? AND t.published=1 ORDER BY t.test_date DESC, t.id DESC`, req.user.id).map(t => {
    const rep = studentReport(q1("SELECT * FROM tests WHERE id=?", t.id), req.user.id);
    return { ...t, total: rep.total, max: rep.max, rank_batch: rep.rank_batch, rank_batch_of: rep.rank_batch_of, by_subject: rep.by_subject };
  });
}));
app.get("/api/my/tests/:id", auth, wrap(req => {
  if (req.user.role !== "student") forbid();
  const t = q1("SELECT * FROM tests WHERE id=? AND published=1", req.params.id);
  if (!t || !q1("SELECT 1 FROM results WHERE test_id=? AND student_id=?", t.id, req.user.id)) throw new HttpError(404, "Result not published yet.");
  return studentReport(t, req.user.id);
}));

// ------------------------------------------------------------------ dashboard counts
app.get("/api/overview", auth, admin, wrap(req => {
  const scope = campusScope(req.user);
  return {
    zones: req.user.role === "central" ? q1("SELECT COUNT(*) AS n FROM zones").n : null,
    campuses: q1(`SELECT COUNT(*) AS n FROM campuses WHERE ${inList("id", scope)}`).n,
    batches: q1(`SELECT COUNT(*) AS n FROM batches WHERE ${inList("campus_id", scope)}`).n,
    students: q1(`SELECT COUNT(*) AS n FROM users WHERE role='student' AND active=1 AND ${inList("campus_id", scope)}`).n,
    questions: q1("SELECT COUNT(*) AS n FROM questions").n,
    tests: req.user.role === "central" ? q1("SELECT COUNT(*) AS n FROM tests").n
      : q1(`SELECT COUNT(DISTINCT tb.test_id) AS n FROM test_batches tb JOIN batches b ON b.id=tb.batch_id WHERE ${inList("b.campus_id", scope)}`).n,
  };
}));

app.use("/api", (req, res) => res.status(404).json({ error: "Not found." }));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.listen(PORT, () => console.log(`Test portal running on http://localhost:${PORT}`));
