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
// pictures added in the portal (imported papers) live in the database, so backups include them
app.get("/qimg/:f", async (req, res, next) => {
  const m = /^([0-9a-f]{16,40})\.(webp|jpg|png)$/.exec(req.params.f);
  if (!m || !q1) return next();
  try {
    const r = await q1("SELECT type, data FROM images WHERE id=?", m[1]);
    if (!r) return res.status(404).end();
    res.set("Cache-Control", "public, max-age=2592000, immutable").type(r.type).send(Buffer.from(r.data, "base64"));
  } catch (e) { next(e); }
});
const IMG_EXT = { "image/webp": "webp", "image/jpeg": "jpg", "image/png": "png" };
async function saveImage(dataUrl) {
  const m = /^data:(image\/(?:webp|jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!m) bad("A picture could not be read.");
  if (m[2].length > 4e6) bad("A picture is too large.");
  const id = crypto.createHash("sha1").update(m[2]).digest("hex").slice(0, 24);
  await run("INSERT INTO images (id, type, data) VALUES (?,?,?) ON CONFLICT(id) DO NOTHING", id, m[1], m[2]);
  return `/qimg/${id}.${IMG_EXT[m[1]]}`;
}
app.use(express.static(path.join(__dirname, "public"), {
  index: "index.html", maxAge: "1h",
  // the app-update file must always be checked fresh, so phones pick up new versions
  setHeaders: (res, file) => { if (/(sw\.js|index\.html|manifest\.webmanifest|[\\/]app\.js|[\\/]exam\.js|style\.css|import\.js|sheet_render\.js|omr_core\.js)$/.test(file)) res.set("Cache-Control", "no-cache"); },
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
    fmt: b.fmt === "html" ? "html" : "", source: str(b.source, 120), bank: BANKS.includes(b.bank) ? b.bank : "portal",
    qstyle: ["paragraph", "matrix"].includes(b.qstyle) ? b.qstyle : "",
  };
}
// three banks: JEE Main and JEE Advanced (ready-made sets, past-year and practice) and the Portal bank (papers imported from PDF, questions added here)
const BANKS = ["main", "adv", "eapcet", "neet", "portal"];
async function sortBanks() {
  // questions tagged with an exam go to that exam's bank; imported papers and own questions go to the Portal bank; the rest to JEE Main
  await run("UPDATE questions SET bank='adv' WHERE COALESCE(bank,'')='' AND lower(COALESCE(exam,'')) LIKE '%adv%'");
  await run("UPDATE questions SET bank='neet' WHERE COALESCE(bank,'')='' AND lower(COALESCE(exam,'')) LIKE '%neet%'");
  await run("UPDATE questions SET bank='eapcet' WHERE COALESCE(bank,'')='' AND (lower(COALESCE(exam,'')) LIKE '%eapcet%' OR lower(COALESCE(exam,'')) LIKE '%eamcet%')");
  await run("UPDATE questions SET bank='portal' WHERE COALESCE(bank,'')='' AND (ref LIKE 'imp:%' OR COALESCE(ref,'')='')");
  await run("UPDATE questions SET bank='main' WHERE COALESCE(bank,'')=''");
}
// filters: each of these may hold several values separated by "|" (e.g. chapter=Optics|Waves)
function questionFilter(qy) {
  const where = ["1=1"], args = [];
  if (BANKS.includes(qy.bank)) { where.push("bank=?"); args.push(qy.bank); }
  if (["paragraph", "matrix"].includes(qy.qstyle)) { where.push("qstyle=?"); args.push(qy.qstyle); }
  const many = (k, col = k, num = false) => {
    const vals = String(qy[k] || "").split("|").map(v => v.trim()).filter(Boolean).slice(0, 200);
    if (!vals.length) return;
    where.push(`${col} IN (${vals.map(() => "?").join(",")})`);
    args.push(...vals.map(v => (num ? Number(v) || 0 : col.startsWith("lower(") ? str(v, 120).toLowerCase() : str(v, 120))));
  };
  if (qy.hidden !== "1") where.push("COALESCE(hidden,0)=0");
  if (qy.chapter === "__none") { where.push("COALESCE(chapter,'')=''"); qy = { ...qy, chapter: "" }; }
  if (qy.paper) { where.push("source=? AND ref LIKE 'imp:%'"); args.push(str(qy.paper, 60)); }
  many("subject", "lower(subject)"); many("chapter"); many("qtype"); many("difficulty"); many("exam"); many("year", "year", true);
  const ex = String(qy.exclude || "").split(",").map(Number).filter(Boolean).slice(0, 500);
  if (ex.length) { where.push(`id NOT IN (${ex.map(() => "?").join(",")})`); args.push(...ex); }
  if (qy.pyq === "1") where.push("(year IS NOT NULL OR COALESCE(exam,'') != '')");
  if (qy.pyq === "0") where.push("(year IS NULL AND COALESCE(exam,'') = '')");
  if (qy.q) { where.push("(text LIKE ? OR topic LIKE ? OR chapter LIKE ? OR source LIKE ?)"); const l = `%${str(qy.q, 60)}%`; args.push(l, l, l, l); }
  return { w: where.join(" AND "), args };
}
app.get("/api/questions", auth, admin, wrap(async req => {
  const { w, args } = questionFilter(req.query);
  const full = req.query.full === "1";
  const limit = Math.min(Math.max(1, Number(req.query.limit) || 100), full ? 50 : 300), offset = Math.max(0, Number(req.query.offset) || 0);
  const cols = full ? "text, solution, image, options" : "substr(text,1,400) AS text, CASE WHEN image != '' THEN 1 ELSE 0 END AS has_image";
  const rows = await qa(`SELECT id, subject, chapter, topic, qtype, qstyle, difficulty, ${cols}, answer, fmt, source, year, exam
                   FROM questions WHERE ${w} ORDER BY ${req.query.order === "random" ? "RANDOM()" : "subject, chapter, year DESC, id"} LIMIT ${limit} OFFSET ${offset}`, ...args);
  if (full) rows.forEach(r => (r.options = JSON.parse(r.options || "[]")));
  // lists for the filters, limited to the chosen bank (and past-year / practice) so every choice has questions behind it
  const bw = ["COALESCE(hidden,0)=0"], ba = [];
  if (BANKS.includes(req.query.bank)) { bw.push("bank=?"); ba.push(req.query.bank); }
  if (req.query.pyq === "1") bw.push("(year IS NOT NULL OR COALESCE(exam,'') != '')");
  if (req.query.pyq === "0") bw.push("(year IS NULL AND COALESCE(exam,'') = '')");
  const B = bw.join(" AND ");
  const facets = { subjects: (await qa(`SELECT subject, COUNT(*) AS n FROM questions WHERE ${B} GROUP BY subject ORDER BY subject`, ...ba)).map(r => r.subject),
                   subject_counts: Object.fromEntries((await qa(`SELECT subject, COUNT(*) AS n FROM questions WHERE ${B} GROUP BY subject`, ...ba)).map(r => [r.subject, Number(r.n)])),
                   chapters: await qa(`SELECT subject, chapter, COUNT(*) AS n FROM questions WHERE ${B} AND chapter != '' GROUP BY subject, chapter ORDER BY chapter`, ...ba),
                   untagged: (await qa(`SELECT DISTINCT subject FROM questions WHERE ${B} AND COALESCE(chapter,'')=''`, ...ba)).map(r => r.subject),
                   papers: (await qa(`SELECT source, MIN(id) AS f FROM questions WHERE ${B} AND ref LIKE 'imp:%' GROUP BY source ORDER BY f DESC`, ...ba)).map(r => r.source),
                   years: (await qa(`SELECT DISTINCT year FROM questions WHERE ${B} AND year IS NOT NULL ORDER BY year DESC`, ...ba)).map(r => r.year),
                   exams: (await qa(`SELECT DISTINCT exam FROM questions WHERE ${B} AND exam != '' ORDER BY exam`, ...ba)).map(r => r.exam), levels: QLEVELS,
                   banks: Object.fromEntries((await qa("SELECT bank, COUNT(*) AS n FROM questions WHERE COALESCE(hidden,0)=0 GROUP BY bank")).map(r => [r.bank, Number(r.n)])),
                   pyq_counts: BANKS.includes(req.query.bank) ? await q1(`SELECT SUM(CASE WHEN year IS NOT NULL OR COALESCE(exam,'') != '' THEN 1 ELSE 0 END) AS pyq,
                     SUM(CASE WHEN year IS NULL AND COALESCE(exam,'') = '' THEN 1 ELSE 0 END) AS practice FROM questions WHERE bank=? AND COALESCE(hidden,0)=0`, req.query.bank) : null };
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
// duplicate finder: same or nearly the same question text (maths, spacing and HTML ignored)
function qWords(html) {
  return String(html || "").replace(/<img[^>]*>/g, " fig ").replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\\[a-zA-Z]+/g, " ").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
}
app.get("/api/questions/duplicates", auth, central, wrap(async req => {
  const min = Math.min(1, Math.max(0.6, Number(req.query.min) || 0.8));
  const rows = await qa("SELECT id, text, subject FROM questions");
  const words = rows.map(r => qWords(r.text));
  const grams = words.map(w => { const g = new Set(); for (let i = 0; i + 2 < w.length; i++) g.add(w[i] + " " + w[i + 1] + " " + w[i + 2]); if (!g.size && w.length) g.add(w.join(" ")); return g; });
  // candidates: questions sharing a rare 4-word run
  const buckets = new Map();
  words.forEach((w, i) => { const seen = new Set(); for (let k = 0; k + 3 < w.length; k++) { const g = w.slice(k, k + 4).join(" "); if (seen.has(g)) continue; seen.add(g);
    let b = buckets.get(g); if (!b) buckets.set(g, (b = [])); if (b.length < 40) b.push(i); } if (w.length && w.length < 4) { const g = "#" + w.join(" "); const b = buckets.get(g) || []; b.push(i); buckets.set(g, b); } });
  const parent = rows.map((_, i) => i), find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const score = new Map(), tried = new Set();
  for (const b of buckets.values()) {
    if (b.length < 2 || b.length >= 40) continue;
    for (let x = 0; x < b.length; x++) for (let y = x + 1; y < b.length; y++) {
      const a = b[x], c = b[y], key = a * 1e6 + c;
      if (tried.has(key)) continue; tried.add(key);
      if (rows[a].subject.toLowerCase() !== rows[c].subject.toLowerCase()) continue;
      const A = grams[a], C = grams[c]; let same = 0; for (const g of A) if (C.has(g)) same++;
      const j = same / (A.size + C.size - same || 1);
      if (j >= min) { parent[find(a)] = find(c); score.set(key, j); }
    }
  }
  const groups = new Map();
  rows.forEach((r, i) => { const p = find(i); if (!groups.has(p)) groups.set(p, []); groups.get(p).push(i); });
  const out = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    let best = 0; for (let x = 0; x < g.length; x++) for (let y = x + 1; y < g.length; y++) { const a = Math.min(g[x], g[y]), c = Math.max(g[x], g[y]); best = Math.max(best, score.get(a * 1e6 + c) || 0); }
    out.push({ similarity: Math.round(best * 100), ids: g.map(i => rows[i].id) });
  }
  out.sort((a, b) => b.similarity - a.similarity);
  return { groups: out.slice(0, 200), total: out.length, checked: rows.length };
}));
app.get("/api/questions/:id", auth, admin, wrap(async req => {
  const q = await q1("SELECT * FROM questions WHERE id=?", req.params.id);
  if (!q) throw new HttpError(404, "Not found");
  q.options = JSON.parse(q.options || "[]");
  return q;
}));
app.post("/api/questions", auth, central, wrap(async req => {
  const q = cleanQuestion(req.body || {});
  return { id: await insert(`INSERT INTO questions (subject, chapter, topic, qtype, difficulty, text, image, options, answer, solution, created_by, fmt, source, exam, bank, qstyle)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, q.subject, q.chapter, q.topic, q.qtype, q.difficulty, q.text, q.image, q.options, q.answer, q.solution, req.user.id, q.fmt, q.source, q.exam, q.bank, q.qstyle) };
}));
app.put("/api/questions/:id", auth, central, wrap(async req => {
  const q = cleanQuestion(req.body || {});
  await run(`UPDATE questions SET subject=?, chapter=?, topic=?, qtype=?, difficulty=?, text=?, image=?, options=?, answer=?, solution=?, fmt=?, source=?, exam=?, bank=?, qstyle=? WHERE id=?`,
    q.subject, q.chapter, q.topic, q.qtype, q.difficulty, q.text, q.image, q.options, q.answer, q.solution, q.fmt, q.source, q.exam, q.bank, q.qstyle, req.params.id);
  return { ok: true };
}));
app.delete("/api/questions/:id", auth, central, wrap(async req => {
  if (await q1("SELECT 1 AS x FROM test_questions WHERE question_id=?", req.params.id)) bad("This question is used in a test, so it can't be deleted.");
  await run("DELETE FROM questions WHERE id=?", req.params.id); return { ok: true };
}));

// ------------------------------------------------------------------ ready-made question sets shipped with the app (bank/*.json.gz)
const PACKS = {
  "jee-main-pyq-physics": { prefix: "jmp:", bank: "main", exam: "JEE Main", file: "jee-main-pyq-physics.json.gz", name: "JEE Main previous-year questions · Physics",
    note: "AIEEE 2002 to JEE Main 2026, chapter-wise, with solutions and figures." },
  "chemistry": { prefix: "chm:", bank: "main", exam: "", file: "chemistry.json.gz", name: "Chemistry question bank",
    note: "35 chapters (physical, organic, inorganic), single-correct, with figures; solutions where available." },
};
const packData = id => JSON.parse(require("zlib").gunzipSync(fs.readFileSync(path.join(__dirname, "bank", PACKS[id].file))).toString("utf8"));
app.get("/api/packs", auth, central, wrap(async () => {
  const out = [];
  for (const [id, p] of Object.entries(PACKS)) {
    let count = 0; try { count = packData(id).questions.length; } catch (e) { continue; }
    const loaded = (await q1("SELECT COUNT(*) AS n FROM questions WHERE ref LIKE ?", p.prefix + "%")).n;
    // once a set has been added it is not offered again (questions deleted later, e.g. duplicates, stay deleted)
    const done = loaded > 0 || !!(await q1("SELECT 1 AS x FROM settings WHERE key=?", "pack." + id));
    if (!done) out.push({ id, name: p.name, note: p.note, count, loaded });
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
    await run("UPDATE questions SET bank=? WHERE ref LIKE ?", p.bank, p.prefix + "%");
  });
  await run("DELETE FROM settings WHERE key=?", "pack." + req.params.id);
  await run("INSERT INTO settings (key, value) VALUES (?, ?)", "pack." + req.params.id, String(Date.now()));
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
    r.attempt_count = (await q1(`SELECT COUNT(*) AS n FROM attempts a JOIN users u ON u.id=a.student_id WHERE a.test_id=? AND ${inList("u.campus_id", scope)}`, t.id)).n;
    r.linked_count = (await q1("SELECT COUNT(*) AS n FROM test_questions WHERE test_id=?", t.id)).n;
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
// online (CBT) settings: mode omr | cbt | both, duration in minutes, window as epoch ms
const DEFAULT_MIN = { JM: 180, RJM: 180, JA: 180, NEET: 200, R180: 180, JMP: 60, JAP: 60, NEETP: 60, DR30: 30 };
async function saveCbt(id, b, sheet) {
  const mode = ["omr", "cbt", "both"].includes(b.mode) ? b.mode : "omr";
  const duration = Math.min(600, Math.max(5, Math.round(Number(b.duration) || DEFAULT_MIN[sheet] || 180)));
  const ms = v => (Number(v) > 0 ? Math.round(Number(v)) : null);
  const opens = ms(b.opens_at), closes = ms(b.closes_at);
  if (mode !== "omr" && opens && closes && closes <= opens) bad("The online test must close after it opens.");
  const maxExits = b.max_exits === undefined || b.max_exits === null || b.max_exits === "" ? 0 : Math.max(0, Math.min(50, Math.round(Number(b.max_exits)) || 0));
  await run("UPDATE tests SET mode=?, duration=?, opens_at=?, closes_at=?, max_exits=? WHERE id=?", mode, duration, opens, closes, maxExits, id);
}
app.post("/api/tests", auth, central, wrap(async req => { const r = await saveTest(req, null); await saveCbt(r.id, req.body || {}, req.body.sheet); return r; }));
app.put("/api/tests/:id", auth, central, wrap(async req => { const r = await saveTest(req, Number(req.params.id)); await saveCbt(Number(req.params.id), req.body || {}, req.body.sheet); return r; }));
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
    const before = (await qa("SELECT qno FROM test_questions WHERE test_id=?", t.id)).map(r => r.qno);
    await run("DELETE FROM test_questions WHERE test_id=?", t.id);
    const key = JSON.parse(t.answer_key || "{}");
    for (const qno of before) if (!(qno in links)) delete key[qno]; // a removed question takes its answer with it
    for (const [k, v] of Object.entries(links)) {
      const qno = Number(k), qid = Number(v);
      const slot = idx.find(x => x.qno === qno);
      const q = await q1("SELECT id, qtype, answer FROM questions WHERE id=?", qid);
      if (!slot || !q) continue;
      const wantNum = slot.sec.qtype === "integer" || slot.sec.qtype === "decimal", isNum = q.qtype === "integer" || q.qtype === "decimal";
      if (wantNum !== isNum) bad(`Q${qno} needs a ${wantNum ? "numerical" : "multiple-choice"} question.`);
      if (slot.sec.qtype === "single" && q.qtype === "multi") bad(`Q${qno} is single-correct, but question ${qid} has more than one correct option.`);
      await run("INSERT INTO test_questions (test_id, qno, question_id) VALUES (?,?,?)", t.id, qno, qid);
      key[qno] = slot.sec.options === "1234" && /^[A-D]$/.test(q.answer) ? String("ABCD".indexOf(q.answer) + 1) : q.answer;
    }
    await run("UPDATE tests SET answer_key=? WHERE id=?", JSON.stringify(key), t.id);
    return { ok: true };
  });
}));
// import a paper made outside the portal: question / solution pictures and answers, checked by an admin in the browser
function keyAnswer(v, sec) {
  const s = String(v || "").toUpperCase().replace(/[\s(),]/g, "");
  if (sec.qtype === "integer" || sec.qtype === "decimal") return /^-?\d*\.?\d+$/.test(s) ? s : "";
  return (sec.options === "1234" ? /^[1-4]{1,4}$/ : /^[A-D]{1,4}$/).test(s) ? (sec.qtype === "single" ? s[0] : s) : "";
}
app.post("/api/tests/:id/import", auth, central, wrap(async req => {
  const t = await visibleTest(req.user, req.params.id);
  const layout = layoutOf(t), idx = OMR.questionIndex(layout);
  const items = Array.isArray(req.body.items) ? req.body.items.slice(0, 400) : [];
  const label = str(req.body.label, 60) || t.code, hidden = req.body.bank === false ? 1 : 0;
  const tag = (url, w) => `<p><img class="qimp" src="${url}" style="width:${Math.max(40, Math.min(1400, Math.round(Number(w) || 600)))}px" alt=""></p>`;
  const prepared = [];
  for (const it of items) {
    const slot = idx.find(x => x.qno === Number(it.qno)); if (!slot) continue;
    prepared.push({ slot, img: it.img ? await saveImage(it.img) : "", w: it.w, sol: it.sol ? await saveImage(it.sol) : "", sw: it.sw, answer: keyAnswer(it.answer, slot.sec) });
  }
  return tx(async () => {
    const fresh = await q1("SELECT answer_key FROM tests WHERE id=?", t.id), key = JSON.parse(fresh.answer_key || "{}");
    let questions = 0, answers = 0;
    for (const p of prepared) {
      const qno = p.slot.qno, sec = p.slot.sec;
      if (p.img) {
        const ref = `imp:${t.id}:${qno}`;
        for (const o of await qa("SELECT id FROM questions WHERE ref=?", ref)) { // an earlier import of this question, unless another test uses it
          if (await q1("SELECT 1 AS x FROM test_questions WHERE question_id=? AND test_id<>?", o.id, t.id)) continue;
          await run("DELETE FROM test_questions WHERE question_id=?", o.id); await run("DELETE FROM questions WHERE id=?", o.id);
        }
        const bankAns = sec.options === "1234" && /^[1-4]+$/.test(p.answer) ? [...p.answer].map(d => "ABCD"[d - 1]).join("") : p.answer;
        const id = await insert(`INSERT INTO questions (subject, chapter, topic, qtype, difficulty, text, image, options, answer, solution, created_by, fmt, source, ref, exam, hidden, bank)
                                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'portal')`, cap1(sec.subject), "", "", sec.qtype, "Medium", tag(p.img, p.w), "", "[]", bankAns,
                                 p.sol ? tag(p.sol, p.sw) : "", req.user.id, "html", label, ref, "", hidden);
        await run("DELETE FROM test_questions WHERE test_id=? AND qno=?", t.id, qno);
        await run("INSERT INTO test_questions (test_id, qno, question_id) VALUES (?,?,?)", t.id, qno, id);
        questions++;
      }
      if (p.answer) { key[qno] = p.answer; answers++; }
    }
    await run("UPDATE tests SET answer_key=? WHERE id=?", JSON.stringify(key), t.id);
    return { questions, answers };
  });
}));
const cap1 = s => (s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : "");
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
    for (const s of mine) { const id = s[k]; (g[id] = g[id] || []).push(s); }
    return Object.entries(g).map(([id, list]) => { const a = list.map(x => x.total);
      return { id: Number(id), name: names[tbl].get(Number(id)) || "?", n: a.length,
        avg: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1), top: Math.max(...a),
        subjects: Object.fromEntries(subjects.map(sb => [sb, +(list.reduce((x, y) => x + ((y.subjects || {})[sb] || 0), 0) / list.length).toFixed(1)])) }; });
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
    subject_max: layout.sections.reduce((m, x) => ((m[x.subject] = (m[x.subject] || 0) + x.count * x.marks.correct), m), {}),
    subject_avg: Object.fromEntries(subjects.map(sb => [sb, mine.length ? +(mine.reduce((x, y) => x + ((y.subjects || {})[sb] || 0), 0) / mine.length).toFixed(1) : 0])),
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
  const linked = Object.fromEntries((await qa(`SELECT tq.qno, q.text, q.image, q.options, q.solution, q.chapter, q.topic, q.difficulty, q.fmt, q.source FROM test_questions tq JOIN questions q ON q.id=tq.question_id WHERE tq.test_id=?`, t.id))
    .map(r => [r.qno, { text: r.text, image: r.image, options: JSON.parse(r.options || "[]"), solution: r.solution, chapter: r.chapter, topic: r.topic, level: r.difficulty, fmt: r.fmt, source: r.source }]));
  // how the whole institute did on each question, and time spent (online tests)
  const rightN = {}, tried = {};
  for (const x of scored) for (const d of x.detail) { if (["correct", "bonus"].includes(d.result)) rightN[d.q] = (rightN[d.q] || 0) + 1; if (["correct", "bonus", "wrong", "partial"].includes(d.result)) tried[d.q] = (tried[d.q] || 0) + 1; }
  const atts = await qa("SELECT student_id, started_at, submitted_at, state FROM attempts WHERE test_id=? AND submitted_at IS NOT NULL", t.id);
  const fullOf = Object.fromEntries(OMR.questionIndex(layout).map(x => [x.qno, x.sec]));
  const mineAtt = atts.find(a => a.student_id === studentId);
  const timeOf = a => { try { return JSON.parse(a.state || "{}").time || {}; } catch (e) { return {}; } };
  const myTime = mineAtt ? timeOf(mineAtt) : null, avgTime = {};
  if (mineAtt) { for (const a of atts) { const tm = timeOf(a); for (const k in tm) avgTime[k] = (avgTime[k] || 0) + tm[k] / atts.length; } }
  const subjects = [...new Set(layout.sections.map(x => x.subject))];
  const avg = a => (a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : 0);
  const rankIn = (list, k) => { const mine = (s.subjects || {})[k] || 0; return { rank: 1 + list.filter(x => ((x.subjects || {})[k] || 0) > mine).length, of: list.length }; };
  const batchMates = scored.filter(x => x.batch_id === s.batch_id);
  const subject_detail = subjects.map(k => {
    const d = s.detail.filter(x => x.subject === k), cnt = r => d.filter(x => r.includes(x.result)).length;
    const right = cnt(["correct", "bonus"]), wrong = cnt(["wrong"]), partial = cnt(["partial"]), blank = cnt(["blank"]);
    const all = scored.map(x => (x.subjects || {})[k] || 0), mates = batchMates.map(x => (x.subjects || {})[k] || 0);
    return { subject: k, marks: (s.subjects || {})[k] || 0, right, wrong, partial, blank, questions: d.length,
      accuracy: right + wrong + partial ? Math.round(((right + partial * 0.5) / (right + wrong + partial)) * 100) : null,
      rank_batch: rankIn(batchMates, k), rank_all: rankIn(scored, k), batch_avg: avg(mates), all_avg: avg(all), top: Math.max(...all) };
  });
  const who = (await q1("SELECT name, roll FROM users WHERE id=?", studentId)) || {};
  return { test: { id: t.id, code: t.code, name: t.name, test_date: t.test_date, sheet_title: layout.title, sheet: layout.id }, max, subject_detail,
    student: { name: who.name || "", roll: who.roll || "" }, source: (await q1("SELECT source FROM results WHERE test_id=? AND student_id=?", t.id, studentId) || {}).source || "",
    batch_avg: avg(batchMates.map(x => x.total)), all_avg: avg(scored.map(x => x.total)), top_total: Math.max(...scored.map(x => x.total)),
    subjects,
    subject_max: layout.sections.reduce((m, x) => ((m[x.subject] = (m[x.subject] || 0) + x.count * x.marks.correct), m), {}),
    total: s.total, by_subject: s.subjects, correct: s.correct, partial: s.partial, wrong: s.wrong, blank: s.blank,
    rank_all: s.rank_all, rank_all_of: s.rank_all_of, rank_campus: s.rank_campus, rank_campus_of: s.rank_campus_of,
    rank_batch: s.rank_batch, rank_batch_of: s.rank_batch_of,
    attempt: mineAtt ? { started_at: mineAtt.started_at, submitted_at: mineAtt.submitted_at, duration: t.duration || null } : null,
    detail: s.detail.map(d => ({ ...d, full: (fullOf[d.q] || {}).marks ? fullOf[d.q].marks.correct : 0, question: linked[d.q] || null, right_pct: scored.length ? Math.round(((rightN[d.q] || 0) / scored.length) * 100) : 0,
      tried_pct: scored.length ? Math.round(((tried[d.q] || 0) / scored.length) * 100) : 0,
      time: myTime ? Math.round(myTime[d.q] || 0) : null, avg_time: myTime ? Math.round(avgTime[d.q] || 0) : null })) };
}

// ------------------------------------------------------------------ toppers of one test: rank lists, best zone / campus, counts in top N
app.get("/api/tests/:id/toppers", auth, admin, wrap(async req => {
  const t = await visibleTest(req.user, req.params.id);
  const { scored, max, layout } = await scoreTest(t);
  const scope = await campusScope(req.user);
  const names = {};
  for (const tbl of ["zones", "campuses", "batches"]) names[tbl] = new Map((await qa(`SELECT id, name FROM ${tbl}`)).map(r => [r.id, r.name]));
  const subjects = [...new Set(layout.sections.map(s => s.subject))];
  const all = scored.slice().sort((a, b) => a.rank_all - b.rank_all);
  const mine = all.filter(s => inScope(scope, s.campus_id));
  const students = mine.map(s => ({ rank: s.rank_all, of: s.rank_all_of, roll: s.roll, name: s.name, total: s.total, pct: +((s.total / max) * 100).toFixed(1),
    subjects: s.subjects, correct: s.correct, wrong: s.wrong, zone_id: s.zone_id, campus_id: s.campus_id, batch_id: s.batch_id,
    zone: names.zones.get(s.zone_id) || "", campus: names.campuses.get(s.campus_id) || "", batch: names.batches.get(s.batch_id) || "" }));
  // counts of each campus / zone among the institute's top N
  const cuts = [20, 50, 100, 500];
  const summary = (key, tbl) => {
    const g = new Map();
    for (const s of mine) {
      const id = s[key]; if (!g.has(id)) g.set(id, { id, name: names[tbl].get(id) || "?", zone: key === "campus_id" ? names.zones.get(s.zone_id) || "" : "", n: 0, sum: 0, sub: {}, best: null, top: {} });
      const x = g.get(id); x.n++; x.sum += s.total; for (const k of subjects) x.sub[k] = (x.sub[k] || 0) + ((s.subjects || {})[k] || 0); if (!x.best || s.rank_all < x.best.rank) x.best = { rank: s.rank_all, name: s.name, roll: s.roll };
      for (const c of cuts) if (s.rank_all <= c) x.top[c] = (x.top[c] || 0) + 1;
    }
    return [...g.values()].map(x => ({ id: x.id, name: x.name, zone: x.zone, n: x.n, avg_pct: +((x.sum / x.n / max) * 100).toFixed(1), best: x.best, top: x.top,
      subjects: Object.fromEntries(subjects.map(k => [k, +(x.sub[k] / x.n).toFixed(1)])) }));
  };
  const subject_max = layout.sections.reduce((m, x) => ((m[x.subject] = (m[x.subject] || 0) + x.count * x.marks.correct), m), {});
  return { test: { id: t.id, code: t.code, name: t.name, test_date: t.test_date }, max, subjects, subject_max, appeared: all.length, cuts, students,
    zones: req.user.role === "central" ? summary("zone_id", "zones") : [], campuses: req.user.role !== "campus" ? summary("campus_id", "campuses") : summary("campus_id", "campuses") };
}));

// ------------------------------------------------------------------ analysis dashboard: trend across tests
// marks are cached per test and recomputed only when results or the key change
const scoreCache = new Map();
async function scoredCached(t) {
  const sig = await q1("SELECT COUNT(*) AS n, MAX(uploaded_at) AS m FROM results WHERE test_id=?", t.id);
  const key = `${sig.n}|${sig.m}|${t.answer_key}|${t.sheet}`;
  const hit = scoreCache.get(t.id);
  if (hit && hit.key === key) return hit.val;
  const val = await scoreTest(t);
  scoreCache.set(t.id, { key, val });
  return val;
}
app.get("/api/dashboard", auth, admin, wrap(async req => {
  const u = req.user, qy = req.query;
  const scope = await campusScope(u);
  const names = {};
  for (const tbl of ["zones", "campuses", "batches"]) names[tbl] = new Map((await qa(`SELECT id, name FROM ${tbl}`)).map(r => [r.id, r.name]));
  const batchInfo = new Map((await qa("SELECT b.id, b.level, b.campus_id, c.zone_id FROM batches b JOIN campuses c ON c.id=b.campus_id")).map(r => [r.id, r]));
  const campusZone = new Map((await qa("SELECT id, zone_id FROM campuses")).map(r => [r.id, r.zone_id]));
  const zoneId = Number(qy.zone_id) || null, campusId = Number(qy.campus_id) || null, level = String(qy.level || "");
  const by = ["all", "zone", "campus", "batch"].includes(qy.by) ? qy.by : "all";
  // tests that have results, oldest first
  let tests = await qa(`SELECT t.* FROM tests t WHERE EXISTS (SELECT 1 FROM results r WHERE r.test_id=t.id) ORDER BY COALESCE(NULLIF(t.test_date,''), t.created_at), t.id`);
  const allSheets = [...new Set(tests.map(t => t.sheet))];
  if (qy.sheet) tests = tests.filter(t => t.sheet === qy.sheet);
  if (qy.published === "1") tests = tests.filter(t => t.published);
  const keep = s => inScope(scope, s.campus_id) && (!zoneId || s.zone_id === zoneId) && (!campusId || s.campus_id === campusId)
    && (!level || (batchInfo.get(s.batch_id) || {}).level === level);
  const gkey = s => (by === "zone" ? s.zone_id : by === "campus" ? s.campus_id : by === "batch" ? s.batch_id : 0);
  const gname = id => (by === "zone" ? names.zones.get(id) : by === "campus" ? names.campuses.get(id) : by === "batch" ? names.batches.get(id) : "All students") || "?";
  const outTests = [], groups = new Map(), subjects = new Set();
  for (const t of tests) {
    const { scored, max, layout } = await scoredCached(t);
    const mine = scored.filter(keep);
    if (!mine.length || !max) continue;
    const smax = layout.sections.reduce((m, x) => ((m[x.subject] = (m[x.subject] || 0) + x.count * x.marks.correct), m), {});
    const pct = s => (s.total / max) * 100;
    const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
    const sub = {};
    for (const k of Object.keys(smax)) { subjects.add(k); const v = mine.map(s => ((s.subjects || {})[k] || 0) / smax[k] * 100); sub[k] = +avg(v).toFixed(1); }
    const pcts = mine.map(pct);
    outTests.push({ id: t.id, code: t.code, name: t.name, test_date: t.test_date, sheet: t.sheet, max, n: mine.length,
      avg_pct: +avg(pcts).toFixed(1), avg_marks: +avg(mine.map(s => s.total)).toFixed(1), top_pct: +Math.max(...pcts).toFixed(1),
      above60: Math.round((pcts.filter(p => p >= 60).length / pcts.length) * 100), subjects: sub });
    const byG = {};
    for (const s of mine) (byG[gkey(s)] = byG[gkey(s)] || []).push(pct(s));
    for (const [gid, arr] of Object.entries(byG)) {
      const id = Number(gid);
      if (!groups.has(id)) groups.set(id, { id, name: gname(id), zone_id: by === "campus" ? campusZone.get(id) : by === "batch" ? (batchInfo.get(id) || {}).zone_id : null,
        campus_id: by === "batch" ? (batchInfo.get(id) || {}).campus_id : null, points: {} });
      groups.get(id).points[t.id] = { avg_pct: +avg(arr).toFixed(1), n: arr.length };
    }
  }
  const last = Number(qy.last) || 0;
  const shown = last ? outTests.slice(-last) : outTests;
  const ids = new Set(shown.map(t => t.id));
  const gl = [...groups.values()].map(g => { for (const k of Object.keys(g.points)) if (!ids.has(Number(k))) delete g.points[k]; return g; })
    .filter(g => Object.keys(g.points).length).sort((a, b) => a.name.localeCompare(b.name));
  const options = {
    zones: u.role === "central" ? [...names.zones].map(([id, name]) => ({ id, name })) : [],
    campuses: (await qa(`SELECT c.id, c.name, c.zone_id FROM campuses c WHERE ${inList("c.id", scope)} ORDER BY c.name`)),
    levels: [...new Set([...batchInfo.values()].map(b => b.level).filter(Boolean))].sort(),
    sheets: allSheets.map(k => ({ id: k, title: (OMR.getLayout(k) || {}).title || k })),
  };
  return { by, tests: shown, groups: gl, subjects: [...subjects], options, role: u.role };
}));

// ------------------------------------------------------------------ printed papers: heading settings and paper data
const PAPER_KEYS = { institute: 120, tagline: 160, logo: 400_000, instructions: 4000 };
async function paperSettings() {
  const out = { institute: "", tagline: "", logo: "", instructions: "" };
  for (const r of await qa("SELECT key, value FROM settings WHERE key LIKE 'paper.%'")) out[r.key.slice(6)] = r.value;
  return out;
}
app.get("/api/settings/paper", auth, admin, wrap(() => paperSettings()));
// logo and name for the login page (shown before anyone logs in)
app.get("/api/brand", wrap(async () => { const p = await paperSettings(); return { institute: p.institute, tagline: p.tagline, logo: p.logo }; }));
app.put("/api/settings/paper", auth, central, wrap(async req => {
  const b = req.body || {};
  if (b.logo && !/^data:image\/(png|jpeg|webp);base64,/.test(b.logo)) bad("Logo must be a PNG, JPG or WEBP image.");
  if (b.logo && b.logo.length > PAPER_KEYS.logo) bad("Logo is too big. Use an image under 250 KB.");
  await tx(async () => { for (const [k, max] of Object.entries(PAPER_KEYS)) if (k in b) {
    await run("DELETE FROM settings WHERE key=?", "paper." + k);
    await run("INSERT INTO settings (key, value) VALUES (?,?)", "paper." + k, String(b[k] ?? "").slice(0, max));
  } });
  return paperSettings();
}));
app.get("/api/tests/:id/paper", auth, admin, wrap(async req => {
  const t = await testRow(await visibleTest(req.user, req.params.id));
  const layout = layoutOf(t);
  const qs = await qa(`SELECT tq.qno, q.id, q.text, q.image, q.options, q.fmt, q.qtype, q.answer, q.solution, q.source, q.chapter FROM test_questions tq
                       JOIN questions q ON q.id=tq.question_id WHERE tq.test_id=? ORDER BY tq.qno`, t.id);
  qs.forEach(q => (q.options = JSON.parse(q.options || "[]")));
  return { test: { id: t.id, code: t.code, name: t.name, test_date: t.test_date, duration: t.duration || DEFAULT_MIN[t.sheet] || 180, sheet_title: layout.title, answer_key: t.answer_key },
    sections: layout.sections.map(s => ({ name: s.name, subject: s.subject, qtype: s.qtype, count: s.count, options: s.options, marks: s.marks })),
    questions: qs, settings: await paperSettings() };
}));

// ------------------------------------------------------------------ online test (CBT), NTA style
const GRACE_MS = 90 * 1000; // network delay allowance after the clock reaches zero
async function cbtTestsFor(user) {
  return qa(`SELECT t.* FROM tests t JOIN test_batches tb ON tb.test_id=t.id WHERE tb.batch_id=? AND t.mode IN ('cbt','both') ORDER BY t.test_date DESC, t.id DESC`, user.batch_id || 0);
}
// a CBT answer state -> the same answers object an OMR sheet gives ({qno: "B"}), so marking and analysis are shared
function answersFromState(state, layout) {
  const idx = OMR.questionIndex(layout), out = {};
  for (const { qno, sec } of idx) {
    const a = state && state.ans && state.ans[qno];
    if (a == null || a === "") continue;
    let v = String(a).toUpperCase().replace(/\s/g, "").slice(0, 12);
    if (sec.qtype === "single" || sec.qtype === "multi") {
      v = [...new Set(v.replace(/[^A-D]/g, ""))].sort().join("");
      if (!v) continue;
      if (sec.qtype === "single") v = v[0];
      if (sec.options === "1234") v = [...v].map(c => "ABCD".indexOf(c) + 1).join("");
    } else if (!/^-?\d*\.?\d+$/.test(v)) continue;
    out[qno] = v;
  }
  return out;
}
async function finishAttempt(att, t, state) {
  const layout = layoutOf(t);
  const st = state || JSON.parse(att.state || "{}");
  await tx(async () => {
    await run("UPDATE attempts SET state=?, submitted_at=? WHERE id=? AND submitted_at IS NULL", JSON.stringify(st), Date.now(), att.id);
    await run(`INSERT INTO results (test_id, student_id, answers, source, uploaded_by) VALUES (?,?,?,?,?)
         ON CONFLICT(test_id, student_id) DO UPDATE SET answers=excluded.answers, source=excluded.source, uploaded_by=excluded.uploaded_by, uploaded_at=datetime('now')`,
      t.id, att.student_id, JSON.stringify(answersFromState(st, layout)), "Online test", att.student_id);
  });
}
// tests whose time ran out without a submit are submitted with the last saved answers
async function finishExpired() {
  const due = await qa("SELECT a.*, t.sheet, t.code FROM attempts a JOIN tests t ON t.id=a.test_id WHERE a.submitted_at IS NULL AND a.ends_at < ?", Date.now() - GRACE_MS);
  for (const a of due) { try { await finishAttempt(a, { id: a.test_id, sheet: a.sheet }); } catch (e) { console.warn("Could not finish attempt", a.id, e.message); } }
}
setInterval(() => { if (db) finishExpired().catch(() => {}); }, 60 * 1000);

function cbtStatus(t, att, now = Date.now()) {
  if (att && att.submitted_at) return "submitted";
  if (att && now < att.ends_at + GRACE_MS) return "in_progress";
  if (att) return "submitted";
  if (t.opens_at && now < t.opens_at) return "not_open";
  if (t.closes_at && now >= t.closes_at) return "closed";
  return "open";
}
app.get("/api/my/cbt", auth, wrap(async req => {
  if (req.user.role !== "student") forbid();
  await finishExpired();
  const out = [];
  for (const t of await cbtTestsFor(req.user)) {
    const att = await q1("SELECT * FROM attempts WHERE test_id=? AND student_id=?", t.id, req.user.id);
    const layout = OMR.getLayout(t.sheet);
    out.push({ id: t.id, code: t.code, name: t.name, test_date: t.test_date, duration: t.duration || DEFAULT_MIN[t.sheet] || 180, opens_at: t.opens_at, closes_at: t.closes_at,
      questions: layout ? OMR.totalQ(layout) : 0, status: cbtStatus(t, att), published: !!t.published, max_exits: maxExitsOf(t) });
  }
  return { now: Date.now(), tests: out };
}));
// leaving the exam window: each exit is logged; after max_exits the next one submits the test (0 = never)
const maxExitsOf = t => (t.max_exits == null ? 0 : Number(t.max_exits));
const parseJ = (v, d) => { try { return JSON.parse(v || "") ?? d; } catch (e) { return d; } };
function exitCount(att, state) {
  const server = parseJ(att.exits, []).filter(e => e.c).length;
  const st = state || parseJ(att.state, {});
  const client = Array.isArray(st.exits) ? st.exits.filter(e => e.c).length : 0;
  return Math.max(server, client);
}
const overExits = (t, n) => maxExitsOf(t) > 0 && n > maxExitsOf(t);
async function myCbtTest(req) {
  if (req.user.role !== "student") forbid();
  const t = (await cbtTestsFor(req.user)).find(x => x.id === Number(req.params.id));
  if (!t) throw new HttpError(404, "This online test is not available to you.");
  return t;
}
// paper for the exam screen: questions without answers or solutions
async function cbtPaper(t) {
  const layout = layoutOf(t);
  const qs = await qa(`SELECT tq.qno, q.text, q.image, q.options, q.fmt, q.qtype FROM test_questions tq JOIN questions q ON q.id=tq.question_id WHERE tq.test_id=? ORDER BY tq.qno`, t.id);
  const byNo = Object.fromEntries(qs.map(q => [q.qno, { text: q.text, image: q.image, options: JSON.parse(q.options || "[]"), fmt: q.fmt }]));
  return {
    sections: layout.sections.map(s => ({ name: s.name, subject: s.subject, qtype: s.qtype, count: s.count, options: s.options, marks: s.marks })),
    questions: OMR.questionIndex(layout).map(({ qno, si }) => ({ qno, si, ...(byNo[qno] || { missing: true }) })),
  };
}
app.post("/api/my/cbt/:id/start", auth, wrap(async req => {
  const t = await myCbtTest(req);
  let att = await q1("SELECT * FROM attempts WHERE test_id=? AND student_id=?", t.id, req.user.id);
  const now = Date.now(), status = cbtStatus(t, att, now);
  if (status === "submitted") bad("You have already submitted this test.");
  if (status === "not_open") bad("This test has not opened yet.");
  if (status === "closed") bad("This test is closed.");
  const paper = await cbtPaper(t);
  if (paper.questions.some(q => q.missing)) bad("This test is not ready yet. Please tell your teacher.");
  if (!att) {
    let ends = now + (t.duration || DEFAULT_MIN[t.sheet] || 180) * 60000;
    if (t.closes_at) ends = Math.min(ends, t.closes_at);
    try { await run("INSERT INTO attempts (test_id, student_id, started_at, ends_at, state, saved_at) VALUES (?,?,?,?,?,?)", t.id, req.user.id, now, ends, "{}", now); }
    catch (e) { if (!/UNIQUE/.test(e.message)) throw e; }
    att = await q1("SELECT * FROM attempts WHERE test_id=? AND student_id=?", t.id, req.user.id);
  }
  return { test: { id: t.id, code: t.code, name: t.name, sheet_title: layoutOf(t).title }, now, ends_at: att.ends_at, state: JSON.parse(att.state || "{}"), ...paper,
    max_exits: maxExitsOf(t), exits: exitCount(att),
    candidate: { name: req.user.name || req.user.username, roll: req.user.roll } };
}));
const cleanState = s => {
  const o = { ans: {}, mark: {}, seen: {}, time: {}, cur: 0, exits: [] };
  if (!s || typeof s !== "object") return o;
  if (Array.isArray(s.exits)) o.exits = s.exits.slice(0, 300).map(e => ({ at: Number(e && e.at) || 0, ms: Math.max(0, Number(e && e.ms) || 0), kind: str(e && e.kind, 10), c: !!(e && e.c) }));
  for (const k of ["ans", "mark", "seen", "time"]) for (const [q, v] of Object.entries(s[k] || {})) {
    const n = Number(q); if (!(n >= 1 && n <= 400)) continue;
    o[k][n] = k === "ans" ? str(v, 16) : k === "time" ? Math.max(0, Math.min(36000, Number(v) || 0)) : !!v;
  }
  o.cur = Math.max(0, Math.min(400, Number(s.cur) || 0));
  return o;
};
app.put("/api/my/cbt/:id/save", auth, wrap(async req => {
  const t = await myCbtTest(req);
  const att = await q1("SELECT * FROM attempts WHERE test_id=? AND student_id=?", t.id, req.user.id);
  if (!att) bad("Start the test first.");
  if (att.submitted_at) return { submitted: true };
  if (Date.now() > att.ends_at + GRACE_MS) { await finishAttempt(att, t); return { submitted: true }; }
  const st = cleanState(req.body.state);
  if (overExits(t, exitCount(att, st))) { await finishAttempt(att, t, st); return { submitted: true, reason: "exits" }; }
  await run("UPDATE attempts SET state=?, saved_at=? WHERE id=?", JSON.stringify(st), Date.now(), att.id);
  return { ok: true, now: Date.now(), ends_at: att.ends_at };
}));
// the exam screen reports the moment a student leaves it (sent even if the page is going to the background)
app.post("/api/my/cbt/:id/exit", auth, wrap(async req => {
  const t = await myCbtTest(req);
  const att = await q1("SELECT * FROM attempts WHERE test_id=? AND student_id=?", t.id, req.user.id);
  if (!att) bad("Start the test first.");
  if (att.submitted_at) return { submitted: true };
  const log = parseJ(att.exits, []);
  if (log.length < 300) log.push({ at: Date.now(), kind: str((req.body || {}).kind, 10), c: !!(req.body || {}).counted });
  await run("UPDATE attempts SET exits=? WHERE id=?", JSON.stringify(log), att.id);
  att.exits = JSON.stringify(log);
  const n = exitCount(att);
  if (overExits(t, n)) { await finishAttempt(att, t); return { submitted: true, reason: "exits", count: n }; }
  return { count: n, max: maxExitsOf(t) };
}));
app.post("/api/my/cbt/:id/submit", auth, wrap(async req => {
  const t = await myCbtTest(req);
  const att = await q1("SELECT * FROM attempts WHERE test_id=? AND student_id=?", t.id, req.user.id);
  if (!att) bad("Start the test first.");
  if (att.submitted_at) return { submitted: true };
  // answers sent after time ran out (beyond the grace) are ignored; the last saved ones count
  const late = Date.now() > att.ends_at + GRACE_MS;
  await finishAttempt(att, t, late ? null : cleanState(req.body.state));
  return { submitted: true };
}));
// admins: see who has started/submitted, and let a student retake after a technical problem
app.get("/api/tests/:id/attempts", auth, admin, wrap(async req => {
  const t = await visibleTest(req.user, req.params.id);
  const scope = await campusScope(req.user);
  const rows = await qa(`SELECT a.student_id, a.started_at, a.ends_at, a.submitted_at, a.exits, a.state, u.roll, u.name FROM attempts a JOIN users u ON u.id=a.student_id
             WHERE a.test_id=? AND ${inList("u.campus_id", scope)} ORDER BY u.roll`, t.id);
  return rows.map(({ exits, state, ...a }) => { const st = parseJ(state, {}), n = exitCount({ exits, state }, st);
    const sleeps = (Array.isArray(st.exits) ? st.exits : parseJ(exits, [])).filter(e => !e.c).length;
    return { ...a, exits: n, screen_off: sleeps, max_exits: maxExitsOf(t), auto_submitted: !!a.submitted_at && overExits(t, n) }; });
}));
app.delete("/api/tests/:id/attempts/:sid", auth, admin, wrap(async req => {
  const t = await visibleTest(req.user, req.params.id);
  const u = await q1("SELECT campus_id FROM users WHERE id=?", req.params.sid);
  if (!u || !inScope(await campusScope(req.user), u.campus_id)) forbid();
  await tx(async () => { await run("DELETE FROM attempts WHERE test_id=? AND student_id=?", t.id, req.params.sid);
    await run("DELETE FROM results WHERE test_id=? AND student_id=? AND source='Online test'", t.id, req.params.sid); });
  return { ok: true };
}));

// ------------------------------------------------------------------ student side
app.get("/api/my/tests", auth, wrap(async req => {
  if (req.user.role !== "student") forbid();
  const tests = await qa(`SELECT t.* FROM tests t JOIN results r ON r.test_id=t.id
             WHERE r.student_id=? AND t.published=1 ORDER BY t.test_date DESC, t.id DESC`, req.user.id);
  const out = [];
  for (const t of tests) {
    const rep = await studentReport(t, req.user.id);
    const lay = layoutOf(t);
    out.push({ id: t.id, code: t.code, name: t.name, test_date: t.test_date, sheet: t.sheet, total: rep.total, max: rep.max, questions: OMR.totalQ(lay),
      duration: t.duration || DEFAULT_MIN[t.sheet] || null, attempt: rep.attempt, rank_all: rep.rank_all, rank_all_of: rep.rank_all_of, subjects: rep.subjects,
      correct: rep.correct, wrong: rep.wrong, blank: rep.blank,
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

// every question a student got wrong, partly right or left blank, across all published tests
app.get("/api/my/mistakes", auth, wrap(async req => {
  if (req.user.role !== "student") forbid();
  const tests = await qa(`SELECT t.* FROM tests t JOIN results r ON r.test_id=t.id WHERE r.student_id=? AND t.published=1 ORDER BY t.test_date, t.id`, req.user.id);
  const items = [], noQuestion = [];
  for (const t of tests) {
    const { scored } = await scoredCached(t);
    const me = scored.find(x => x.student_id === req.user.id); if (!me) continue;
    const linked = new Map((await qa(`SELECT tq.qno, q.subject, q.chapter, q.topic, q.difficulty, q.qtype FROM test_questions tq JOIN questions q ON q.id=tq.question_id WHERE tq.test_id=?`, t.id)).map(r => [r.qno, r]));
    const right = {}; for (const x of scored) for (const d of x.detail) if (d.result === "correct" || d.result === "bonus") right[d.q] = (right[d.q] || 0) + 1;
    let missing = 0;
    for (const d of me.detail) {
      if (!["wrong", "blank", "partial"].includes(d.result)) continue;
      const q = linked.get(d.q);
      if (!q) { missing++; continue; }
      items.push({ test_id: t.id, code: t.code, test: t.name, date: t.test_date, qno: d.q, result: d.result, marked: d.marked || "", key: d.key || "", marks: d.marks,
        subject: q.subject || d.subject, chapter: q.chapter || "", topic: q.topic || "", level: q.difficulty || "", right_pct: scored.length ? Math.round(((right[d.q] || 0) / scored.length) * 100) : 0 });
    }
    if (missing) noQuestion.push({ code: t.code, test: t.name, count: missing });
  }
  return { tests: tests.length, items, noQuestion };
}));
// one of those questions, with its solution
app.get("/api/my/mistakes/:tid/:qno", auth, wrap(async req => {
  if (req.user.role !== "student") forbid();
  const t = await q1("SELECT id FROM tests WHERE id=? AND published=1", Number(req.params.tid));
  if (!t || !(await q1("SELECT 1 AS x FROM results WHERE test_id=? AND student_id=?", t.id, req.user.id))) throw new HttpError(404, "Not found.");
  const q = await q1(`SELECT q.text, q.image, q.options, q.solution, q.fmt, q.qtype FROM test_questions tq JOIN questions q ON q.id=tq.question_id WHERE tq.test_id=? AND tq.qno=?`, t.id, Number(req.params.qno));
  if (!q) throw new HttpError(404, "Not found.");
  return { ...q, options: JSON.parse(q.options || "[]") };
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
  await sortBanks(); // questions from before the three banks get one
  // exits only warn by default: tests made while auto-submit was the default no longer submit
  if (!(await q1("SELECT 1 AS x FROM settings WHERE key='migr.exits-warn-only'"))) {
    await run("UPDATE tests SET max_exits=0");
    await run("INSERT INTO settings (key, value) VALUES ('migr.exits-warn-only', ?)", String(Date.now()));
  }
  // chemistry set: options moved onto their own (A)-(D) lines like physics; update copies added before this change
  if (!(await q1("SELECT 1 AS x FROM settings WHERE key='migr.chem-opts-1'"))) {
    if ((await q1("SELECT COUNT(*) AS n FROM questions WHERE ref LIKE 'chm:%'")).n > 0) {
      const qs = packData("chemistry").questions;
      await tx(async () => { for (const q of qs) await run("UPDATE questions SET text=? WHERE ref=? AND text LIKE '%<p>(1)%'", q.text, "chm:" + q.ref); });
    }
    await run("INSERT INTO settings (key, value) VALUES ('migr.chem-opts-1', ?)", String(Date.now()));
  }
  console.log(`Data is stored in ${db.kind === "postgres" ? "PostgreSQL (DATABASE_URL)" : db.file}`);
  if (!(await q1("SELECT id FROM users WHERE role='central' LIMIT 1"))) {
    const u = process.env.ADMIN_USER || "admin";
    const p = process.env.ADMIN_PASSWORD || "change-me-now";
    await insert("INSERT INTO users (username, pass, role, name) VALUES (?,?,?,?)", u, await hashPassword(p), "central", "Central admin");
    console.log(`Created central admin "${u}". Log in and change the password.`);
  }
  app.listen(PORT, () => console.log(`Test portal running on http://localhost:${PORT}`));
})().catch(e => { console.error("Could not start:", e.message); process.exit(1); });
