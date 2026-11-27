/*
  Test Portal server
  - Node.js 22+, Express
  - Data: PostgreSQL when DATABASE_URL is set (e.g. free Neon database), otherwise a SQLite file in DATA_DIR
  - Roles: central (everything), zone (one zone), campus (one campus), student (own results)
  Run:  node server.js        (first run creates the central admin from ADMIN_USER / ADMIN_PASSWORD)
*/
"use strict";
const express = require("express");
const compression = require("compression");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { openDatabase } = require("./db");
const OMR = require("./public/vendor/omr_core.js");

const PORT = process.env.PORT || 3000;
let db, q1, qa, run, insert, tx, TEMP_STORAGE = false, DATA_DIR = null;

// ------------------------------------------------------------------ helpers
// Password hashes record their own cost, so older hashes (cost 16384) keep working.
const SCRYPT_N = 4096;
const scrypt = (pw, salt, N) => new Promise((res, rej) =>
  crypto.scrypt(String(pw), salt, 32, { N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k))));
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${SCRYPT_N}$${salt.toString("hex")}$${(await scrypt(pw, salt, SCRYPT_N)).toString("hex")}`;
}
async function checkPassword(pw, stored) {
  const p = String(stored).split("$");
  const [N, s, h] = p.length === 4 ? [Number(p[1]), p[2], p[3]] : [16384, p[1], p[2]];
  if (!s || !h || !(N > 0)) return false;
  const calc = await scrypt(pw, Buffer.from(s, "hex"), N);
  return crypto.timingSafeEqual(calc, Buffer.from(h, "hex"));
}
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = msg => { throw new HttpError(400, msg); };
const forbid = (msg = "You don't have access to this.") => { throw new HttpError(403, msg); };
const str = (v, max = 200) => String(v == null ? "" : v).trim().slice(0, max);

// ------------------------------------------------------------------ app
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(compression());
app.use(express.json({ limit: "25mb" }));
app.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Referrer-Policy", "same-origin");
  next();
});
// question figures never change once made (names are content hashes), so phones can keep them
app.use("/qimg", express.static(path.join(__dirname, "public", "qimg"), { maxAge: "30d", immutable: true }));
app.use(express.static(path.join(__dirname, "public"), {
  index: "index.html", maxAge: "1h",
  // the app-update file must always be checked fresh, so phones pick up new versions
  setHeaders: (res, file) => { if (/(sw\.js|index\.html|manifest\.webmanifest|[\\/]app\.js|style\.css)$/.test(file)) res.set("Cache-Control", "no-cache"); },
}));

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
async function auth(req, res, next) {
  try {
    const t = cookies(req).sid;
    const s = t && await q1("SELECT s.user_id, s.expires FROM sessions s WHERE s.token=?", t);
    if (!s || Number(s.expires) < Date.now()) return res.status(401).json({ error: "Please log in." });
    const u = await q1("SELECT id, username, role, name, zone_id, campus_id, batch_id, roll, active FROM users WHERE id=?", s.user_id);
    if (!u || !u.active) return res.status(401).json({ error: "Account is not active." });
    req.user = u;
    next();
  } catch (e) { console.error(e); res.status(503).json({ error: "The database is waking up or unreachable. Try again in a moment." }); }
}
const admin = (req, res, next) => (req.user.role === "student" ? res.status(403).json({ error: "Admins only." }) : next());
const central = (req, res, next) => (req.user.role !== "central" ? res.status(403).json({ error: "Central team only." }) : next());
const wrap = fn => async (req, res) => {
  try { const out = await fn(req, res); if (out !== undefined && !res.headersSent) res.json(out); }
  catch (e) {
    if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
    const m = String(e && e.message);
    if (/UNIQUE constraint failed: users.username/.test(m)) return res.status(400).json({ error: "That username is already taken." });
    if (/UNIQUE constraint failed: users.roll/.test(m)) return res.status(400).json({ error: "That roll number already belongs to another student." });
    if (/UNIQUE constraint failed: tests.code/.test(m)) return res.status(400).json({ error: "A test with that code already exists." });
    if (/UNIQUE constraint/.test(m)) return res.status(400).json({ error: "That name is already used here." });
    if (/FOREIGN KEY/.test(m)) return res.status(400).json({ error: "This is still in use, so it can't be removed." });
    console.error(e);
    res.status(500).json({ error: "Something went wrong on the server." });
  }
};

// scope: which campuses a user may see (null = all)
async function campusScope(u) {
  if (u.role === "central") return null;
  if (u.role === "zone") return (await qa("SELECT id FROM campuses WHERE zone_id=?", u.zone_id)).map(r => r.id);
  if (u.role === "campus") return [u.campus_id];
  return [];
}
const inScope = (scope, campusId) => scope === null || scope.includes(Number(campusId));
function inList(col, ids) { return ids === null ? "1=1" : ids.length ? `${col} IN (${ids.map(Number).join(",")})` : "0=1"; }

// ------------------------------------------------------------------ auth
// simple protection against password guessing: 10 failed tries per username+IP per 15 minutes
const failures = new Map();
app.post("/api/login", wrap(async (req, res) => {
  const { username, password } = req.body || {};
  const fk = `${String(username).toLowerCase()}|${req.ip}`, now = Date.now();
  const f = failures.get(fk);
  if (f && f.n >= 10 && now - f.t < 15 * 60e3) throw new HttpError(429, "Too many wrong tries. Wait 15 minutes and try again.");
  const u = await q1("SELECT * FROM users WHERE lower(username)=lower(?)", str(username, 80));
  if (!u || !u.active || !(await checkPassword(password || "", u.pass))) {
    const cur = f && now - f.t < 15 * 60e3 ? f : { n: 0, t: now };
    failures.set(fk, { n: cur.n + 1, t: cur.t });
    throw new HttpError(401, "Wrong username or password.");
  }
  failures.delete(fk);
  const token = crypto.randomBytes(32).toString("hex");
  const days = 14;
  await run("INSERT INTO sessions (token, user_id, expires) VALUES (?,?,?)", token, u.id, Date.now() + days * 864e5);
  await run("DELETE FROM sessions WHERE expires < ?", Date.now());
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  res.set("Set-Cookie", `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${days * 86400}${secure}`);
  return { ok: true };
}));
app.post("/api/logout", wrap(async (req, res) => {
  const t = cookies(req).sid;
  if (t) await run("DELETE FROM sessions WHERE token=?", t);
  res.set("Set-Cookie", "sid=; Path=/; Max-Age=0");
  return { ok: true };
}));
app.get("/api/me", auth, wrap(async req => {
  const u = req.user;
  const extra = {};
  if (u.zone_id) extra.zone = (await q1("SELECT name FROM zones WHERE id=?", u.zone_id))?.name;
  if (u.campus_id) extra.campus = (await q1("SELECT name FROM campuses WHERE id=?", u.campus_id))?.name;
  if (u.batch_id) extra.batch = await q1("SELECT name, level FROM batches WHERE id=?", u.batch_id);
  return { ...u, ...extra };
}));
app.post("/api/me/password", auth, wrap(async req => {
  const { current, next } = req.body || {};
  const u = await q1("SELECT pass FROM users WHERE id=?", req.user.id);
  if (!(await checkPassword(current || "", u.pass))) bad("Current password is wrong.");
  if (String(next || "").length < 6) bad("New password must be at least 6 characters.");
  await run("UPDATE users SET pass=? WHERE id=?", await hashPassword(next), req.user.id);
  return { ok: true };
}));

// ------------------------------------------------------------------ structure
app.get("/api/structure", auth, admin, wrap(async req => {
  const scope = await campusScope(req.user);
  const campuses = await qa(`SELECT c.id, c.name, c.zone_id, (SELECT COUNT(*) FROM users u WHERE u.campus_id=c.id AND u.role='student' AND u.active=1) AS students
                       FROM campuses c WHERE ${inList("c.id", scope)} ORDER BY c.name`);
  const zoneIds = [...new Set(campuses.map(c => c.zone_id))];
  const zones = req.user.role === "central" ? await qa("SELECT id, name FROM zones ORDER BY name")
    : await qa(`SELECT id, name FROM zones WHERE ${inList("id", req.user.role === "zone" ? [req.user.zone_id] : zoneIds)} ORDER BY name`);
  const batches = await qa(`SELECT b.id, b.name, b.level, b.year, b.campus_id,
                      (SELECT COUNT(*) FROM users u WHERE u.batch_id=b.id AND u.role='student' AND u.active=1) AS students
                      FROM batches b WHERE ${inList("b.campus_id", scope)} ORDER BY b.level, b.name`);
  return { zones, campuses, batches };
}));
app.post("/api/zones", auth, central, wrap(async req => ({ id: await insert("INSERT INTO zones (name) VALUES (?)", str(req.body.name, 80) || bad("Zone name is needed.")) })));
app.patch("/api/zones/:id", auth, central, wrap(async req => { await run("UPDATE zones SET name=? WHERE id=?", str(req.body.name, 80) || bad("Name is needed."), req.params.id); return { ok: true }; }));
app.delete("/api/zones/:id", auth, central, wrap(async req => { await run("DELETE FROM zones WHERE id=?", req.params.id); return { ok: true }; }));
app.post("/api/campuses", auth, central, wrap(async req => {
  if (!(await q1("SELECT id FROM zones WHERE id=?", req.body.zone_id))) bad("Choose a zone.");
  return { id: await insert("INSERT INTO campuses (zone_id, name) VALUES (?,?)", req.body.zone_id, str(req.body.name, 80) || bad("Campus name is needed.")) };
}));
app.patch("/api/campuses/:id", auth, central, wrap(async req => { await run("UPDATE campuses SET name=? WHERE id=?", str(req.body.name, 80) || bad("Name is needed."), req.params.id); return { ok: true }; }));
app.delete("/api/campuses/:id", auth, central, wrap(async req => { await run("DELETE FROM campuses WHERE id=?", req.params.id); return { ok: true }; }));
const LEVELS = ["11", "12", "Dropper"];
app.post("/api/batches", auth, central, wrap(async req => {
  if (!(await q1("SELECT id FROM campuses WHERE id=?", req.body.campus_id))) bad("Choose a campus.");
  const level = LEVELS.includes(req.body.level) ? req.body.level : bad("Choose 11, 12 or Dropper.");
  return { id: await insert("INSERT INTO batches (campus_id, name, level, year) VALUES (?,?,?,?)", req.body.campus_id, str(req.body.name, 60) || bad("Batch name is needed."), level, str(req.body.year, 20)) };
}));
app.patch("/api/batches/:id", auth, central, wrap(async req => {
  const level = LEVELS.includes(req.body.level) ? req.body.level : bad("Choose 11, 12 or Dropper.");
  await run("UPDATE batches SET name=?, level=?, year=? WHERE id=?", str(req.body.name, 60) || bad("Name is needed."), level, str(req.body.year, 20), req.params.id);
  return { ok: true };
}));
app.delete("/api/batches/:id", auth, central, wrap(async req => { await run("DELETE FROM batches WHERE id=?", req.params.id); return { ok: true }; }));

// ------------------------------------------------------------------ people
async function placeFor(batchId, campusId, zoneId) {
  if (batchId) {
    const b = (await q1("SELECT b.id, b.campus_id, c.zone_id FROM batches b JOIN campuses c ON c.id=b.campus_id WHERE b.id=?", batchId)) || bad("Unknown batch.");
    return { batch_id: b.id, campus_id: b.campus_id, zone_id: b.zone_id };
  }
  if (campusId) {
    const c = (await q1("SELECT id, zone_id FROM campuses WHERE id=?", campusId)) || bad("Unknown campus.");
    return { batch_id: null, campus_id: c.id, zone_id: c.zone_id };
  }
  if (zoneId) { (await q1("SELECT id FROM zones WHERE id=?", zoneId)) || bad("Unknown zone."); return { batch_id: null, campus_id: null, zone_id: Number(zoneId) }; }
  return { batch_id: null, campus_id: null, zone_id: null };
}
const cleanRoll = r => { const s = str(r, 20).replace(/\s/g, ""); if (s && !/^\d{1,8}$/.test(s)) bad(`Roll number "${s}" must be digits only (up to 8).`); return s || null; };
const cleanUser = u => { const s = str(u, 40); if (!/^[A-Za-z0-9._@-]{3,40}$/.test(s)) bad(`Username "${s}" must be 3-40 letters, digits, dot, dash or underscore.`); return s; };

app.get("/api/students", auth, admin, wrap(async req => {
  const scope = await campusScope(req.user);
  const where = [inList("u.campus_id", scope), "u.role='student'"];
  const args = [];
  if (req.query.batch) { where.push("u.batch_id=?"); args.push(Number(req.query.batch)); }
  if (req.query.campus) { where.push("u.campus_id=?"); args.push(Number(req.query.campus)); }
  if (req.query.zone) { where.push("u.zone_id=?"); args.push(Number(req.query.zone)); }
  if (req.query.q) { where.push("(u.name LIKE ? OR u.roll LIKE ? OR u.username LIKE ?)"); const like = `%${str(req.query.q, 40)}%`; args.push(like, like, like); }
  return qa(`SELECT u.id, u.username, u.name, u.roll, u.active, u.batch_id, u.campus_id, u.zone_id FROM users u
             WHERE ${where.join(" AND ")} ORDER BY u.roll, u.name LIMIT 5000`, ...args);
}));
app.post("/api/students", auth, central, wrap(async req => {
  const b = req.body || {};
  const place = await placeFor(b.batch_id || bad("Choose a batch."));
  const roll = cleanRoll(b.roll) || bad("Roll number is needed.");
  const username = b.username ? cleanUser(b.username) : roll;
  if (String(b.password || "").length < 6) bad("Password must be at least 6 characters.");
  return { id: await insert(`INSERT INTO users (username, pass, role, name, zone_id, campus_id, batch_id, roll) VALUES (?,?,?,?,?,?,?,?)`,
    username, await hashPassword(b.password), "student", str(b.name, 80), place.zone_id, place.campus_id, place.batch_id, roll) };
}));
// bulk import: rows of {roll, name, username?, password?, batch_id}. All rows are checked first; nothing is saved if any row is wrong.
app.post("/api/students/bulk", auth, central, wrap(async req => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows : bad("No rows.");
  if (rows.length > 10000) bad("At most 10,000 students at a time.");
  const existing = await qa("SELECT roll, lower(username) AS un FROM users");
  const takenRoll = new Set(existing.map(r => r.roll).filter(Boolean)), takenUser = new Set(existing.map(r => r.un));
  const places = new Map((await qa("SELECT b.id, b.campus_id, c.zone_id FROM batches b JOIN campuses c ON c.id=b.campus_id")).map(b => [b.id, b]));
  const errors = [], created = [];
  const seenRoll = new Set(), seenUser = new Set();
  rows.forEach((r, i) => {
    try {
      const roll = cleanRoll(r.roll) || bad("roll number missing");
      const username = r.username ? cleanUser(r.username) : roll;
      if (seenRoll.has(roll)) bad("roll number repeated in the file");
      if (seenUser.has(username.toLowerCase())) bad("username repeated in the file");
      seenRoll.add(roll); seenUser.add(username.toLowerCase());
      if (takenRoll.has(roll)) bad("roll number already exists");
      if (takenUser.has(username.toLowerCase())) bad("username already exists");
      const p = places.get(Number(r.batch_id)) || bad("batch not found");
      const pw = r.password ? String(r.password) : null;
      if (pw && pw.length < 6) bad("password shorter than 6 characters");
      created.push({ roll, username, name: str(r.name, 80), place: p, password: pw });
    } catch (e) { errors.push({ row: r.row || i + 2, error: e.message }); }
  });
  if (errors.length) return { ok: false, errors };
  const out = [], values = [];
  for (let i = 0; i < created.length; i += 16) {
    const chunk = created.slice(i, i + 16);
    const hashes = await Promise.all(chunk.map(c => {
      c.password = c.password || crypto.randomBytes(6).toString("base64").replace(/[^A-Za-z0-9]/g, "x").slice(0, 8);
      return hashPassword(c.password);
    }));
    chunk.forEach((c, k) => {
      values.push([c.username, hashes[k], "student", c.name, c.place.zone_id, c.place.campus_id, c.place.id, c.roll]);
      out.push({ roll: c.roll, name: c.name, username: c.username, password: c.password });
    });
  }
  await tx(async () => {
    for (let i = 0; i < values.length; i += 200) {
      const chunk = values.slice(i, i + 200);
      await run(`INSERT INTO users (username, pass, role, name, zone_id, campus_id, batch_id, roll) VALUES ${chunk.map(() => "(?,?,?,?,?,?,?,?)").join(",")}`, ...chunk.flat());
    }
  });
  return { ok: true, created: out };
}));
app.patch("/api/users/:id", auth, central, wrap(async req => {
  const u = (await q1("SELECT * FROM users WHERE id=?", req.params.id)) || bad("Unknown user.");
  const b = req.body || {};
  if (b.name !== undefined) await run("UPDATE users SET name=? WHERE id=?", str(b.name, 80), u.id);
  if (b.active !== undefined) {
    if (u.id === req.user.id) bad("You can't deactivate your own account.");
    await run("UPDATE users SET active=? WHERE id=?", b.active ? 1 : 0, u.id);
    if (!b.active) await run("DELETE FROM sessions WHERE user_id=?", u.id);
  }
  if (b.username !== undefined) await run("UPDATE users SET username=? WHERE id=?", cleanUser(b.username), u.id);
  if (u.role === "student") {
    if (b.roll !== undefined) await run("UPDATE users SET roll=? WHERE id=?", cleanRoll(b.roll) || bad("Roll number is needed."), u.id);
    if (b.batch_id !== undefined) { const p = await placeFor(b.batch_id); await run("UPDATE users SET batch_id=?, campus_id=?, zone_id=? WHERE id=?", p.batch_id, p.campus_id, p.zone_id, u.id); }
  }
  if (b.password !== undefined) {
    if (String(b.password).length < 6) bad("Password must be at least 6 characters.");
    await run("UPDATE users SET pass=? WHERE id=?", await hashPassword(b.password), u.id);
    await run("DELETE FROM sessions WHERE user_id=?", u.id);
  }
  return { ok: true };
}));
app.get("/api/admins", auth, central, wrap(() =>
  qa(`SELECT u.id, u.username, u.name, u.role, u.active, u.zone_id, u.campus_id FROM users u WHERE u.role IN ('central','zone','campus') ORDER BY u.role, u.name`)));
app.post("/api/admins", auth, central, wrap(async req => {
  const b = req.body || {};
  const role = ["central", "zone", "campus"].includes(b.role) ? b.role : bad("Choose a level.");
  if (String(b.password || "").length < 6) bad("Password must be at least 6 characters.");
  const place = role === "zone" ? await placeFor(null, null, b.zone_id || bad("Choose a zone.")) : role === "campus" ? await placeFor(null, b.campus_id || bad("Choose a campus.")) : await placeFor();
  return { id: await insert("INSERT INTO users (username, pass, role, name, zone_id, campus_id) VALUES (?,?,?,?,?,?)",
    cleanUser(b.username), await hashPassword(b.password), role, str(b.name, 80), place.zone_id, place.campus_id) };
}));

// ------------------------------------------------------------------ question bank
const QTYPES = ["single", "multi", "integer", "decimal"];
const QLEVELS = ["Easy", "Medium", "Difficult"];
// older names map onto the three levels
const LEVEL_MAP = { Basic: "Easy", Hard: "Difficult", "Very hard": "Difficult" };
const levelOf = v => (QLEVELS.includes(v) ? v : LEVEL_MAP[v] || "Medium");
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
  if (!str(b.text, 60000) && !image) bad("Add the question text or an image.");
  return {
    subject: str(b.subject, 40) || bad("Subject is needed."), chapter: str(b.chapter, 120), topic: str(b.topic, 120), qtype,
    difficulty: levelOf(b.difficulty), exam: str(b.exam, 40),
    text: str(b.text, 60000), image, options: JSON.stringify(options), answer, solution: str(b.solution, 60000),
    fmt: b.fmt === "html" ? "html" : "", source: str(b.source, 120),
  };
}
// filters: each of these may hold several values separated by "|" (e.g. chapter=Optics|Waves)
function questionFilter(qy) {
  const where = ["1=1"], args = [];
  const many = (k, col = k, num = false) => {
    const vals = String(qy[k] || "").split("|").map(v => v.trim()).filter(Boolean).slice(0, 200);
    if (!vals.length) return;
    where.push(`${col} IN (${vals.map(() => "?").join(",")})`);
    args.push(...vals.map(v => (num ? Number(v) || 0 : str(v, 120))));
  };
  many("subject"); many("chapter"); many("qtype"); many("difficulty"); many("exam"); many("year", "year", true);
  if (qy.pyq === "1") where.push("source != ''");
  if (qy.pyq === "0") where.push("(source = '' OR source IS NULL)");
  if (qy.q) { where.push("(text LIKE ? OR topic LIKE ? OR chapter LIKE ? OR source LIKE ?)"); const l = `%${str(qy.q, 60)}%`; args.push(l, l, l, l); }
  return { w: where.join(" AND "), args };
}
app.get("/api/questions", auth, admin, wrap(async req => {
  const { w, args } = questionFilter(req.query);
  const limit = 100, offset = Math.max(0, Number(req.query.offset) || 0);
  const rows = await qa(`SELECT id, subject, chapter, topic, qtype, difficulty, substr(text,1,400) AS text, CASE WHEN image != '' THEN 1 ELSE 0 END AS has_image, answer, fmt, source, year, exam
                   FROM questions WHERE ${w} ORDER BY subject, chapter, year DESC, id LIMIT ${limit} OFFSET ${offset}`, ...args);
  const facets = { subjects: (await qa("SELECT DISTINCT subject FROM questions ORDER BY subject")).map(r => r.subject),
                   chapters: await qa("SELECT DISTINCT subject, chapter FROM questions WHERE chapter != '' ORDER BY chapter"),
                   years: (await qa("SELECT DISTINCT year FROM questions WHERE year IS NOT NULL ORDER BY year DESC")).map(r => r.year),
                   exams: (await qa("SELECT DISTINCT exam FROM questions WHERE exam != '' ORDER BY exam")).map(r => r.exam), levels: QLEVELS };
  return { rows, facets, offset, limit, matching: (await q1(`SELECT COUNT(*) AS n FROM questions WHERE ${w}`, ...args)).n, total: (await q1("SELECT COUNT(*) AS n FROM questions")).n };
}));
// change level (or exam) for many questions at once: either the ticked ids, or everything matching the filters
app.post("/api/questions/bulk", auth, central, wrap(async req => {
  const set = req.body.set || {}, cols = [], vals = [];
  if (set.difficulty != null) { QLEVELS.includes(set.difficulty) || bad("Unknown level."); cols.push("difficulty=?"); vals.push(set.difficulty); }
  if (set.exam != null) { cols.push("exam=?"); vals.push(str(set.exam, 40)); }
  if (!cols.length) bad("Nothing to change.");
  if (Array.isArray(req.body.ids)) {
    const ids = req.body.ids.map(Number).filter(Boolean).slice(0, 5000);
    if (!ids.length) bad("Tick some questions first.");
    let changes = 0;
    await tx(async () => { for (let i = 0; i < ids.length; i += 500) { const part = ids.slice(i, i + 500);
      changes += (await run(`UPDATE questions SET ${cols.join(", ")} WHERE id IN (${part.map(() => "?").join(",")})`, ...vals, ...part)).changes; } });
    return { changed: changes };
  }
  const { w, args } = questionFilter(req.body.filter || {});
  if (w === "1=1") bad("Choose a filter first, so the whole bank isn't changed by mistake.");
  return { changed: (await run(`UPDATE questions SET ${cols.join(", ")} WHERE ${w}`, ...vals, ...args)).changes };
}));
app.get("/api/questions/:id", auth, admin, wrap(async req => {
  const q = await q1("SELECT * FROM questions WHERE id=?", req.params.id);
  if (!q) throw new HttpError(404, "Not found");
  q.options = JSON.parse(q.options || "[]");
  return q;
}));
app.post("/api/questions", auth, central, wrap(async req => {
  const q = cleanQuestion(req.body || {});
  return { id: await insert(`INSERT INTO questions (subject, chapter, topic, qtype, difficulty, text, image, options, answer, solution, created_by, fmt, source, exam)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, q.subject, q.chapter, q.topic, q.qtype, q.difficulty, q.text, q.image, q.options, q.answer, q.solution, req.user.id, q.fmt, q.source, q.exam) };
}));
app.put("/api/questions/:id", auth, central, wrap(async req => {
  const q = cleanQuestion(req.body || {});
  await run(`UPDATE questions SET subject=?, chapter=?, topic=?, qtype=?, difficulty=?, text=?, image=?, options=?, answer=?, solution=?, fmt=?, source=?, exam=? WHERE id=?`,
    q.subject, q.chapter, q.topic, q.qtype, q.difficulty, q.text, q.image, q.options, q.answer, q.solution, q.fmt, q.source, q.exam, req.params.id);
  return { ok: true };
}));
app.delete("/api/questions/:id", auth, central, wrap(async req => {
  if (await q1("SELECT 1 AS x FROM test_questions WHERE question_id=?", req.params.id)) bad("This question is used in a test, so it can't be deleted.");
  await run("DELETE FROM questions WHERE id=?", req.params.id); return { ok: true };
}));

// ------------------------------------------------------------------ ready-made question sets shipped with the app (bank/*.json.gz)
const PACKS = {
  "jee-main-pyq-physics": { prefix: "jmp:", exam: "JEE Main", file: "jee-main-pyq-physics.json.gz", name: "JEE Main previous-year questions · Physics",
    note: "AIEEE 2002 to JEE Main 2026, chapter-wise, with solutions and figures." },
};
const packData = id => JSON.parse(require("zlib").gunzipSync(fs.readFileSync(path.join(__dirname, "bank", PACKS[id].file))).toString("utf8"));
app.get("/api/packs", auth, central, wrap(async () => {
  const out = [];
  for (const [id, p] of Object.entries(PACKS)) {
    let count = 0; try { count = packData(id).questions.length; } catch (e) { continue; }
    out.push({ id, name: p.name, note: p.note, count, loaded: (await q1("SELECT COUNT(*) AS n FROM questions WHERE ref LIKE ?", p.prefix + "%")).n });
  }
  return out;
}));
app.post("/api/packs/:id/load", auth, central, wrap(async req => {
  const p = PACKS[req.params.id] || bad("Unknown question set.");
  const have = new Set((await qa("SELECT ref FROM questions WHERE ref LIKE ?", p.prefix + "%")).map(r => r.ref));
  const todo = packData(req.params.id).questions.filter(q => !have.has(p.prefix + q.ref) && QTYPES.includes(q.qtype));
  const COLS = ["subject", "chapter", "topic", "qtype", "difficulty", "text", "image", "options", "answer", "solution", "created_by", "fmt", "source", "ref", "year", "exam"];
  await tx(async () => {
    for (let i = 0; i < todo.length; i += 150) {
      const chunk = todo.slice(i, i + 150), args = [];
      for (const q of chunk) args.push(q.subject, q.chapter, q.topic || "", q.qtype, levelOf(q.difficulty), q.text, "", "[]", q.answer, q.solution || "", req.user.id, "html", q.source || "", p.prefix + q.ref, q.year || null, q.exam || p.exam);
      await run(`INSERT INTO questions (${COLS.join(", ")}) VALUES ${chunk.map(() => "(" + COLS.map(() => "?").join(",") + ")").join(",")}`, ...args);
    }
    // questions added before the Exam field existed get it now
    await run("UPDATE questions SET exam=? WHERE ref LIKE ? AND (exam = '' OR exam IS NULL)", p.exam, p.prefix + "%");
  });
  return { added: todo.length, total: have.size + todo.length };
}));

// ------------------------------------------------------------------ tests
const layoutOf = t => OMR.getLayout(t.sheet) || bad("Unknown sheet type.");
async function testRow(t) {
  const layout = OMR.getLayout(t.sheet);
  return { ...t, answer_key: JSON.parse(t.answer_key || "{}"), sheet_title: layout ? layout.title : t.sheet, questions: layout ? OMR.totalQ(layout) : 0,
           batch_ids: (await qa("SELECT batch_id FROM test_batches WHERE test_id=?", t.id)).map(r => r.batch_id) };
}
async function visibleTest(u, id) {
  const t = await q1("SELECT * FROM tests WHERE id=?", Number(id));
  if (!t) throw new HttpError(404, "Test not found.");
  if (u.role === "central") return t;
  const scope = await campusScope(u);
  const ok = await q1(`SELECT 1 AS x FROM test_batches tb JOIN batches b ON b.id=tb.batch_id WHERE tb.test_id=? AND ${inList("b.campus_id", scope)} LIMIT 1`, t.id);
  if (!ok) forbid();
  return t;
}
app.get("/api/tests", auth, admin, wrap(async req => {
  const scope = await campusScope(req.user);
  const rows = req.user.role === "central" ? await qa("SELECT * FROM tests ORDER BY test_date DESC, id DESC")
    : await qa(`SELECT DISTINCT t.* FROM tests t JOIN test_batches tb ON tb.test_id=t.id JOIN batches b ON b.id=tb.batch_id
          WHERE ${inList("b.campus_id", scope)} ORDER BY t.test_date DESC, t.id DESC`);
  const out = [];
  for (const t of rows) {
    const r = await testRow(t);
    r.result_count = (await q1(`SELECT COUNT(*) AS n FROM results r JOIN users u ON u.id=r.student_id WHERE r.test_id=? AND ${inList("u.campus_id", scope)}`, t.id)).n;
    r.student_count = (await q1(`SELECT COUNT(*) AS n FROM users u JOIN test_batches tb ON tb.batch_id=u.batch_id WHERE tb.test_id=? AND u.role='student' AND u.active=1 AND ${inList("u.campus_id", scope)}`, t.id)).n;
    out.push(r);
  }
  return out;
}));
async function saveTest(req, id) {
  const b = req.body || {};
  const sheet = OMR.PRESETS[b.sheet] ? b.sheet : bad("Choose an OMR sheet type.");
  const code = str(b.code, 16).replace(/[^A-Za-z0-9_-]/g, "") || bad("Test code is needed (letters, digits, - or _).");
  const name = str(b.name, 100) || bad("Test name is needed.");
  const known = new Set((await qa("SELECT id FROM batches")).map(r => r.id));
  const batchIds = [...new Set((Array.isArray(b.batch_ids) ? b.batch_ids : []).map(Number))].filter(n => known.has(n));
  if (!batchIds.length) bad("Choose at least one batch.");
  return tx(async () => {
    if (id) {
      const t = (await q1("SELECT * FROM tests WHERE id=?", id)) || bad("Unknown test.");
      if (t.sheet !== sheet && await q1("SELECT 1 AS x FROM results WHERE test_id=? LIMIT 1", id)) bad("Sheets are already read for this test, so its sheet type can't change.");
      await run("UPDATE tests SET code=?, name=?, test_date=?, sheet=? WHERE id=?", code, name, str(b.test_date, 20), sheet, id);
    } else {
      id = await insert("INSERT INTO tests (code, name, test_date, sheet, created_by) VALUES (?,?,?,?,?)", code, name, str(b.test_date, 20), sheet, req.user.id);
    }
    await run("DELETE FROM test_batches WHERE test_id=?", id);
    for (const bid of batchIds) await run("INSERT INTO test_batches (test_id, batch_id) VALUES (?,?)", id, bid);
    return { id };
  });
}
app.post("/api/tests", auth, central, wrap(req => saveTest(req, null)));
app.put("/api/tests/:id", auth, central, wrap(req => saveTest(req, Number(req.params.id))));
app.delete("/api/tests/:id", auth, central, wrap(async req => { await run("DELETE FROM tests WHERE id=?", req.params.id); return { ok: true }; }));
app.get("/api/tests/:id", auth, admin, wrap(async req => {
  const t = await testRow(await visibleTest(req.user, req.params.id));
  t.layout = OMR.getLayout(t.sheet);
  t.linked = await qa(`SELECT tq.qno, q.id, q.subject, q.chapter, q.qtype, substr(q.text,1,160) AS text, q.answer, q.fmt FROM test_questions tq
                 JOIN questions q ON q.id=tq.question_id WHERE tq.test_id=? ORDER BY tq.qno`, t.id);
  return t;
}));
// answer key: {qno: answer}; can also pull answers from linked bank questions
app.put("/api/tests/:id/key", auth, central, wrap(async req => {
  const t = await visibleTest(req.user, req.params.id);
  const layout = layoutOf(t), n = OMR.totalQ(layout);
  const key = {};
  for (const [k, v] of Object.entries(req.body.key || {})) {
    const q = Number(k), a = str(v, 30).toUpperCase().replace(/[\s,]/g, "");
    if (q >= 1 && q <= n && a) key[q] = a;
  }
  await run("UPDATE tests SET answer_key=? WHERE id=?", JSON.stringify(key), t.id);
  return { ok: true, count: Object.keys(key).length };
}));
app.put("/api/tests/:id/questions", auth, central, wrap(async req => {
  const t = await visibleTest(req.user, req.params.id);
  const layout = layoutOf(t), idx = OMR.questionIndex(layout);
  const links = req.body.links || {}; // {qno: question_id}
  return tx(async () => {
    await run("DELETE FROM test_questions WHERE test_id=?", t.id);
    const key = JSON.parse(t.answer_key || "{}");
    for (const [k, v] of Object.entries(links)) {
      const qno = Number(k), qid = Number(v);
      const slot = idx.find(x => x.qno === qno);
      const q = await q1("SELECT id, qtype, answer FROM questions WHERE id=?", qid);
      if (!slot || !q) continue;
      const wantNum = slot.sec.qtype === "integer" || slot.sec.qtype === "decimal", isNum = q.qtype === "integer" || q.qtype === "decimal";
      if (wantNum !== isNum) bad(`Q${qno} needs a ${wantNum ? "numerical" : "multiple-choice"} question.`);
      await run("INSERT INTO test_questions (test_id, qno, question_id) VALUES (?,?,?)", t.id, qno, qid);
      key[qno] = slot.sec.options === "1234" && /^[A-D]$/.test(q.answer) ? String("ABCD".indexOf(q.answer) + 1) : q.answer;
    }
    await run("UPDATE tests SET answer_key=? WHERE id=?", JSON.stringify(key), t.id);
    return { ok: true };
  });
}));
app.post("/api/tests/:id/publish", auth, central, wrap(async req => {
  const t = await visibleTest(req.user, req.params.id);
  await run("UPDATE tests SET published=? WHERE id=?", req.body.published ? 1 : 0, t.id);
  return { ok: true };
}));
// students who sit this test (for printing personalised sheets), limited to the admin's campuses
app.get("/api/tests/:id/roster", auth, admin, wrap(async req => {
  const t = await visibleTest(req.user, req.params.id);
  const scope = await campusScope(req.user);
  return qa(`SELECT u.id, u.roll, u.name, u.batch_id, u.campus_id FROM users u JOIN test_batches tb ON tb.batch_id=u.batch_id
             WHERE tb.test_id=? AND u.role='student' AND u.active=1 AND ${inList("u.campus_id", scope)} ORDER BY u.roll`, t.id);
}));
// save answers read from OMR scans (the browser reads the sheets; the server checks and stores)
app.post("/api/tests/:id/results", auth, admin, wrap(async req => {
  const t = await visibleTest(req.user, req.params.id);
  const layout = layoutOf(t), n = OMR.totalQ(layout);
  const rows = Array.isArray(req.body.rows) ? req.body.rows : bad("No sheets sent.");
  const scope = await campusScope(req.user);
  const roster = new Map((await qa(`SELECT u.id, u.roll, u.campus_id FROM users u JOIN test_batches tb ON tb.batch_id=u.batch_id
                                    WHERE tb.test_id=? AND u.role='student'`, t.id)).map(s => [String(s.roll).replace(/^0+/, ""), s]));
  const saved = [], rejected = [];
  await tx(async () => {
    for (const r of rows) {
      const st = roster.get(str(r.roll, 20).replace(/^0+/, ""));
      if (!st) { rejected.push({ roll: r.roll, error: "No student with this roll number in this test's batches." }); continue; }
      if (!inScope(scope, st.campus_id)) { rejected.push({ roll: r.roll, error: "This student belongs to another campus." }); continue; }
      const answers = {};
      for (const [k, v] of Object.entries(r.answers || {})) { const q = Number(k); if (q >= 1 && q <= n) answers[q] = str(v, 12); }
      await run(`INSERT INTO results (test_id, student_id, answers, source, uploaded_by) VALUES (?,?,?,?,?)
           ON CONFLICT(test_id, student_id) DO UPDATE SET answers=excluded.answers, source=excluded.source, uploaded_by=excluded.uploaded_by, uploaded_at=datetime('now')`,
        t.id, st.id, JSON.stringify(answers), str(r.source, 200), req.user.id);
      saved.push(r.roll);
    }
  });
  return { saved: saved.length, rejected };
}));

// marks for every result of a test, scored now from the stored key (so key changes re-score instantly)
async function scoreTest(t) {
  const layout = layoutOf(t);
  const key = JSON.parse(t.answer_key || "{}");
  const rows = await qa(`SELECT r.student_id, r.answers, r.uploaded_at, u.roll, u.name, u.batch_id, u.campus_id, u.zone_id
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
app.get("/api/tests/:id/analysis", auth, admin, wrap(async req => {
  const t = await visibleTest(req.user, req.params.id);
  const { scored, max, layout, keyCount } = await scoreTest(t);
  const scope = await campusScope(req.user);
  const mine = scored.filter(s => inScope(scope, s.campus_id));
  const subjects = [...new Set(layout.sections.map(s => s.subject))];
  const names = {};
  for (const tbl of ["zones", "campuses", "batches"]) names[tbl] = new Map((await qa(`SELECT id, name FROM ${tbl}`)).map(r => [r.id, r.name]));
  const group = (k, tbl) => {
    const g = {};
    for (const s of mine) { const id = s[k]; (g[id] = g[id] || []).push(s.total); }
    return Object.entries(g).map(([id, a]) => ({ id: Number(id), name: names[tbl].get(Number(id)) || "?", n: a.length,
      avg: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1), top: Math.max(...a) }));
  };
  const perQ = {};
  for (const s of mine) for (const d of s.detail) {
    if (d.result === "nokey") continue;
    const p = (perQ[d.q] = perQ[d.q] || { q: d.q, subject: d.subject, n: 0, right: 0, blank: 0 });
    p.n++; if (d.result === "correct" || d.result === "bonus") p.right++; if (d.result === "blank") p.blank++;
  }
  const expected = (await q1(`SELECT COUNT(*) AS n FROM users u JOIN test_batches tb ON tb.batch_id=u.batch_id
                       WHERE tb.test_id=? AND u.role='student' AND u.active=1 AND ${inList("u.campus_id", scope)}`, t.id)).n;
  return {
    test: await testRow(t), max, subjects, keyCount, total_questions: OMR.totalQ(layout), expected,
    students: mine.map(s => ({ student_id: s.student_id, roll: s.roll, name: s.name, batch_id: s.batch_id, campus_id: s.campus_id,
      zone_id: s.zone_id, total: s.total, subjects: s.subjects, correct: s.correct, partial: s.partial, wrong: s.wrong, blank: s.blank,
      rank_all: s.rank_all, rank_all_of: s.rank_all_of, rank_campus: s.rank_campus, rank_batch: s.rank_batch })),
    by_zone: req.user.role === "central" ? group("zone_id", "zones") : [],
    by_campus: req.user.role !== "campus" ? group("campus_id", "campuses") : [],
    by_batch: group("batch_id", "batches"),
    questions: Object.values(perQ).sort((a, b) => a.q - b.q),
  };
}));
app.get("/api/tests/:id/student/:sid", auth, admin, wrap(async req => {
  const t = await visibleTest(req.user, req.params.id);
  const st = (await q1("SELECT id, campus_id FROM users WHERE id=?", Number(req.params.sid))) || bad("Unknown student.");
  if (!inScope(await campusScope(req.user), st.campus_id)) forbid();
  return studentReport(t, st.id);
}));
async function studentReport(t, studentId) {
  const { scored, max, layout } = await scoreTest(t);
  const s = scored.find(x => x.student_id === studentId);
  if (!s) throw new HttpError(404, "No sheet read for this student yet.");
  const linked = Object.fromEntries((await qa(`SELECT tq.qno, q.text, q.image, q.options, q.solution, q.chapter, q.fmt, q.source FROM test_questions tq JOIN questions q ON q.id=tq.question_id WHERE tq.test_id=?`, t.id))
    .map(r => [r.qno, { text: r.text, image: r.image, options: JSON.parse(r.options || "[]"), solution: r.solution, chapter: r.chapter, fmt: r.fmt, source: r.source }]));
  return { test: { id: t.id, code: t.code, name: t.name, test_date: t.test_date, sheet_title: layout.title }, max,
    subjects: [...new Set(layout.sections.map(x => x.subject))],
    subject_max: layout.sections.reduce((m, x) => ((m[x.subject] = (m[x.subject] || 0) + x.count * x.marks.correct), m), {}),
    total: s.total, by_subject: s.subjects, correct: s.correct, partial: s.partial, wrong: s.wrong, blank: s.blank,
    rank_all: s.rank_all, rank_all_of: s.rank_all_of, rank_campus: s.rank_campus, rank_campus_of: s.rank_campus_of,
    rank_batch: s.rank_batch, rank_batch_of: s.rank_batch_of,
    detail: s.detail.map(d => ({ ...d, question: linked[d.q] || null })) };
}

// ------------------------------------------------------------------ student side
app.get("/api/my/tests", auth, wrap(async req => {
  if (req.user.role !== "student") forbid();
  const tests = await qa(`SELECT t.* FROM tests t JOIN results r ON r.test_id=t.id
             WHERE r.student_id=? AND t.published=1 ORDER BY t.test_date DESC, t.id DESC`, req.user.id);
  const out = [];
  for (const t of tests) {
    const rep = await studentReport(t, req.user.id);
    out.push({ id: t.id, code: t.code, name: t.name, test_date: t.test_date, sheet: t.sheet, total: rep.total, max: rep.max,
      rank_batch: rep.rank_batch, rank_batch_of: rep.rank_batch_of, by_subject: rep.by_subject, subject_max: rep.subject_max });
  }
  return out;
}));
app.get("/api/my/tests/:id", auth, wrap(async req => {
  if (req.user.role !== "student") forbid();
  const t = await q1("SELECT * FROM tests WHERE id=? AND published=1", Number(req.params.id));
  if (!t || !(await q1("SELECT 1 AS x FROM results WHERE test_id=? AND student_id=?", t.id, req.user.id))) throw new HttpError(404, "Result not published yet.");
  return studentReport(t, req.user.id);
}));

// ------------------------------------------------------------------ health, backup, dashboard counts
app.get("/api/health", (req, res) => res.json({ ok: true }));
// Central team: download a complete copy of all data
app.get("/api/backup", auth, central, wrap(async (req, res) => {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13);
  if (db.kind === "sqlite") {
    const tmp = path.join(DATA_DIR, `backup-${crypto.randomBytes(6).toString("hex")}.db`);
    db.backupTo(tmp);
    res.download(tmp, `portal-backup-${stamp}.db`, () => fs.rm(tmp, { force: true }, () => {}));
    return;
  }
  res.set("Content-Disposition", `attachment; filename="portal-backup-${stamp}.json"`);
  res.type("application/json").send(JSON.stringify({ format: "test-portal-backup", version: 1, made_at: new Date().toISOString(), tables: await db.dump() }));
}));
app.get("/api/overview", auth, admin, wrap(async req => {
  const scope = await campusScope(req.user);
  const n = async (sql, ...a) => (await q1(sql, ...a)).n;
  return {
    temporary_storage: req.user.role === "central" && TEMP_STORAGE,
    zones: req.user.role === "central" ? await n("SELECT COUNT(*) AS n FROM zones") : null,
    campuses: await n(`SELECT COUNT(*) AS n FROM campuses WHERE ${inList("id", scope)}`),
    batches: await n(`SELECT COUNT(*) AS n FROM batches WHERE ${inList("campus_id", scope)}`),
    students: await n(`SELECT COUNT(*) AS n FROM users WHERE role='student' AND active=1 AND ${inList("campus_id", scope)}`),
    questions: await n("SELECT COUNT(*) AS n FROM questions"),
    tests: req.user.role === "central" ? await n("SELECT COUNT(*) AS n FROM tests")
      : await n(`SELECT COUNT(DISTINCT tb.test_id) AS n FROM test_batches tb JOIN batches b ON b.id=tb.batch_id WHERE ${inList("b.campus_id", scope)}`),
  };
}));

app.use("/api", (req, res) => res.status(404).json({ error: "Not found." }));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ------------------------------------------------------------------ start
(async () => {
  const opened = await openDatabase(process.env, __dirname);
  db = opened.db; DATA_DIR = opened.dataDir; TEMP_STORAGE = opened.temporary;
  ({ q1, qa, run, insert, tx } = db);
  // questions saved with the old level names move to Easy / Medium / Difficult
  for (const [from, to] of Object.entries(LEVEL_MAP)) await run("UPDATE questions SET difficulty=? WHERE difficulty=?", to, from);
  console.log(`Data is stored in ${db.kind === "postgres" ? "PostgreSQL (DATABASE_URL)" : db.file}`);
  if (!(await q1("SELECT id FROM users WHERE role='central' LIMIT 1"))) {
    const u = process.env.ADMIN_USER || "admin";
    const p = process.env.ADMIN_PASSWORD || "change-me-now";
    await insert("INSERT INTO users (username, pass, role, name) VALUES (?,?,?,?)", u, await hashPassword(p), "central", "Central admin");
    console.log(`Created central admin "${u}". Log in and change the password.`);
  }
  app.listen(PORT, () => console.log(`Test portal running on http://localhost:${PORT}`));
})().catch(e => { console.error("Could not start:", e.message); process.exit(1); });
