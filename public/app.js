(function () {
  "use strict";
  const O = window.OMR, SH = window.OMRSheet;
  // Heavy tools (scanning, PDF, Excel) load only on the admin screens that use them, so student phones download little.
  const LIBS = { jsqr: "/vendor/jsQR.js", qrcode: "/vendor/qrcode.js", jspdf: "/vendor/jspdf.umd.min.js", jszip: "/vendor/jszip.min.js",
    pdf: "/vendor/pdf.min.js", pdfworker: "/vendor/pdf.worker.min.js", xlsx: "/vendor/xlsx.full.min.js" };
  const libLoads = {};
  const loadLib = k => (libLoads[k] = libLoads[k] || new Promise((res, rej) => {
    const s = document.createElement("script"); s.src = LIBS[k];
    s.onload = res; s.onerror = () => { delete libLoads[k]; s.remove(); rej(new Error("Could not load part of the page. Check the internet connection and try again.")); };
    document.head.append(s);
  }));
  async function need(...keys) { for (const k of keys) await loadLib(k); }
  const $ = (s, root = document) => root.querySelector(s);
  const h = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const k in attrs) {
      const v = attrs[k];
      if (v === false || v == null) continue;
      if (k === "class") e.className = v;
      else if (k === "html") e.innerHTML = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const c of kids.flat(Infinity)) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
    return e;
  };
  const show = (el, ...kids) => el.replaceChildren(...kids.flat().filter(k => k != null && k !== false));
  const toast = msg => { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3500); };
  async function api(method, url, body) {
    const r = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, credentials: "same-origin" });
    let data = null; try { data = await r.json(); } catch (e) { /* empty */ }
    if (r.status === 401 && url !== "/api/login") { state.me = null; location.hash = "#/login"; throw new Error((data && data.error) || "Please log in."); }
    if (!r.ok) throw new Error((data && data.error) || "Request failed.");
    return data;
  }
  const GET = u => api("GET", u), POST = (u, b) => api("POST", u, b || {}), PUT = (u, b) => api("PUT", u, b || {}), PATCH = (u, b) => api("PATCH", u, b || {}), DEL = u => api("DELETE", u);
  function download(name, blobOrText, type) {
    const blob = blobOrText instanceof Blob ? blobOrText : new Blob([blobOrText], { type: type || "text/csv" });
    if (window.__saveFile) return window.__saveFile(name, blob);
    const a = h("a", { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }
  const csv = rows => rows.map(r => r.map(v => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(",")).join("\r\n") + "\r\n";
  function modal(build) {
    const m = $("#modal"), body = $("#modal-body");
    body.replaceChildren(); m.hidden = false;
    const close = () => { m.hidden = true; body.replaceChildren(); };
    build(body, close);
    m.onclick = e => { if (e.target === m) close(); };
    const first = body.querySelector("input,select,textarea,button"); if (first) first.focus();
    return close;
  }
  function confirmBox(text, yes, onYes) {
    modal((b, close) => b.append(h("h2", {}, text), h("div", { class: "row" },
      h("button", { class: "btn danger", type: "button", onclick: async () => { close(); await onYes(); } }, yes),
      h("button", { class: "btn ghost", type: "button", onclick: close }, "Cancel"))));
  }
  const field = (label, input, hint) => h("label", { class: "f" }, label, hint ? h("span", { class: "h" }, hint) : null, input);
  const fmtDate = d => (d ? new Date(d + "T00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "");
  const LEVEL = { "11": "11th", "12": "12th", Dropper: "Dropper" };
  const ROLE = { central: "Central team", zone: "Zone admin", campus: "Campus admin", student: "Student" };

  const state = { me: null, s: null }; // s = structure cache
  async function structure(force) { if (!state.s || force) state.s = await GET("/api/structure"); return state.s; }
  const zoneName = id => (state.s?.zones.find(z => z.id === id) || {}).name || "";
  const campusName = id => (state.s?.campuses.find(c => c.id === id) || {}).name || "";
  const batchOf = id => state.s?.batches.find(b => b.id === id);
  const batchLabel = id => { const b = batchOf(id); return b ? `${b.name} (${LEVEL[b.level] || b.level})` : ""; };
  const batchFull = id => { const b = batchOf(id); return b ? `${campusName(b.campus_id)} · ${b.name}` : ""; };

  // ================================================================ routing
  const routes = [];
  const route = (re, fn, who) => routes.push({ re, fn, who });
  async function render() {
    const hash = location.hash.slice(1) || "/";
    if (!state.me && hash !== "/login") {
      try { state.me = await GET("/api/me"); } catch (e) { return; }
    }
    const view = $("#view");
    if (hash === "/login") { $("#bar").hidden = true; return loginView(view); }
    drawBar(hash);
    for (const r of routes) {
      const m = hash.match(r.re);
      if (!m) continue;
      if (r.who && !r.who.includes(state.me.role)) break;
      show(view, h("p", { class: "muted" }, "Loading…"));
      try { await r.fn(view, ...m.slice(1)); }
      catch (e) { show(view, h("div", { class: "card" }, h("h2", {}, "Could not open this page"), h("p", { class: "err" }, e.message))); }
      window.scrollTo(0, 0);
      return;
    }
    location.hash = state.me.role === "student" ? "#/my" : "#/";
  }
  window.addEventListener("hashchange", render);
  function drawBar(hash) {
    $("#bar").hidden = false;
    const me = state.me;
    const items = me.role === "student" ? [["#/my", "My results"], ["#/account", "Account"]]
      : [["#/", "Home"], ["#/tests", "Tests"], ["#/students", "Students"], ...(me.role === "central" ? [["#/bank", "Question bank"], ["#/structure", "Zones & batches"], ["#/admins", "Admins"]] : [["#/structure", "Campuses & batches"]]), ["#/account", "Account"]];
    $("#nav").replaceChildren(...items.map(([href, t]) => h("a", { href, class: ("#" + hash === href || (href !== "#/" && ("#" + hash).startsWith(href))) ? "on" : "" }, t)));
    const place = me.role === "zone" ? ` · ${me.zone}` : me.role === "campus" ? ` · ${me.campus}` : me.role === "student" ? ` · ${me.roll}` : "";
    $("#who").textContent = `${me.name || me.username} (${ROLE[me.role]}${place})`;
    syncInstall();
  }
  // ---- install as an app (Android/desktop Chrome: install prompt; iPhone: Share > Add to Home Screen)
  let installEvt = null;
  const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const syncInstall = () => document.querySelectorAll(".install-btn, #install").forEach(b => (b.hidden = !installEvt || standalone()));
  addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvt = e; syncInstall(); });
  addEventListener("appinstalled", () => { installEvt = null; syncInstall(); toast("Installed. Open Test Portal from your home screen."); });
  async function doInstall() { if (!installEvt) return; installEvt.prompt(); try { await installEvt.userChoice; } catch (e) { /* closed */ } installEvt = null; syncInstall(); }
  $("#install").addEventListener("click", doInstall);
  function installHint() {
    if (standalone()) return null;
    if (installEvt) return h("div", { class: "card", style: "border-left:4px solid var(--gold)" }, h("b", {}, "Get the app"),
      h("p", { class: "small", style: "margin:0" }, "Install Test Portal on this phone to open your results in one tap."),
      h("div", {}, h("button", { class: "btn gold small install-btn", type: "button", onclick: doInstall }, "Install app")));
    let hidden = false; try { hidden = localStorage.getItem("tp-ios-hint") === "off"; } catch (e) { /* storage off */ }
    if (isIOS && !hidden) {
      const card = h("div", { class: "card", style: "border-left:4px solid var(--gold)" }, h("b", {}, "Add to your home screen"),
        h("p", { class: "small", style: "margin:0" }, "In Safari, tap the Share button (square with an arrow), then Add to Home Screen. Test Portal then opens like an app."),
        h("div", {}, h("button", { class: "link small", type: "button", onclick: () => { try { localStorage.setItem("tp-ios-hint", "off"); } catch (e) { /* off */ } card.remove(); } }, "Don't show again")));
      return card;
    }
    return null;
  }
  $("#logout").addEventListener("click", async () => { await POST("/api/logout"); state.me = null; state.s = null; location.hash = "#/login"; });

  // ================================================================ login
  function loginView(view) {
    const u = h("input", { id: "login-user", autocomplete: "username", required: true });
    const p = h("input", { id: "login-pass", type: "password", autocomplete: "current-password", required: true });
    const err = h("p", { class: "err small" });
    const form = h("form", { class: "card login", onsubmit: async e => {
      e.preventDefault(); err.textContent = "";
      try { await POST("/api/login", { username: u.value, password: p.value }); state.me = await GET("/api/me"); state.s = null; location.hash = state.me.role === "student" ? "#/my" : "#/"; }
      catch (x) { err.textContent = x.message; }
    } }, h("h1", {}, "Test Portal"), h("p", { class: "sub" }, "Log in with the username and password your institute gave you."),
      field("Username", u), field("Password", p), err, h("button", { class: "btn", type: "submit" }, "Log in"));
    show(view, form);
    if (window.__previewAccounts) {
      form.append(h("div", { style: "border-top:1px solid var(--line);padding-top:12px;display:grid;gap:8px" },
        h("h3", {}, "Preview accounts"), h("p", { class: "small muted", style: "margin:0" }, "This preview runs inside your browser with demo data. Pick a role to fill in its login."),
        window.__previewAccounts.map(([label, un, pw]) => h("button", { class: "btn ghost small", type: "button", style: "text-align:left;white-space:normal", onclick: () => { u.value = un; p.value = pw; } }, `${label}  ·  ${un} / ${pw}`)),
        h("button", { class: "link small", type: "button", style: "justify-self:start", onclick: () => window.__resetPreview() }, "Reset demo data")));
    }
    const hint = installHint(); if (hint) { hint.classList.add("login"); hint.style.marginTop = "12px"; view.append(hint); }
    u.focus();
  }

  // ================================================================ home (admins)
  route(/^\/$/, async view => {
    const [o, tests] = await Promise.all([GET("/api/overview"), GET("/api/tests"), structure(true)]);
    const me = state.me;
    show(view, 
      h("div", { class: "head" }, h("div", {}, h("h1", {}, `Hello, ${me.name || me.username}`),
        h("p", { class: "sub" }, me.role === "central" ? "You can see every zone, campus and batch." : me.role === "zone" ? `You can see all campuses in ${me.zone} zone.` : `You can see ${me.campus} campus.`)),
        me.role === "central" ? h("a", { class: "btn gold", href: "#/tests/new" }, "New test") : null),
      o.temporary_storage ? h("div", { class: "card", style: "border-left:4px solid var(--bad)" }, h("h2", { class: "err" }, "Data is not being kept"),
        h("p", {}, "This site has no disk attached, so every student, test and mark is erased when the server restarts or updates. Fine for trying things out; attach a disk before adding real data.")) : null,
      h("div", { class: "stats" },
        o.zones != null ? h("div", { class: "stat" }, h("b", {}, o.zones), h("span", {}, "Zones")) : null,
        h("div", { class: "stat" }, h("b", {}, o.campuses), h("span", {}, "Campuses")),
        h("div", { class: "stat" }, h("b", {}, o.batches), h("span", {}, "Batches")),
        h("div", { class: "stat gold" }, h("b", {}, o.students), h("span", {}, "Students")),
        h("div", { class: "stat" }, h("b", {}, o.tests), h("span", {}, "Tests")),
        me.role === "central" ? h("div", { class: "stat" }, h("b", {}, o.questions), h("span", {}, "Questions in bank")) : null),
      h("div", { class: "card" }, h("div", { class: "head" }, h("h2", {}, "Recent tests"), h("a", { href: "#/tests" }, "All tests")),
        testsTable(tests.slice(0, 8))));
  }, ["central", "zone", "campus"]);

  function testsTable(tests) {
    if (!tests.length) return h("p", { class: "empty" }, state.me.role === "central" ? "No tests yet. Create one with New test." : "No tests for your campuses yet.");
    return h("div", { class: "tablebox" }, h("table", {}, h("thead", {}, h("tr", {}, ["Date", "Code", "Test", "Sheet", "Batches", "Sheets read", "Results"].map(t => h("th", {}, t)))),
      h("tbody", {}, tests.map(t => h("tr", { tabindex: 0, onclick: () => (location.hash = `#/tests/${t.id}`), onkeydown: e => e.key === "Enter" && (location.hash = `#/tests/${t.id}`) },
        h("td", {}, fmtDate(t.test_date)), h("td", { class: "mono" }, t.code), h("td", {}, t.name), h("td", {}, t.sheet_title),
        h("td", {}, t.batch_ids.length), h("td", { class: "num" }, `${t.result_count} / ${t.student_count}`),
        h("td", {}, h("span", { class: "pill " + (t.published ? "ok" : "") }, t.published ? "Published" : "Not published")))))));
  }

  // ================================================================ structure
  route(/^\/structure$/, async view => {
    const s = await structure(true);
    const central = state.me.role === "central";
    const tree = h("div", { class: "tree" });
    const draw = () => {
      tree.replaceChildren();
      if (!s.zones.length) tree.append(h("p", { class: "empty" }, central ? "No zones yet. Add the first zone above." : "Nothing assigned to you yet."));
      for (const z of s.zones) {
        const cs = s.campuses.filter(c => c.zone_id === z.id);
        tree.append(h("div", { class: "zone" },
          h("div", { class: "zone-h" }, h("h2", {}, `${z.name} zone`), central ? h("div", { class: "row" },
            h("button", { class: "btn small ghost", type: "button", onclick: () => nameBox("Add campus to " + z.name, "", n => POST("/api/campuses", { zone_id: z.id, name: n })) }, "Add campus"),
            h("button", { class: "btn small ghost", type: "button", onclick: () => nameBox("Rename zone", z.name, n => PATCH(`/api/zones/${z.id}`, { name: n })) }, "Rename"),
            h("button", { class: "btn small danger", type: "button", onclick: () => confirmBox(`Remove ${z.name} zone?`, "Remove", () => act(() => DEL(`/api/zones/${z.id}`))) }, "Remove")) : null),
          cs.length ? cs.map(c => {
            const bs = s.batches.filter(b => b.campus_id === c.id);
            return h("div", { class: "campus" },
              h("div", { class: "campus-h" }, h("b", {}, c.name, h("span", { class: "muted small" }, ` · ${c.students} students`)), central ? h("div", { class: "row" },
                h("button", { class: "btn small ghost", type: "button", onclick: () => batchBox(c) }, "Add batch"),
                h("button", { class: "btn small ghost", type: "button", onclick: () => nameBox("Rename campus", c.name, n => PATCH(`/api/campuses/${c.id}`, { name: n })) }, "Rename"),
                h("button", { class: "btn small danger", type: "button", onclick: () => confirmBox(`Remove ${c.name} campus?`, "Remove", () => act(() => DEL(`/api/campuses/${c.id}`))) }, "Remove")) : null),
              h("div", { class: "chips" }, bs.length ? bs.map(b => h("span", { class: "chip" }, h("a", { href: `#/students?batch=${b.id}` }, `${b.name}`), h("span", { class: "muted" }, `${LEVEL[b.level]} · ${b.students}`),
                central ? h("button", { type: "button", title: "Edit batch", "aria-label": `Edit ${b.name}`, onclick: () => batchBox(c, b) }, "✎") : null)) : h("span", { class: "muted small" }, "No batches yet")));
          }) : h("span", { class: "muted small" }, "No campuses yet")));
      }
    };
    async function act(fn) { try { await fn(); Object.assign(s, await structure(true)); draw(); } catch (e) { toast(e.message); } }
    function nameBox(title, val, save) {
      modal((b, close) => {
        const i = h("input", { id: "name-box", value: val, maxlength: 80 });
        const err = h("p", { class: "err small" });
        b.append(h("form", { class: "card", style: "border:0;padding:0", onsubmit: async e => { e.preventDefault(); try { await save(i.value); close(); act(async () => {}); } catch (x) { err.textContent = x.message; } } },
          h("h2", {}, title), field("Name", i), err, h("div", { class: "row" }, h("button", { class: "btn", type: "submit" }, "Save"), h("button", { class: "btn ghost", type: "button", onclick: close }, "Cancel"))));
      });
    }
    function batchBox(c, bt) {
      modal((b, close) => {
        const n = h("input", { id: "batch-name", value: bt ? bt.name : "", maxlength: 60, placeholder: "e.g. JP-2" });
        const l = h("select", { id: "batch-level" }, ["11", "12", "Dropper"].map(v => h("option", { value: v, selected: bt && bt.level === v }, LEVEL[v])));
        const y = h("input", { id: "batch-year", value: bt ? bt.year : "", maxlength: 20, placeholder: "e.g. 2026-27" });
        const err = h("p", { class: "err small" });
        b.append(h("form", { onsubmit: async e => { e.preventDefault();
            try { bt ? await PATCH(`/api/batches/${bt.id}`, { name: n.value, level: l.value, year: y.value }) : await POST("/api/batches", { campus_id: c.id, name: n.value, level: l.value, year: y.value }); close(); act(async () => {}); }
            catch (x) { err.textContent = x.message; } }, style: "display:grid;gap:12px" },
          h("h2", {}, bt ? `Edit batch` : `New batch in ${c.name}`), field("Batch name", n), field("Class", l), field("Academic year", y, "Optional"), err,
          h("div", { class: "row" }, h("button", { class: "btn", type: "submit" }, "Save"),
            bt ? h("button", { class: "btn danger", type: "button", onclick: () => { close(); confirmBox(`Remove batch ${bt.name}?`, "Remove", () => act(() => DEL(`/api/batches/${bt.id}`))); } }, "Remove") : null,
            h("button", { class: "btn ghost", type: "button", onclick: close }, "Cancel"))));
      });
    }
    show(view, h("div", { class: "head" }, h("div", {}, h("h1", {}, central ? "Zones, campuses & batches" : "Campuses & batches"),
      h("p", { class: "sub" }, "Batches are 11th, 12th or Dropper groups inside a campus. Click a batch to see its students.")),
      central ? h("button", { class: "btn gold", type: "button", onclick: () => nameBox("New zone", "", n => POST("/api/zones", { name: n })) }, "Add zone") : null), tree);
    draw();
  }, ["central", "zone", "campus"]);

  // ================================================================ students
  function placeFilters(onChange, init = {}) {
    const s = state.s, me = state.me;
    const zs = h("select", { id: "f-zone", "aria-label": "Zone" }, h("option", { value: "" }, "All zones"), s.zones.map(z => h("option", { value: z.id, selected: String(init.zone) === String(z.id) }, z.name)));
    const cs = h("select", { id: "f-campus", "aria-label": "Campus" });
    const bs = h("select", { id: "f-batch", "aria-label": "Batch" });
    const fill = () => {
      const zv = zs.value, cv = cs.value || String(init.campus || ""), bv = bs.value || String(init.batch || "");
      const campuses = s.campuses.filter(c => !zv || String(c.zone_id) === zv);
      cs.replaceChildren(h("option", { value: "" }, "All campuses"), campuses.map(c => h("option", { value: c.id, selected: String(c.id) === cv }, c.name)));
      const batches = s.batches.filter(b => (cs.value ? String(b.campus_id) === cs.value : campuses.some(c => c.id === b.campus_id)));
      bs.replaceChildren(h("option", { value: "" }, "All batches"), batches.map(b => h("option", { value: b.id, selected: String(b.id) === bv }, `${b.name} · ${LEVEL[b.level]}${cs.value ? "" : " · " + campusName(b.campus_id)}`)));
      init = {};
    };
    if (init.batch) { const b = batchOf(Number(init.batch)); if (b) { init.campus = b.campus_id; const c = s.campuses.find(x => x.id === b.campus_id); if (c) zs.value = c.zone_id; } }
    fill();
    zs.onchange = () => { cs.value = ""; bs.value = ""; fill(); onChange(); };
    cs.onchange = () => { bs.value = ""; fill(); onChange(); };
    bs.onchange = onChange;
    const els = [me.role === "central" ? zs : null, me.role !== "campus" ? cs : null, bs].filter(Boolean);
    return { els, get: () => ({ zone: zs.value, campus: cs.value, batch: bs.value }) };
  }
  route(/^\/students(?:\?batch=(\d+))?$/, async (view, batch) => {
    await structure(true);
    const central = state.me.role === "central";
    const q = h("input", { id: "f-q", placeholder: "Search name, roll or username", "aria-label": "Search" });
    const body = h("tbody");
    const count = h("span", { class: "muted small" });
    let rows = [];
    const filters = placeFilters(load, { batch });
    let t;
    q.oninput = () => { clearTimeout(t); t = setTimeout(load, 250); };
    async function load() {
      const f = filters.get();
      const p = new URLSearchParams(Object.entries({ ...f, q: q.value }).filter(([, v]) => v));
      rows = await GET("/api/students?" + p);
      count.textContent = `${rows.length} student${rows.length === 1 ? "" : "s"}`;
      body.replaceChildren(...(rows.length ? rows.map(s => h("tr", {},
        h("td", { class: "mono" }, s.roll), h("td", {}, s.name), h("td", { class: "mono" }, s.username), h("td", {}, batchLabel(s.batch_id)),
        h("td", {}, campusName(s.campus_id)), h("td", {}, h("span", { class: "pill " + (s.active ? "ok" : "bad") }, s.active ? "Active" : "Off")),
        h("td", {}, central ? h("button", { class: "btn small ghost", type: "button", onclick: () => studentBox(s) }, "Edit") : null)))
        : [h("tr", {}, h("td", { colspan: 7, class: "empty" }, central ? "No students here yet. Add them one by one or import an Excel sheet." : "No students here yet."))]));
    }
    function studentBox(s) {
      modal((b, close) => {
        const roll = h("input", { id: "st-roll", value: s ? s.roll : "", inputmode: "numeric", maxlength: 8 });
        const name = h("input", { id: "st-name", value: s ? s.name : "", maxlength: 80 });
        const user = h("input", { id: "st-user", value: s ? s.username : "", maxlength: 40, placeholder: "Same as roll number if left empty" });
        const pass = h("input", { id: "st-pass", value: "", placeholder: s ? "Leave empty to keep the current password" : "At least 6 characters" });
        const bsel = h("select", { id: "st-batch" }, state.s.batches.map(x => h("option", { value: x.id, selected: s ? s.batch_id === x.id : String(filters.get().batch) === String(x.id) }, batchFull(x.id) + ` (${LEVEL[x.level]})`)));
        const err = h("p", { class: "err small" });
        b.append(h("form", { style: "display:grid;gap:12px", onsubmit: async e => {
          e.preventDefault();
          try {
            if (s) {
              const body = { name: name.value, roll: roll.value, username: user.value || roll.value, batch_id: Number(bsel.value) };
              if (pass.value) body.password = pass.value;
              await PATCH(`/api/users/${s.id}`, body);
            } else await POST("/api/students", { roll: roll.value, name: name.value, username: user.value, password: pass.value, batch_id: Number(bsel.value) });
            close(); toast(s ? "Saved" : "Student added"); load();
          } catch (x) { err.textContent = x.message; }
        } }, h("h2", {}, s ? `Edit ${s.name || s.roll}` : "Add student"), h("div", { class: "row" }, field("Roll number", roll), field("Name", name)),
          field("Batch", bsel), h("div", { class: "row" }, field("Username", user), field("Password", pass)), err,
          h("div", { class: "row" }, h("button", { class: "btn", type: "submit" }, "Save"),
            s ? h("button", { class: "btn ghost", type: "button", onclick: async () => { await PATCH(`/api/users/${s.id}`, { active: !s.active }); close(); load(); } }, s.active ? "Turn off login" : "Turn on login") : null,
            h("button", { class: "btn ghost", type: "button", onclick: close }, "Cancel"))));
      });
    }
    show(view, 
      h("div", { class: "head" }, h("div", {}, h("h1", {}, "Students"), h("p", { class: "sub" }, central ? "Students log in with the username and password you set here." : "Student accounts are created by the central team.")),
        central ? h("div", { class: "row" }, h("button", { class: "btn ghost", type: "button", onclick: () => importBox(load) }, "Import from Excel"),
          h("button", { class: "btn gold", type: "button", onclick: () => studentBox(null) }, "Add student")) : null),
      h("div", { class: "card" }, h("div", { class: "row" }, filters.els, q), count,
        h("div", { class: "tablebox" }, h("table", {}, h("thead", {}, h("tr", {}, ["Roll no.", "Name", "Username", "Batch", "Campus", "Login", ""].map(t => h("th", {}, t)))), body))));
    load();
  }, ["central", "zone", "campus"]);

  // ---- Excel import
  function importBox(after) {
    modal((b, close) => {
      const out = h("div", { style: "display:grid;gap:10px" });
      const fileIn = h("input", { id: "xl-file", type: "file", accept: ".xlsx,.xls,.csv" });
      const tmpl = h("button", { class: "link", type: "button", onclick: async () => {
        try { await need("xlsx"); } catch (x) { toast(x.message); return; }
        const ws = XLSX.utils.aoa_to_sheet([["roll", "name", "zone", "campus", "batch", "username", "password"], ["2601001", "Aarav Sharma", "Madhapur", "Madhapur Main", "JP-2", "", ""]]);
        const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Students");
        download("students_template.xlsx", new Blob([XLSX.write(wb, { type: "array", bookType: "xlsx" })], { type: "application/octet-stream" }));
      } }, "Download the Excel template");
      fileIn.onchange = async () => {
        out.replaceChildren(h("p", { class: "muted" }, "Reading file…"));
        try {
          await need("xlsx");
          const wb = XLSX.read(await fileIn.files[0].arrayBuffer());
          const sheetRows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "", raw: false });
          const norm = k => String(k).toLowerCase().replace(/[^a-z]/g, "");
          const rows = sheetRows.map((r, i) => {
            const o = { row: i + 2 }; for (const k in r) o[norm(k)] = String(r[k]).trim();
            return o;
          }).filter(r => r.roll || r.rollno || r.rollnumber || r.name);
          const findBatch = r => {
            const bn = (r.batch || "").toLowerCase(), cn = (r.campus || "").toLowerCase(), zn = (r.zone || "").toLowerCase();
            const m = state.s.batches.filter(bt => bt.name.toLowerCase() === bn && (!cn || campusName(bt.campus_id).toLowerCase() === cn)
              && (!zn || zoneName((state.s.campuses.find(c => c.id === bt.campus_id) || {}).zone_id).toLowerCase() === zn));
            return m.length === 1 ? m[0].id : null;
          };
          const prepared = rows.map(r => ({ row: r.row, roll: r.roll || r.rollno || r.rollnumber, name: r.name || r.studentname, username: r.username, password: r.password,
            batch_id: findBatch(r), _batch: r.batch, _campus: r.campus }));
          const unknown = prepared.filter(p => !p.batch_id);
          out.replaceChildren(h("p", {}, `${prepared.length} students found in the file.`));
          if (unknown.length) {
            out.append(h("p", { class: "err" }, `${unknown.length} row(s) don't match a batch in the portal. Check the zone, campus and batch names (rows ${unknown.slice(0, 8).map(u => u.row).join(", ")}${unknown.length > 8 ? "…" : ""}).`));
            return;
          }
          out.append(h("button", { class: "btn gold", type: "button", onclick: async e => {
            e.target.disabled = true; e.target.textContent = "Creating accounts…";
            try {
              const res = await POST("/api/students/bulk", { rows: prepared });
              if (!res.ok) {
                out.replaceChildren(h("p", { class: "err" }, "Nothing was imported. Fix these rows and try again:"),
                  h("div", { class: "tablebox" }, h("table", {}, h("tbody", {}, res.errors.slice(0, 200).map(x => h("tr", {}, h("td", {}, `Row ${x.row}`), h("td", { class: "wrap" }, x.error)))))));
                return;
              }
              out.replaceChildren(h("p", {}, `${res.created.length} student accounts created.`),
                h("p", { class: "small muted" }, "Download the login list now. Passwords that were left empty in the file were generated, and they can't be shown again."),
                h("button", { class: "btn", type: "button", onclick: () => download("student_logins.csv", csv([["roll", "name", "username", "password"], ...res.created.map(c => [c.roll, c.name, c.username, c.password])])) }, "Download login list"));
              after && after();
            } catch (x) { out.append(h("p", { class: "err" }, x.message)); e.target.disabled = false; e.target.textContent = "Create accounts"; }
          } }, `Create ${prepared.length} accounts`));
        } catch (x) { out.replaceChildren(h("p", { class: "err" }, "Could not read this file: " + x.message)); }
      };
      b.append(h("h2", {}, "Import students from Excel"),
        h("p", { class: "small" }, "Columns: roll, name, zone, campus, batch, and optionally username and password. Zone, campus and batch names must match the portal. Username defaults to the roll number; empty passwords are generated."),
        tmpl, field("Excel or CSV file", fileIn), out, h("div", { class: "row" }, h("button", { class: "btn ghost", type: "button", onclick: close }, "Close")));
    });
  }

  // ================================================================ admins
  route(/^\/admins$/, async view => {
    await structure(true);
    const list = await GET("/api/admins");
    const placeOf = a => a.role === "zone" ? zoneName(a.zone_id) + " zone" : a.role === "campus" ? campusName(a.campus_id) : "All zones";
    function adminBox(a) {
      modal((b, close) => {
        const role = h("select", { id: "ad-role", disabled: !!a }, ["central", "zone", "campus"].map(r => h("option", { value: r, selected: a && a.role === r }, ROLE[r])));
        const zone = h("select", { id: "ad-zone" }, state.s.zones.map(z => h("option", { value: z.id, selected: a && a.zone_id === z.id }, z.name)));
        const camp = h("select", { id: "ad-campus" }, state.s.campuses.map(c => h("option", { value: c.id, selected: a && a.campus_id === c.id }, `${c.name} (${zoneName(c.zone_id)})`)));
        const zf = field("Zone", zone), cf = field("Campus", camp);
        const sync = () => { zf.hidden = role.value !== "zone" || !!a; cf.hidden = role.value !== "campus" || !!a; };
        role.onchange = sync;
        const name = h("input", { id: "ad-name", value: a ? a.name : "", maxlength: 80 });
        const user = h("input", { id: "ad-user", value: a ? a.username : "", maxlength: 40 });
        const pass = h("input", { id: "ad-pass", placeholder: a ? "Leave empty to keep" : "At least 6 characters" });
        const err = h("p", { class: "err small" });
        b.append(h("form", { style: "display:grid;gap:12px", onsubmit: async e => {
          e.preventDefault();
          try {
            if (a) { const body = { name: name.value, username: user.value }; if (pass.value) body.password = pass.value; await PATCH(`/api/users/${a.id}`, body); }
            else await POST("/api/admins", { role: role.value, zone_id: Number(zone.value), campus_id: Number(camp.value), name: name.value, username: user.value, password: pass.value });
            close(); render();
          } catch (x) { err.textContent = x.message; }
        } }, h("h2", {}, a ? `Edit ${a.name || a.username}` : "Add admin"), field("Level", role, "Central sees everything; zone sees its campuses; campus sees one campus."), zf, cf,
          field("Name", name), h("div", { class: "row" }, field("Username", user), field("Password", pass)), err,
          h("div", { class: "row" }, h("button", { class: "btn", type: "submit" }, "Save"),
            a && a.id !== state.me.id ? h("button", { class: "btn ghost", type: "button", onclick: async () => { await PATCH(`/api/users/${a.id}`, { active: !a.active }); close(); render(); } }, a.active ? "Turn off login" : "Turn on login") : null,
            h("button", { class: "btn ghost", type: "button", onclick: close }, "Cancel"))));
        sync();
      });
    }
    show(view, h("div", { class: "head" }, h("div", {}, h("h1", {}, "Admins"), h("p", { class: "sub" }, "Central team, zone heads and campus heads.")),
      h("button", { class: "btn gold", type: "button", onclick: () => adminBox(null) }, "Add admin")),
      h("div", { class: "card" }, h("div", { class: "tablebox" }, h("table", {}, h("thead", {}, h("tr", {}, ["Name", "Username", "Level", "Sees", "Login", ""].map(t => h("th", {}, t)))),
        h("tbody", {}, list.map(a => h("tr", {}, h("td", {}, a.name), h("td", { class: "mono" }, a.username), h("td", {}, ROLE[a.role]), h("td", {}, placeOf(a)),
          h("td", {}, h("span", { class: "pill " + (a.active ? "ok" : "bad") }, a.active ? "Active" : "Off")),
          h("td", {}, h("button", { class: "btn small ghost", type: "button", onclick: () => adminBox(a) }, "Edit")))))))));
  }, ["central"]);

  // ================================================================ question bank
  const QT = { single: "Single correct", multi: "One or more correct", integer: "Integer", decimal: "Decimal" };
  route(/^\/bank$/, async view => {
    const subj = h("select", { id: "qb-subject", "aria-label": "Subject" }), chap = h("select", { id: "qb-chapter", "aria-label": "Chapter" });
    const typ = h("select", { id: "qb-type", "aria-label": "Type" }, h("option", { value: "" }, "All types"), Object.entries(QT).map(([k, v]) => h("option", { value: k }, v)));
    const dif = h("select", { id: "qb-diff", "aria-label": "Difficulty" }, h("option", { value: "" }, "Any difficulty"), ["Easy", "Medium", "Hard"].map(d => h("option", {}, d)));
    const q = h("input", { id: "qb-q", placeholder: "Search text, chapter or topic", "aria-label": "Search" });
    const list = h("div"), count = h("span", { class: "muted small" });
    let first = true, t;
    async function load() {
      const p = new URLSearchParams(Object.entries({ subject: subj.value, chapter: chap.value, qtype: typ.value, difficulty: dif.value, q: q.value }).filter(([, v]) => v));
      const r = await GET("/api/questions?" + p);
      if (first) { first = false; }
      const sv = subj.value, cv = chap.value;
      subj.replaceChildren(h("option", { value: "" }, "All subjects"), r.facets.subjects.map(s => h("option", { selected: s === sv }, s)));
      chap.replaceChildren(h("option", { value: "" }, "All chapters"), r.facets.chapters.filter(c => !sv || c.subject === sv).map(c => h("option", { selected: c.chapter === cv }, c.chapter)));
      count.textContent = `${r.rows.length} shown · ${r.total} in the bank`;
      list.replaceChildren(r.rows.length ? h("div", { class: "tablebox" }, h("table", {}, h("thead", {}, h("tr", {}, ["#", "Subject", "Chapter", "Type", "Level", "Question", "Answer"].map(x => h("th", {}, x)))),
        h("tbody", {}, r.rows.map(x => h("tr", { tabindex: 0, onclick: () => (location.hash = `#/bank/${x.id}`), onkeydown: e => e.key === "Enter" && (location.hash = `#/bank/${x.id}`) },
          h("td", { class: "mono" }, x.id), h("td", {}, x.subject), h("td", {}, x.chapter), h("td", {}, QT[x.qtype]), h("td", {}, x.difficulty),
          h("td", { class: "wrap" }, (x.text || "").slice(0, 140) || (x.has_image ? "[image]" : "")), h("td", { class: "mono" }, x.answer))))))
        : h("p", { class: "empty" }, r.total ? "No questions match these filters." : "The question bank is empty. Add the first question."));
    }
    [subj, chap, typ, dif].forEach(s => (s.onchange = load));
    q.oninput = () => { clearTimeout(t); t = setTimeout(load, 250); };
    show(view, h("div", { class: "head" }, h("div", {}, h("h1", {}, "Question bank"), h("p", { class: "sub" }, "Questions here can be attached to a test, and their answers fill the answer key.")),
      h("a", { class: "btn gold", href: "#/bank/new" }, "Add question")),
      h("div", { class: "card" }, h("div", { class: "row" }, subj, chap, typ, dif, q), count, list));
    load();
  }, ["central"]);

  route(/^\/bank\/(new|\d+)$/, async (view, id) => {
    const isNew = id === "new";
    const qd = isNew ? { subject: "Physics", chapter: "", topic: "", qtype: "single", difficulty: "Medium", text: "", image: "", options: ["", "", "", ""], answer: "", solution: "" } : await GET(`/api/questions/${id}`);
    const subject = h("input", { id: "q-subject", value: qd.subject, list: "subj-list", maxlength: 40 });
    const chapter = h("input", { id: "q-chapter", value: qd.chapter, maxlength: 120 });
    const topic = h("input", { id: "q-topic", value: qd.topic, maxlength: 120 });
    const qtype = h("select", { id: "q-type" }, Object.entries(QT).map(([k, v]) => h("option", { value: k, selected: qd.qtype === k }, v)));
    const diff = h("select", { id: "q-diff" }, ["Easy", "Medium", "Hard"].map(d => h("option", { selected: qd.difficulty === d }, d)));
    const text = h("textarea", { id: "q-text", rows: 6 }, qd.text);
    let image = qd.image || "";
    const imgPrev = h("img", { alt: "Question image", style: "max-width:100%;border-radius:4px" });
    const imgIn = h("input", { id: "q-img", type: "file", accept: "image/png,image/jpeg,image/webp,image/gif" });
    const rmImg = h("button", { class: "btn small ghost", type: "button", onclick: () => { image = ""; showImg(); } }, "Remove image");
    const showImg = () => { imgPrev.hidden = !image; rmImg.hidden = !image; if (image) imgPrev.src = image; };
    imgIn.onchange = () => {
      const f = imgIn.files[0]; if (!f) return;
      if (f.size > 2_000_000) { toast("Image must be under 2 MB"); return; }
      const r = new FileReader(); r.onload = () => { image = r.result; showImg(); }; r.readAsDataURL(f);
    };
    const opts = ["A", "B", "C", "D"].map((L, i) => h("input", { id: `q-opt-${L}`, value: (qd.options || [])[i] || "", placeholder: `Option ${L}` }));
    const optBox = h("div", { style: "display:grid;gap:6px" }, opts.map((o, i) => h("label", { class: "f" }, `Option ${"ABCD"[i]}`, o)));
    const answer = h("input", { id: "q-answer", value: qd.answer, class: "mono", maxlength: 30 });
    const ansHint = h("span", { class: "h" });
    const solution = h("textarea", { id: "q-solution", rows: 4 }, qd.solution || "");
    const err = h("p", { class: "err small" });
    const sync = () => {
      const mc = qtype.value === "single" || qtype.value === "multi";
      optBox.hidden = !mc;
      ansHint.textContent = qtype.value === "single" ? "One letter, e.g. B" : qtype.value === "multi" ? "Letters, e.g. AC" : "A number, e.g. 12 or 4.25, or a range 4.2:4.3";
    };
    qtype.onchange = sync;
    show(view, h("div", { class: "head" }, h("div", {}, h("a", { href: "#/bank" }, "‹ Question bank"), h("h1", {}, isNew ? "New question" : `Question ${id}`))),
      h("form", { class: "card", onsubmit: async e => {
        e.preventDefault(); err.textContent = "";
        const body = { subject: subject.value, chapter: chapter.value, topic: topic.value, qtype: qtype.value, difficulty: diff.value, text: text.value, image, options: opts.map(o => o.value), answer: answer.value, solution: solution.value };
        try { if (isNew) { const r = await POST("/api/questions", body); toast("Question saved"); location.hash = `#/bank/${r.id}`; } else { await PUT(`/api/questions/${id}`, body); toast("Saved"); } }
        catch (x) { err.textContent = x.message; }
      } },
        h("datalist", { id: "subj-list" }, ["Physics", "Chemistry", "Mathematics", "Botany", "Zoology"].map(s => h("option", { value: s }))),
        h("div", { class: "row" }, field("Subject", subject), field("Chapter", chapter), field("Topic", topic, "Optional")),
        h("div", { class: "row" }, field("Question type", qtype), field("Difficulty", diff)),
        field("Question", text, "Type the question, or add an image of it below (or both)."),
        h("div", { class: "row" }, field("Question image", imgIn, "PNG or JPG, up to 2 MB"), rmImg), imgPrev,
        optBox, h("label", { class: "f" }, "Correct answer", ansHint, answer), field("Solution", solution, "Optional. Shown to students after results are published."), err,
        h("div", { class: "row" }, h("button", { class: "btn", type: "submit" }, "Save question"),
          !isNew ? h("button", { class: "btn danger", type: "button", onclick: () => confirmBox("Delete this question?", "Delete", async () => { try { await DEL(`/api/questions/${id}`); location.hash = "#/bank"; } catch (x) { toast(x.message); } }) }, "Delete") : null)));
    sync(); showImg();
  }, ["central"]);

  // ================================================================ tests
  route(/^\/tests$/, async view => {
    const tests = await GET("/api/tests");
    show(view, h("div", { class: "head" }, h("div", {}, h("h1", {}, "Tests"), h("p", { class: "sub" }, "Each test has an OMR sheet type, the batches that write it, and an answer key.")),
      state.me.role === "central" ? h("a", { class: "btn gold", href: "#/tests/new" }, "New test") : null), h("div", { class: "card" }, testsTable(tests)));
  }, ["central", "zone", "campus"]);

  const SHEETS = [["JM", "JEE Main · full (75)"], ["JMP", "JEE Main · physics (25)"], ["RJM", "Classic JEE Main (75)"], ["JA", "JEE Advanced · full (51)"], ["JAP", "JEE Advanced · physics (17)"],
    ["NEET", "NEET · full (180)"], ["NEETP", "NEET · physics (45)"], ["R180", "Classic EAPCET (180, options 1–4)"], ["DR30", "Formula drill (30)"]];
  route(/^\/tests\/(new|\d+)\/edit$|^\/tests\/(new)$/, async (view, a, b) => {
    const id = a || b, isNew = id === "new";
    await structure(true);
    const t = isNew ? { code: "", name: "", test_date: new Date().toISOString().slice(0, 10), sheet: "JM", batch_ids: [] } : await GET(`/api/tests/${id}`);
    const code = h("input", { id: "t-code", value: t.code, maxlength: 16, class: "mono", placeholder: "e.g. WT12" });
    const name = h("input", { id: "t-name", value: t.name, maxlength: 100, placeholder: "e.g. Weekly Test 12" });
    const date = h("input", { id: "t-date", type: "date", value: t.test_date });
    const sheet = h("select", { id: "t-sheet" }, SHEETS.map(([k, v]) => h("option", { value: k, selected: t.sheet === k }, v)));
    const chosen = new Set(t.batch_ids);
    const levelFilter = h("select", { id: "t-level", "aria-label": "Select by class" }, h("option", { value: "" }, "Tick all of a class…"), ["11", "12", "Dropper"].map(l => h("option", { value: l }, `All ${LEVEL[l]} batches`)));
    const checks = h("div", { class: "checks" });
    const drawChecks = () => checks.replaceChildren(...state.s.batches.map(bt => h("label", {}, h("input", { type: "checkbox", checked: chosen.has(bt.id), onchange: e => { e.target.checked ? chosen.add(bt.id) : chosen.delete(bt.id); } }),
      `${bt.name} · ${LEVEL[bt.level]} · ${campusName(bt.campus_id)}`)));
    levelFilter.onchange = () => { state.s.batches.filter(bt => bt.level === levelFilter.value).forEach(bt => chosen.add(bt.id)); levelFilter.value = ""; drawChecks(); };
    drawChecks();
    const err = h("p", { class: "err small" });
    show(view, h("div", { class: "head" }, h("div", {}, h("a", { href: isNew ? "#/tests" : `#/tests/${id}` }, "‹ Back"), h("h1", {}, isNew ? "New test" : "Edit test"))),
      h("form", { class: "card", onsubmit: async e => {
        e.preventDefault(); err.textContent = "";
        const body = { code: code.value, name: name.value, test_date: date.value, sheet: sheet.value, batch_ids: [...chosen] };
        try { const r = isNew ? await POST("/api/tests", body) : await PUT(`/api/tests/${id}`, body); location.hash = `#/tests/${isNew ? r.id : id}`; }
        catch (x) { err.textContent = x.message; }
      } }, h("div", { class: "row" }, field("Test code", code, "Short, printed in the QR of every sheet"), field("Test name", name), field("Date", date)),
        field("OMR sheet type", sheet, "Sets the question pattern and marking scheme."),
        h("div", { class: "row" }, h("h3", { class: "shrink" }, "Batches writing this test"), levelFilter), checks, err,
        h("div", { class: "row" }, h("button", { class: "btn", type: "submit" }, isNew ? "Create test" : "Save"),
          !isNew ? h("button", { class: "btn danger", type: "button", onclick: () => confirmBox("Delete this test and all its results?", "Delete", async () => { await DEL(`/api/tests/${id}`); location.hash = "#/tests"; }) }, "Delete test") : null)));
  }, ["central"]);

  route(/^\/tests\/(\d+)(?:\/(key|sheets|scans|results))?$/, async (view, id, tab = "results") => {
    await structure();
    const t = await GET(`/api/tests/${id}`);
    const layout = O.getLayout(t.sheet);
    const central = state.me.role === "central";
    const tabs = [["results", "Results"], ["sheets", "Print sheets"], ["scans", "Upload scans"], ...(central ? [["key", "Answer key"]] : [])];
    const body = h("div", { style: "display:grid;gap:16px" });
    show(view, 
      h("div", { class: "head" }, h("div", {}, h("a", { href: "#/tests" }, "‹ Tests"), h("h1", {}, `${t.name}`),
        h("p", { class: "sub" }, `${t.code} · ${fmtDate(t.test_date)} · ${t.sheet_title} · ${t.questions} questions · ${t.batch_ids.length} batch${t.batch_ids.length === 1 ? "" : "es"}`)),
        h("div", { class: "row" }, h("span", { class: "pill " + (t.published ? "ok" : "warn") }, t.published ? "Published to students" : "Not published yet"),
          central ? h("a", { class: "btn ghost small", href: `#/tests/${id}/edit` }, "Edit") : null)),
      h("div", { class: "tabs" }, tabs.map(([k, v]) => h("a", { href: `#/tests/${id}/${k}`, class: k === tab ? "on" : "" }, v))), body);
    if (tab === "key" && central) return keyTab(body, t, layout);
    if (tab === "sheets") return sheetsTab(body, t, layout);
    if (tab === "scans") return scansTab(body, t, layout);
    return resultsTab(body, t, layout);
  }, ["central", "zone", "campus"]);

  // ---- answer key
  async function keyTab(body, t, layout) {
    const idx = O.questionIndex(layout);
    const inputs = {};
    const grid = h("div", { class: "keygrid" });
    let lastSec = -1;
    for (const { qno, si, sec } of idx) {
      if (si !== lastSec) { grid.append(h("h3", { style: "grid-column:1/-1;margin-top:6px" }, `${sec.name}`)); lastSec = si; }
      const i = h("input", { id: `k-${qno}`, value: t.answer_key[qno] || "", class: "mono", maxlength: 12, "aria-label": `Answer for question ${qno}` });
      inputs[qno] = i;
      grid.append(h("label", {}, h("span", {}, qno), i));
    }
    const paste = h("textarea", { id: "key-paste", rows: 4, class: "mono", placeholder: "Or paste lines like:\n1,B\n2,D\n21,12" });
    paste.oninput = () => { const k = O.parseKey(paste.value)["*"] || {}; for (const q in k) if (inputs[q]) inputs[q].value = k[q]; };
    const msg = h("span", { class: "small muted" });
    const pub = h("button", { class: "btn " + (t.published ? "ghost" : "gold"), type: "button", onclick: async () => { await POST(`/api/tests/${t.id}/publish`, { published: !t.published }); render(); } }, t.published ? "Hide results from students" : "Publish results to students");
    body.append(h("div", { class: "card" }, h("h2", {}, "Answer key"),
      h("p", { class: "small" }, `${layout.sections[0].options === "1234" ? "Options 1–4 (A–D also works)" : "Letters A–D"} for choice questions, AC for one-or-more, numbers for numerical (a range like 4.5:4.6 is allowed). * gives everyone full marks, X drops the question. Changing the key re-marks everyone instantly.`),
      grid, paste, h("div", { class: "row" }, h("button", { class: "btn", type: "button", onclick: async () => {
        const key = {}; for (const q in inputs) if (inputs[q].value.trim()) key[q] = inputs[q].value.trim();
        try { const r = await PUT(`/api/tests/${t.id}/key`, { key }); msg.textContent = `Saved · ${r.count} of ${idx.length} answers`; toast("Answer key saved"); } catch (x) { toast(x.message); }
      } }, "Save answer key"), msg)),
      h("div", { class: "card" }, h("h2", {}, "Publish"), h("p", { class: "small" }, "Students see their marks, ranks and question-wise review only after you publish. You can keep reading more sheets after publishing; new results appear straight away."), h("div", {}, pub)),
      await linkCard(t, layout));
  }
  async function linkCard(t, layout) {
    const links = Object.fromEntries(t.linked.map(l => [l.qno, l.id]));
    const box = h("div", { style: "display:grid;gap:8px" });
    const ids = h("textarea", { id: "link-ids", rows: 3, class: "mono", placeholder: "One per line: question number, bank question id\n1,104\n2,87" },
      Object.entries(links).map(([q, i]) => `${q},${i}`).join("\n"));
    box.append(h("h2", {}, "Questions from the bank (optional)"),
      h("p", { class: "small" }, "Link bank questions to question numbers so students can see the question and solution in their review. Their answers fill the key automatically. Find ids in the Question bank."),
      ids, h("div", {}, h("button", { class: "btn ghost", type: "button", onclick: async () => {
        const map = {}; ids.value.split(/\r?\n/).forEach(l => { const [q, i] = l.split(/[,\s]+/); if (+q && +i) map[+q] = +i; });
        try { await PUT(`/api/tests/${t.id}/questions`, { links: map }); toast("Linked"); render(); } catch (x) { toast(x.message); }
      } }, "Save links")));
    return h("div", { class: "card" }, box);
  }

  // ---- print sheets
  async function sheetsTab(body, t, layout) {
    const [roster] = await Promise.all([GET(`/api/tests/${t.id}/roster`), need("qrcode", "jspdf")]);
    const byBatch = {};
    roster.forEach(s => (byBatch[s.batch_id] = byBatch[s.batch_id] || []).push(s));
    const rows = Object.entries(byBatch).map(([bid, list]) => h("tr", {},
      h("td", {}, batchFull(Number(bid))), h("td", {}, LEVEL[(batchOf(Number(bid)) || {}).level] || ""), h("td", { class: "num" }, list.length),
      h("td", {}, h("button", { class: "btn small", type: "button", onclick: e => makePdf(e.target, list, `OMR_${t.code}_${(batchOf(Number(bid)) || {}).name || bid}.pdf`) }, "Download PDF"))));
    const blank = h("input", { id: "blank-n", type: "number", min: 1, max: 2000, value: 20, style: "max-width:120px" });
    async function makePdf(btn, list, name) {
      const old = btn.textContent; btn.disabled = true; btn.textContent = "Making PDF…";
      await new Promise(r => setTimeout(r, 30));
      try {
        const doc = SH.sheetsPdf(layout, { code: t.code, name: t.name }, list.map(s => ({ roll: s.roll, name: s.name, paper: "" })));
        download(name, doc.output("blob"));
      } catch (x) { toast(x.message); }
      btn.disabled = false; btn.textContent = old;
    }
    const prev = h("div", { style: "background:#fff;border-radius:4px;box-shadow:0 1px 3px rgba(0,0,0,.15);aspect-ratio:210/297;overflow:hidden", html: SH.sheetSvg(layout, { code: t.code, name: t.name }, roster[0] || {}) });
    prev.firstChild && prev.firstChild.setAttribute("style", "width:100%;height:100%;display:block");
    body.append(h("div", { class: "grid2" },
      h("div", { class: "card" }, h("h2", {}, "Personalised sheets"),
        h("p", { class: "small" }, "One sheet per student with name, roll number and a QR code, in roll-number order. Print at Actual size on A4."),
        roster.length ? h("div", { class: "tablebox" }, h("table", {}, h("thead", {}, h("tr", {}, ["Batch", "Class", "Students", ""].map(x => h("th", {}, x)))), h("tbody", {}, rows)))
          : h("p", { class: "empty" }, "No students in this test's batches yet."),
        roster.length ? h("div", {}, h("button", { class: "btn gold", type: "button", onclick: e => makePdf(e.target, roster, `OMR_${t.code}_all.pdf`) }, `All ${roster.length} sheets in one PDF`)) : null,
        h("h2", {}, "Blank sheets"), h("p", { class: "small" }, "For students without a printed sheet. They write and bubble their roll number."),
        h("div", { class: "row" }, field("How many", blank), h("button", { class: "btn ghost", type: "button", onclick: e => makePdf(e.target, Array.from({ length: Math.min(2000, +blank.value || 0) }, () => ({})), `OMR_${t.code}_blank.pdf`) }, "Download blank PDF"))),
      h("div", { class: "card" }, h("h3", {}, "Preview"), prev)));
  }

  // ---- upload scans (reads in the browser, then saves answers to the server)
  async function scansTab(body, t, layout) {
    const [roster] = await Promise.all([GET(`/api/tests/${t.id}/roster`), need("jsqr", "jszip", "pdf", "pdfworker")]);
    const rosterRoll = new Map(roster.map(s => [s.roll.replace(/^0+/, ""), s]));
    const st = { pages: [], rows: [], failed: [], reading: false, sel: null, filter: "all" };
    const fileIn = h("input", { id: "scan-files", type: "file", multiple: true, accept: ".zip,.pdf,image/*" });
    const drop = h("div", { class: "drop" }, h("b", {}, "Drop scans here: one ZIP, scanner PDFs or photos"),
      h("p", { class: "small muted" }, "Sheets are read on this computer. Only the answers are sent to the portal when you press Save."),
      h("span", { class: "btn filepick" }, "Choose files", fileIn));
    const track = h("div", { class: "track" }, h("i")), ptext = h("span", { class: "small muted" });
    const prog = h("div", { style: "display:grid;gap:4px", hidden: true }, track, ptext);
    const stats = h("div", { class: "stats" });
    const tb = h("tbody");
    const filters = h("div", { class: "row" });
    const saveBtn = h("button", { class: "btn gold", type: "button" }, "Save to portal");
    const saveMsg = h("div", { class: "small" });
    const review = h("div", { class: "card", hidden: true });
    const split = h("div", { class: "split" }, h("div", { class: "card" }, filters, h("div", { class: "tablebox" }, h("table", {}, h("thead", {}, h("tr", {}, ["Roll no.", "Student", "Answered", "Status", ""].map(x => h("th", {}, x)))), tb)),
      h("div", { class: "row" }, saveBtn, saveMsg)), review);
    const resultsArea = h("div", { style: "display:grid;gap:16px", hidden: true }, stats, split);
    body.append(h("div", { class: "card" }, drop, prog), resultsArea);
    fileIn.onchange = () => { readFiles(fileIn.files); fileIn.value = ""; };
    ["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
    ["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
    drop.addEventListener("drop", e => readFiles(e.dataTransfer.files));

    const IMG = /\.(jpe?g|png|webp|bmp)$/i, PDF = /\.pdf$/i, ZIP = /\.zip$/i;
    const pdfDocs = new Map();
    function grayFromCanvas(cv) {
      const im = cv.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, cv.width, cv.height).data, d = new Uint8Array(cv.width * cv.height);
      for (let i = 0, j = 0; j < d.length; i += 4, j++) d[j] = (im[i] * 77 + im[i + 1] * 150 + im[i + 2] * 29) >> 8;
      return { w: cv.width, h: cv.height, d };
    }
    async function imgGray(blob) {
      const bmp = await createImageBitmap(blob), sc = Math.min(1, 2600 / Math.max(bmp.width, bmp.height));
      const cv = h("canvas"); cv.width = Math.round(bmp.width * sc); cv.height = Math.round(bmp.height * sc);
      const c = cv.getContext("2d", { willReadFrequently: true }); c.fillStyle = "#fff"; c.fillRect(0, 0, cv.width, cv.height); c.drawImage(bmp, 0, 0, cv.width, cv.height);
      bmp.close && bmp.close(); return grayFromCanvas(cv);
    }
    async function openPdf(file) { if (!pdfDocs.has(file)) pdfDocs.set(file, pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise); return pdfDocs.get(file); }
    async function pdfGray(file, n) {
      const page = await (await openPdf(file)).getPage(n), vp = page.getViewport({ scale: 150 / 72 });
      const cv = h("canvas"); cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
      const c = cv.getContext("2d", { willReadFrequently: true }); c.fillStyle = "#fff"; c.fillRect(0, 0, cv.width, cv.height);
      await page.render({ canvasContext: c, viewport: vp }).promise; page.cleanup(); return grayFromCanvas(cv);
    }
    const MIME = n => (/png$/i.test(n) ? "image/png" : /webp$/i.test(n) ? "image/webp" : "image/jpeg");
    const loadGray = async s => s.kind === "pdf" ? pdfGray(s.file, s.page) : s.kind === "zip" ? imgGray(new Blob([await s.entry.async("arraybuffer")], { type: MIME(s.entry.name) })) : imgGray(s.file);
    const opts = () => ({ jsQR: window.jsQR, getLayout: O.getLayout, fallbackLayout: t.sheet });

    async function readFiles(list) {
      if (st.reading) return;
      const files = [...list].filter(f => ZIP.test(f.name) || PDF.test(f.name) || IMG.test(f.name) || /^image\//.test(f.type));
      if (!files.length) { toast("Choose a ZIP, PDF, JPG or PNG file"); return; }
      st.reading = true; prog.hidden = false; track.firstChild.style.width = "0%";
      const srcs = [];
      const addPdf = async (f, label) => { try { const p = await openPdf(f); for (let i = 1; i <= p.numPages; i++) srcs.push({ kind: "pdf", file: f, page: i, label: `${label} p${i}` }); } catch (e) { st.pages.push({ ok: false, error: "PDF could not be opened", source: label }); } };
      for (const f of files) {
        if (ZIP.test(f.name)) {
          ptext.textContent = `Opening ${f.name}…`;
          try {
            const z = await JSZip.loadAsync(f);
            const ents = Object.values(z.files).filter(e => !e.dir && !/(^|\/)(__MACOSX|\.)/.test(e.name) && (IMG.test(e.name) || PDF.test(e.name))).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
            for (const e of ents) PDF.test(e.name) ? await addPdf(new File([await e.async("arraybuffer")], e.name.split("/").pop()), `${f.name} › ${e.name}`) : srcs.push({ kind: "zip", entry: e, label: `${f.name} › ${e.name}` });
          } catch (e) { st.pages.push({ ok: false, error: "ZIP could not be opened", source: f.name }); }
        } else if (PDF.test(f.name)) await addPdf(f, f.name);
        else srcs.push({ kind: "img", file: f, label: f.name });
      }
      const t0 = performance.now();
      for (let i = 0; i < srcs.length; i++) {
        let r;
        try { r = O.readPage(await loadGray(srcs[i]), opts()); } catch (e) { r = { ok: false, error: "page could not be read" }; }
        delete r.map; delete r.marks; r.source = srcs[i].label; r.src = srcs[i];
        if (r.ok && r.test && r.test !== t.code) { r.ok = false; r.error = `This sheet belongs to test ${r.test}, not ${t.code}.`; }
        st.pages.push(r);
        if (i % 3 === 0 || i === srcs.length - 1) {
          const el = (performance.now() - t0) / 1000, left = el / (i + 1) * (srcs.length - i - 1);
          track.firstChild.style.width = Math.round((i + 1) / srcs.length * 100) + "%";
          ptext.textContent = `Reading page ${i + 1} of ${srcs.length}` + (i > 4 ? ` · about ${left < 60 ? Math.ceil(left) + " s" : Math.ceil(left / 60) + " min"} left` : "");
          await new Promise(res => setTimeout(res, 0));
        }
      }
      st.reading = false; prog.hidden = true;
      rebuild();
    }
    function rebuild() {
      const prev = new Map(st.rows.map(r => [r.source, r]));
      const { rows, failed } = O.combine(st.pages, O.getLayout);
      for (const r of rows) {
        r.issues = r.issues.map(([q, msg]) => ({ q, msg, done: false }));
        if (!rosterRoll.has(String(r.roll).replace(/^0+/, ""))) r.issues.push({ q: "roll", msg: "no student with this roll number in this test's batches (for your campus)", done: false });
        const old = prev.get(r.source);
        if (old) { r.answers = old.answers; r.roll = old.roll; r.saved = old.saved; r.issues.forEach(i => { const o = old.issues.find(x => x.q === i.q && x.msg === i.msg); if (o) i.done = o.done; }); }
        r.status = r.issues.some(i => !i.done) ? "REVIEW" : "OK";
      }
      st.rows = rows; st.failed = failed;
      draw();
    }
    function draw() {
      resultsArea.hidden = !(st.rows.length + st.failed.length);
      const ok = st.rows.filter(r => r.status === "OK").length;
      stats.replaceChildren(h("div", { class: "stat" }, h("b", {}, st.rows.length), h("span", {}, "Sheets read")), h("div", { class: "stat ok" }, h("b", {}, ok), h("span", {}, "Clean")),
        h("div", { class: "stat warn" }, h("b", {}, st.rows.length - ok), h("span", {}, "To check")), h("div", { class: "stat" }, h("b", {}, st.failed.length), h("span", {}, "Pages to re-scan")),
        h("div", { class: "stat gold" }, h("b", {}, `${new Set(st.rows.map(r => r.roll.replace(/^0+/, ""))).size} / ${roster.length}`), h("span", {}, "Students covered")));
      filters.replaceChildren(...[["all", "All"], ["review", "To check"], ["ok", "Clean"], ["failed", "Re-scan"]].map(([k, v]) => h("button", { class: "btn small " + (st.filter === k ? "" : "ghost"), type: "button", onclick: () => { st.filter = k; draw(); } }, v)));
      tb.replaceChildren();
      if (st.filter === "failed") {
        st.failed.forEach(p => tb.append(h("tr", {}, h("td", { class: "mono", colspan: 2 }, p.source), h("td", { colspan: 3, class: "wrap" }, p.error))));
        if (!st.failed.length) tb.append(h("tr", {}, h("td", { colspan: 5, class: "empty" }, "Every page was read.")));
      } else {
        const list = st.rows.filter(r => st.filter === "all" || (st.filter === "review" ? r.status === "REVIEW" : r.status === "OK"));
        list.slice(0, 600).forEach(r => {
          const s = rosterRoll.get(String(r.roll).replace(/^0+/, ""));
          const open = r.issues.filter(i => !i.done).length;
          tb.append(h("tr", { tabindex: 0, class: st.sel === r ? "sel" : "", onclick: () => openReview(r), onkeydown: e => e.key === "Enter" && openReview(r) },
            h("td", { class: "mono" }, r.roll), h("td", {}, s ? s.name : "—"), h("td", { class: "num" }, `${Object.values(r.answers).filter(Boolean).length}/${O.totalQ(layout)}`),
            h("td", {}, r.saved ? h("span", { class: "pill navy" }, "Saved") : h("span", { class: "pill " + (r.status === "OK" ? "ok" : "warn") }, r.status === "OK" ? "OK" : `Check ${open}`)),
            h("td", { class: "small" }, "Open ›")));
        });
        if (!list.length) tb.append(h("tr", {}, h("td", { colspan: 5, class: "empty" }, "Nothing here.")));
      }
      const ready = st.rows.filter(r => r.status === "OK" && !r.saved);
      saveBtn.disabled = !ready.length;
      saveBtn.textContent = ready.length ? `Save ${ready.length} checked sheet${ready.length === 1 ? "" : "s"} to portal` : "Save to portal";
    }
    saveBtn.onclick = async () => {
      const ready = st.rows.filter(r => r.status === "OK" && !r.saved);
      saveBtn.disabled = true; saveMsg.textContent = "Saving…";
      try {
        let saved = 0; const rejected = [];
        for (let i = 0; i < ready.length; i += 300) {
          const chunk = ready.slice(i, i + 300);
          const res = await POST(`/api/tests/${t.id}/results`, { rows: chunk.map(r => ({ roll: r.roll, answers: r.answers, source: r.source })) });
          saved += res.saved; rejected.push(...res.rejected);
          const bad = new Set(res.rejected.map(x => String(x.roll)));
          chunk.forEach(r => { if (!bad.has(String(r.roll))) r.saved = true; });
        }
        saveMsg.replaceChildren(h("span", {}, `${saved} saved.`), rejected.length ? h("span", { class: "err" }, ` ${rejected.length} not saved: ${rejected.slice(0, 5).map(x => `${x.roll} (${x.error})`).join("; ")}`) : "");
        toast(`${saved} sheets saved`);
      } catch (x) { saveMsg.textContent = x.message; }
      draw();
    };
    async function openReview(r) {
      st.sel = r; draw(); review.hidden = false; split.classList.add("open");
      const qtypes = {}; O.questionIndex(layout).forEach(x => (qtypes[x.qno] = x.sec));
      const s = rosterRoll.get(String(r.roll).replace(/^0+/, ""));
      const cv = h("canvas", { class: "sheet", width: 672, height: 950 });
      const list = h("div");
      const drawIssues = () => {
        list.replaceChildren(...(r.issues.length ? r.issues.map((iss, k) => {
          let input = null;
          if (typeof iss.q === "number") input = h("input", { id: `fix-${k}`, class: "mono", value: r.answers[iss.q] || "", "aria-label": `Answer for Q${iss.q}` });
          else if (iss.q === "roll") input = h("input", { id: `fix-${k}`, class: "mono", value: r.roll.startsWith("UNKNOWN") ? "" : r.roll, inputmode: "numeric", "aria-label": "Roll number" });
          const save = () => {
            if (input) {
              const v = input.value.trim().toUpperCase();
              if (iss.q === "roll") {
                if (!rosterRoll.has(v.replace(/^0+/, ""))) { toast("No student with that roll number in this test"); return; }
                r.roll = v; r.issues.filter(i => i.q === "roll").forEach(i => (i.done = true));
              } else {
                const sec = qtypes[iss.q], numeric = sec.qtype === "integer" || sec.qtype === "decimal";
                if (v && numeric && !/^-?\d+(\.\d+)?$/.test(v)) { toast("Type a number"); return; }
                if (v && !numeric && ![...v].every(c => sec.options.includes(c))) { toast(`Use ${[...sec.options].join(", ")}`); return; }
                if (v && sec.qtype === "single" && v.length > 1) { toast("Only one option for this question (or leave empty if two were marked)"); return; }
                r.answers[iss.q] = v;
              }
            }
            iss.done = true; r.status = r.issues.some(i => !i.done) ? "REVIEW" : "OK"; r.saved = false; drawIssues(); draw();
          };
          return h("div", { class: "issue" + (iss.done ? " done" : "") }, h("b", {}, typeof iss.q === "number" ? `Q${iss.q}` : iss.q === "roll" ? "Roll" : "Sheet"),
            h("label", { for: `fix-${k}`, class: "small" }, iss.msg), h("div", { class: "act" }, input, h("button", { class: "btn small", type: "button", onclick: save }, iss.done ? "Saved" : input ? "Save" : "OK")));
        }) : [h("p", { class: "muted small" }, "Every mark on this sheet was clear.")]));
      };
      drawIssues();
      const next = st.rows.find(x => x !== r && x.status === "REVIEW");
      reshow(view, h("div", { class: "head" }, h("div", {}, h("h2", {}, `Roll ${r.roll}`), h("p", { class: "sub small" }, `${s ? s.name : "Unknown student"} · ${r.source}`)),
        h("button", { class: "btn small ghost", type: "button", onclick: () => { review.hidden = true; split.classList.remove("open"); st.sel = null; draw(); } }, "Close")),
        h("p", { class: "small muted" }, "Green: read as marked. Orange: doubtful. Red box: question to check."), cv, list,
        next ? h("div", {}, h("button", { class: "btn small", type: "button", onclick: () => openReview(next) }, "Next sheet to check ›")) : null);
      try {
        const g = await loadGray(r.page.src), res = O.readPage(g, opts());
        if (st.sel !== r || !res.ok) return;
        const ppm = 3.2, W = Math.round(O.PAGE_W * ppm), H = Math.round(O.PAGE_H * ppm), ctx = cv.getContext("2d");
        cv.width = W; cv.height = H;
        const img = ctx.createImageData(W, H);
        for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
          const [u, v] = res.map(i / ppm, j / ppm); let val = 255;
          if (u >= 0 && v >= 0 && u < g.w - 1 && v < g.h - 1) val = g.d[(v | 0) * g.w + (u | 0)];
          const o = (j * W + i) * 4; img.data[o] = img.data[o + 1] = img.data[o + 2] = val; img.data[o + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
        const flagged = new Set(r.issues.filter(i => typeof i.q === "number").map(i => i.q));
        for (const f of O.buildGeometry(layout).fields) {
          const hot = f.kind === "roll" ? r.issues.some(i => i.q === "roll") : flagged.has(f.qno);
          for (const col of f.columns) for (const b of col) {
            const m = res.marks.find(mm => mm[0] === b.x && mm[1] === b.y);
            if (!m || m[3] === "off") continue;
            ctx.lineWidth = 2; ctx.strokeStyle = m[3] === "doubt" ? "#e8780c" : hot ? "#c0392b" : "rgba(30,140,70,.85)";
            ctx.beginPath(); ctx.arc(b.x * ppm, b.y * ppm, b.r * ppm + 2.5, 0, Math.PI * 2); ctx.stroke();
          }
          if (hot) {
            const all = f.columns.flat(), xs = all.map(b => b.x), ys = all.map(b => b.y);
            ctx.strokeStyle = "#c0392b"; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
            ctx.strokeRect((Math.min(...xs) - 3.2) * ppm, (Math.min(...ys) - 3) * ppm, (Math.max(...xs) - Math.min(...xs) + 6.4) * ppm, (Math.max(...ys) - Math.min(...ys) + 6) * ppm);
            ctx.setLineDash([]);
          }
        }
      } catch (e) { /* preview only */ }
    }
  }

  // ---- results & analysis
  async function resultsTab(body, t, layout) {
    const a = await GET(`/api/tests/${t.id}/analysis`);
    const me = state.me;
    if (!a.students.length) {
      body.append(h("div", { class: "card empty" }, h("h2", {}, "No sheets read yet"), h("p", {}, "Print sheets for the batches, then upload the scans in Upload scans.")));
      return;
    }
    const avg = a.students.reduce((x, s) => x + s.total, 0) / a.students.length;
    const sorted = a.students.slice().sort((x, y) => y.total - x.total);
    const fb = placeFilters(drawTable, {});
    const tbody = h("tbody");
    function drawTable() {
      const f = fb.get();
      const list = sorted.filter(s => (!f.zone || String(s.zone_id) === f.zone) && (!f.campus || String(s.campus_id) === f.campus) && (!f.batch || String(s.batch_id) === f.batch));
      tbody.replaceChildren(...list.slice(0, 2000).map(s => h("tr", { tabindex: 0, onclick: () => (location.hash = `#/report/${t.id}/${s.student_id}`), onkeydown: e => e.key === "Enter" && (location.hash = `#/report/${t.id}/${s.student_id}`) },
        h("td", { class: "num" }, s.rank_all), h("td", { class: "mono" }, s.roll), h("td", {}, s.name), h("td", {}, batchFull(s.batch_id)),
        h("td", { class: "num" }, h("b", {}, s.total)), a.subjects.map(sub => h("td", { class: "num" }, s.subjects[sub] ?? 0)),
        h("td", { class: "num" }, s.correct), h("td", { class: "num" }, s.wrong), h("td", { class: "num" }, s.blank),
        h("td", { class: "num" }, s.rank_campus), h("td", { class: "num" }, s.rank_batch))));
    }
    const groupTable = (title, rows) => rows.length > 1 || (rows.length && title !== "Batches") ? h("div", { class: "card" }, h("h2", {}, title), h("div", { class: "tablebox" }, h("table", {},
      h("thead", {}, h("tr", {}, ["Name", "Students", "Average", "Top"].map(x => h("th", {}, x)))),
      h("tbody", {}, rows.sort((x, y) => y.avg - x.avg).map(r => h("tr", {}, h("td", {}, title === "Batches" ? batchFull(r.id) : r.name), h("td", { class: "num" }, r.n), h("td", { class: "num" }, r.avg), h("td", { class: "num" }, r.top))))))) : null;
    const hardest = a.questions.slice().sort((x, y) => x.right / x.n - y.right / y.n).slice(0, 10);
    if (a.keyCount < a.total_questions) body.append(h("p", { class: "pill warn", style: "padding:8px 12px;border-radius:6px;white-space:normal" }, `The answer key has ${a.keyCount} of ${a.total_questions} answers. Marks count only keyed questions.`));
    body.append(
      h("div", { class: "stats" }, h("div", { class: "stat" }, h("b", {}, `${a.students.length} / ${a.expected}`), h("span", {}, "Sheets read")),
        h("div", { class: "stat gold" }, h("b", {}, avg.toFixed(1)), h("span", {}, `Average of ${a.max}`)),
        h("div", { class: "stat ok" }, h("b", {}, sorted[0].total), h("span", {}, `Top · ${sorted[0].name || sorted[0].roll}`)),
        h("div", { class: "stat" }, h("b", {}, sorted[Math.floor(sorted.length / 2)].total), h("span", {}, "Median"))),
      h("div", { class: "grid3" }, groupTable("Zones", a.by_zone), groupTable("Campuses", a.by_campus), groupTable("Batches", a.by_batch)),
      h("div", { class: "card" }, h("div", { class: "head" }, h("h2", {}, "Students"), h("div", { class: "row" }, h("button", { class: "btn small ghost", type: "button", onclick: () => {
        download(`results_${t.code}.csv`, csv([["rank", "roll", "name", "zone", "campus", "batch", "total", ...a.subjects, "correct", "wrong", "blank", "campus rank", "batch rank"],
          ...sorted.map(s => [s.rank_all, s.roll, s.name, zoneName(s.zone_id), campusName(s.campus_id), (batchOf(s.batch_id) || {}).name, s.total, ...a.subjects.map(x => s.subjects[x] ?? 0), s.correct, s.wrong, s.blank, s.rank_campus, s.rank_batch])]));
      } }, "Download CSV"))),
        h("div", { class: "row" }, fb.els),
        h("div", { class: "tablebox" }, h("table", {}, h("thead", {}, h("tr", {}, ["Rank", "Roll", "Name", "Batch", "Total", ...a.subjects.map(s => s[0] + s.slice(1).toLowerCase()), "Right", "Wrong", "Blank", "Campus rank", "Batch rank"].map(x => h("th", {}, x)))), tbody))),
      h("div", { class: "card" }, h("h2", {}, "Questions with the fewest right answers"), h("div", { class: "bars" }, hardest.map(q => {
        const pct = Math.round(q.right / q.n * 100);
        return h("div", { class: "barrow" }, h("span", { class: "mono" }, `Q${q.q}`), h("div", { class: "meter" }, h("i", { style: `width:${Math.max(1, pct)}%` })), h("span", { class: "num" }, `${pct}% right`));
      }))));
    drawTable();
  }

  // ================================================================ student report (admin view + student view share this)
  function reportView(view, rep, back) {
    const pct = rep.max ? Math.round((rep.total / rep.max) * 100) : 0;
    const rows = rep.detail.map(d => {
      const tone = d.result === "correct" || d.result === "bonus" ? "ok" : d.result === "partial" ? "warn" : d.result === "blank" ? "" : d.result === "wrong" ? "bad" : "";
      const label = { correct: "Right", wrong: "Wrong", blank: "Not answered", partial: "Partly right", bonus: "Bonus", dropped: "Dropped", nokey: "No key", badkey: "—" }[d.result];
      return { d, tone, label };
    });
    const filter = h("select", { id: "rep-filter", "aria-label": "Show" }, h("option", { value: "" }, "All questions"), h("option", { value: "wrong" }, "Wrong only"), h("option", { value: "blank" }, "Not answered"), h("option", { value: "correct" }, "Right only"));
    const tb = h("tbody");
    const qbox = h("div");
    const draw = () => {
      const f = filter.value;
      const list = rows.filter(r => !f || r.d.result === f);
      tb.replaceChildren(...list.map(({ d, tone, label }) => h("tr", {}, h("td", { class: "mono" }, `Q${d.q}`), h("td", {}, d.subject), h("td", { class: "mono" }, d.marked || "—"), h("td", { class: "mono" }, d.key || "—"),
        h("td", {}, h("span", { class: "pill " + tone }, label)), h("td", { class: "num" }, d.marks))));
      qbox.replaceChildren(...list.filter(r => r.d.question).map(({ d, tone, label }) => h("div", { class: "qcard" },
        h("div", { class: "row" }, h("b", { class: "shrink" }, `Q${d.q}`), h("span", { class: "pill " + tone + " shrink" }, label), h("span", { class: "small muted" }, d.question.chapter || "")),
        d.question.text ? h("div", { style: "white-space:pre-wrap" }, d.question.text) : null, d.question.image ? h("img", { src: d.question.image, alt: `Question ${d.q}` }) : null,
        d.question.options.length ? h("div", { class: "opts small" }, d.question.options.map((o, i) => o ? h("div", {}, `(${"ABCD"[i]}) ${o}`) : null)) : null,
        h("div", { class: "small" }, `Your answer: ${d.marked || "—"} · Correct: ${d.key}`), d.question.solution ? h("details", {}, h("summary", {}, "Solution"), h("div", { style: "white-space:pre-wrap" }, d.question.solution)) : null)));
    };
    filter.onchange = draw;
    show(view, h("div", { class: "head" }, h("div", {}, back, h("h1", {}, rep.test.name), h("p", { class: "sub" }, `${rep.test.code} · ${fmtDate(rep.test.test_date)} · ${rep.test.sheet_title}`))),
      h("div", { class: "stats" }, h("div", { class: "stat gold" }, h("b", {}, `${rep.total} / ${rep.max}`), h("span", {}, `${pct}% of full marks`)),
        h("div", { class: "stat" }, h("b", {}, `${rep.rank_batch} / ${rep.rank_batch_of}`), h("span", {}, "Rank in batch")),
        h("div", { class: "stat" }, h("b", {}, `${rep.rank_campus} / ${rep.rank_campus_of}`), h("span", {}, "Rank in campus")),
        h("div", { class: "stat" }, h("b", {}, `${rep.rank_all} / ${rep.rank_all_of}`), h("span", {}, "Overall rank")),
        h("div", { class: "stat ok" }, h("b", {}, rep.correct), h("span", {}, "Right")), h("div", { class: "stat warn" }, h("b", {}, rep.wrong), h("span", {}, "Wrong")), h("div", { class: "stat" }, h("b", {}, rep.blank), h("span", {}, "Not answered"))),
      h("div", { class: "card" }, h("h2", {}, "Subject-wise"), h("div", { class: "bars" }, rep.subjects.map(s => {
        const got = rep.by_subject[s] || 0, out = rep.subject_max[s] || 1;
        return h("div", { class: "barrow", style: "grid-template-columns:110px minmax(0,1fr) 80px" }, h("span", {}, s[0] + s.slice(1).toLowerCase()),
          h("div", { class: "meter" }, h("i", { style: `width:${Math.max(0, Math.min(100, (got / out) * 100))}%` })), h("span", { class: "num" }, `${got} / ${out}`));
      }))),
      h("div", { class: "card" }, h("div", { class: "head" }, h("h2", {}, "Question-wise"), filter), h("div", { class: "tablebox" }, h("table", {}, h("thead", {}, h("tr", {}, ["Q", "Subject", "Marked", "Correct", "Result", "Marks"].map(x => h("th", {}, x)))), tb)), qbox));
    draw();
  }
  route(/^\/report\/(\d+)\/(\d+)$/, async (view, tid, sid) => {
    await structure();
    reportView(view, await GET(`/api/tests/${tid}/student/${sid}`), h("a", { href: `#/tests/${tid}` }, "‹ Test results"));
  }, ["central", "zone", "campus"]);

  // ================================================================ student side
  route(/^\/my$/, async view => {
    const tests = await GET("/api/my/tests");
    const me = state.me;
    show(view, h("div", { class: "head" }, h("div", {}, h("h1", {}, `Hi ${me.name || me.username}`), h("p", { class: "sub" }, `Roll ${me.roll} · ${me.batch ? me.batch.name : ""} · ${me.campus || ""}`))),
      installHint(),
      tests.length ? progressView(tests) : null,
      h("div", { class: "card" }, h("h2", {}, "My results"), tests.length ? h("div", { class: "results-list" }, tests.map(t => {
        const pct = t.max ? Math.round(t.total / t.max * 100) : 0;
        return h("a", { class: "result-row", href: `#/my/${t.id}` },
          h("div", { class: "rr-main" }, h("b", {}, t.name), h("span", { class: "small muted" }, `${fmtDate(t.test_date)} · Rank ${t.rank_batch} of ${t.rank_batch_of} in batch`)),
          h("div", { class: "rr-score" }, h("b", {}, `${t.total}`), h("span", { class: "small muted" }, `/ ${t.max} · ${pct}%`)),
          h("span", { class: "rr-go", "aria-hidden": "true" }, "›"));
      })) : h("p", { class: "empty" }, "No results yet. Your marks appear here once your institute publishes them.")));
  }, ["student"]);

  // progress across tests: score trend, change from last test, subject strengths
  function progressView(tests) {
    const chron = tests.slice().reverse().slice(-10);
    const pct = t => (t.max ? Math.round((t.total / t.max) * 1000) / 10 : 0);
    const last = chron[chron.length - 1], prev = chron[chron.length - 2];
    const delta = prev ? Math.round((pct(last) - pct(prev)) * 10) / 10 : null;
    const W = 320, H = 150, L = 30, R = 10, T = 18, B = 26;
    const lo = Math.min(0, ...chron.map(pct)), hi = 100;
    const x = i => (chron.length === 1 ? (L + W - R) / 2 : L + (i * (W - L - R)) / (chron.length - 1));
    const y = v => T + ((hi - v) * (H - T - B)) / (hi - lo);
    const svgNS = "http://www.w3.org/2000/svg";
    const s = (tag, attrs, text) => { const e = document.createElementNS(svgNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (text != null) e.textContent = text; return e; };
    const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, class: "trend", role: "img", "aria-label": `Marks in your last ${chron.length} tests, as a percentage of full marks` });
    for (const v of [0, 50, 100]) svg.append(s("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), class: "grid" }), s("text", { x: L - 6, y: y(v) + 3, "text-anchor": "end", class: "axis" }, `${v}%`));
    if (lo < 0) svg.append(s("line", { x1: L, x2: W - R, y1: y(lo), y2: y(lo), class: "grid" }));
    const pts = chron.map((t, i) => `${x(i)},${y(pct(t))}`).join(" ");
    if (chron.length > 1) svg.append(s("polygon", { points: `${x(0)},${y(lo)} ${pts} ${x(chron.length - 1)},${y(lo)}`, class: "area" }), s("polyline", { points: pts, class: "line" }));
    chron.forEach((t, i) => {
      const end = i === chron.length - 1;
      svg.append(s("circle", { cx: x(i), cy: y(pct(t)), r: end ? 4.5 : 3, class: end ? "dot end" : "dot" }));
      if (end || chron.length <= 6) svg.append(s("text", { x: x(i), y: y(pct(t)) - 8, "text-anchor": "middle", class: end ? "val end" : "val" }, `${Math.round(pct(t))}%`));
      if (chron.length <= 6 || i % 2 === (chron.length - 1) % 2) svg.append(s("text", { x: x(i), y: H - 8, "text-anchor": "middle", class: "axis" }, t.code));
    });
    const subj = {};
    for (const t of tests) for (const k in t.by_subject || {}) {
      const m = (t.subject_max || {})[k]; if (!m) continue;
      (subj[k] = subj[k] || []).push((t.by_subject[k] / m) * 100);
    }
    const rows = Object.entries(subj).map(([k, arr]) => ({ k, v: Math.round(arr.reduce((p, q) => p + q, 0) / arr.length) })).sort((p, q) => q.v - p.v);
    const weakest = rows.length > 1 ? rows[rows.length - 1] : null;
    const title = k => k[0] + k.slice(1).toLowerCase();
    return h("div", { class: "card" },
      h("div", { class: "head" }, h("h2", {}, "My progress"), h("span", { class: "small muted" }, `Last ${chron.length} test${chron.length === 1 ? "" : "s"}`)),
      h("div", { class: "stats" },
        h("div", { class: "stat gold" }, h("b", {}, `${Math.round(pct(last))}%`), h("span", {}, "Latest test")),
        delta != null ? h("div", { class: "stat " + (delta >= 0 ? "ok" : "warn") }, h("b", {}, `${delta >= 0 ? "+" : ""}${delta}%`), h("span", {}, "Change from the test before")) : null,
        h("div", { class: "stat" }, h("b", {}, `${last.rank_batch} / ${last.rank_batch_of}`), h("span", {}, "Latest batch rank"))),
      chron.length > 1 ? svg : null,
      rows.length ? h("div", { style: "display:grid;gap:6px" }, h("h3", {}, "Subjects, average across tests"), h("div", { class: "bars" }, rows.map(r =>
        h("div", { class: "barrow", style: "grid-template-columns:96px minmax(0,1fr) 44px" }, h("span", {}, title(r.k)),
          h("div", { class: "meter" }, h("i", { style: `width:${Math.max(0, Math.min(100, r.v))}%` + (weakest && r.k === weakest.k ? ";background:var(--warn)" : "") })),
          h("span", { class: "num" }, `${r.v}%`))))) : null,
      weakest ? h("p", { class: "small", style: "margin:0" }, "Focus area: ", h("b", {}, title(weakest.k)), ". Open a test and choose \"Wrong only\" to review those questions.") : null);
  }
  route(/^\/my\/(\d+)$/, async (view, id) => reportView(view, await GET(`/api/my/tests/${id}`), h("a", { href: "#/my" }, "‹ My results")), ["student"]);

  // ================================================================ account
  route(/^\/account$/, async view => {
    const cur = h("input", { id: "pw-cur", type: "password", autocomplete: "current-password" });
    const nx = h("input", { id: "pw-new", type: "password", autocomplete: "new-password" });
    const msg = h("p", { class: "small" });
    show(view, h("h1", {}, "Account"), h("form", { class: "card", style: "max-width:460px", onsubmit: async e => {
      e.preventDefault();
      try { await POST("/api/me/password", { current: cur.value, next: nx.value }); msg.className = "small"; msg.textContent = "Password changed."; cur.value = nx.value = ""; }
      catch (x) { msg.className = "small err"; msg.textContent = x.message; }
    } }, h("h2", {}, "Change password"), field("Current password", cur), field("New password", nx, "At least 6 characters"), msg, h("div", {}, h("button", { class: "btn", type: "submit" }, "Change password"))),
      state.me.role === "central" ? h("div", { class: "card", style: "max-width:460px" }, h("h2", {}, "Backup"),
        h("p", { class: "small" }, "Downloads one file with everything: zones, students, question bank, tests and marks. Keep a copy every week, for example in Google Drive. If anything ever goes wrong, the portal can be restored from it."),
        h("div", {}, h("a", { class: "btn", href: "/api/backup", download: "" }, "Download backup"))) : null);
  });

  (window.__portalReady || Promise.resolve()).then(render, e => { $("#view").textContent = "Could not start: " + e.message; });
})();
