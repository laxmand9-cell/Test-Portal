(function () {
  "use strict";
  const O = window.OMR, SH = window.OMRSheet;
  // Heavy tools (scanning, PDF, Excel) load only on the admin screens that use them, so student phones download little.
  const LIBS = { jsqr: "/vendor/jsQR.js", qrcode: "/vendor/qrcode.js", jspdf: "/vendor/jspdf.umd.min.js", jszip: "/vendor/jszip.min.js",
    pdf: "/vendor/pdf.min.js", pdfworker: "/vendor/pdf.worker.min.js", xlsx: "/vendor/xlsx.full.min.js",
    katex: "/vendor/katex/katex.min.js", katexauto: "/vendor/katex/auto-render.min.js", exam: "/exam.js", importer: "/import.js" };
  const libLoads = {};
  const loadLib = k => (libLoads[k] = libLoads[k] || new Promise((res, rej) => {
    const s = document.createElement("script"); s.src = LIBS[k];
    s.onload = res; s.onerror = () => { delete libLoads[k]; s.remove(); rej(new Error("Could not load part of the page. Check the internet connection and try again.")); };
    document.head.append(s);
  }));
  async function need(...keys) { for (const k of keys) await loadLib(k); }
  // ---- questions written as HTML with LaTeX maths (imported question sets)
  const RICH_TAGS = new Set(["P", "BR", "SPAN", "B", "STRONG", "I", "EM", "SUP", "SUB", "U", "TABLE", "THEAD", "TBODY", "TR", "TD", "TH", "COLGROUP", "COL", "UL", "OL", "LI", "IMG", "DIV", "PRE", "CODE"]);
  function richNode(html) {
    const doc = new DOMParser().parseFromString(`<div>${html || ""}</div>`, "text/html");
    const clean = node => {
      for (const el of [...node.children]) {
        if (!RICH_TAGS.has(el.tagName)) { el.replaceWith(...[...el.childNodes].map(n => n.nodeType === 3 ? n : document.createTextNode(n.textContent))); continue; }
        for (const at of [...el.attributes]) {
          const ok = (at.name === "class") || (el.tagName === "IMG" && at.name === "src" && /^\/qimg\/[0-9a-f]+\.(webp|jpg|png)$/.test(at.value)) ||
            (el.tagName === "IMG" && at.name === "style" && /^width:\d+px$/.test(at.value)) || (el.tagName === "IMG" && at.name === "alt") || (/^(colspan|rowspan)$/.test(at.name) && /^\d+$/.test(at.value));
          if (!ok) el.removeAttribute(at.name);
        }
        if (el.tagName === "IMG") { if (!el.getAttribute("src")) { el.remove(); continue; } el.loading = "lazy"; el.setAttribute("alt", el.getAttribute("alt") || "Figure"); }
        clean(el);
      }
    };
    const root = doc.body.firstChild; clean(root);
    const box = h("div", { class: "rich" }); box.append(...root.childNodes);
    renderMath(box);
    return box;
  }
  let katexCss = null;
  async function renderMath(el) {
    if (!/\\\(|\\\[/.test(el.textContent)) return;
    try {
      if (!katexCss) { katexCss = h("link", { rel: "stylesheet", href: "/vendor/katex/katex.min.css" }); document.head.append(katexCss); }
      await need("katex", "katexauto");
      window.renderMathInElement(el, { delimiters: [{ left: "\\[", right: "\\]", display: true }, { left: "\\(", right: "\\)", display: false }], throwOnError: false });
    } catch (e) { /* maths stays as plain text */ }
  }
  const plainText = (html, n) => { const t = new DOMParser().parseFromString(html || "", "text/html").body.textContent.replace(/\\[()\[\]]/g, "").replace(/\s+/g, " ").trim(); return n ? t.slice(0, n) : t; };
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
  window.TPX = { h, show: (...a) => show(...a), toast: m => toast(m), GET: u => GET(u), POST: (u, b) => POST(u, b), PUT: (u, b) => PUT(u, b), richNode: x => richNode(x) };
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
    document.body.classList.toggle("login-mode", hash === "/login");
    if (hash === "/login") { $("#bar").hidden = true; return loginView(view); }
    drawBar(hash);
    for (const r of routes) {
      const m = hash.match(r.re);
      if (!m) continue;
      if (r.who && !r.who.includes(state.me.role)) break;
      show(view, skeleton());
      try { await r.fn(view, ...m.slice(1)); countUp(view); }
      catch (e) { show(view, h("div", { class: "card" }, h("h2", {}, "Could not open this page"), h("p", { class: "err" }, e.message))); }
      window.scrollTo(0, 0);
      return;
    }
    location.hash = state.me.role === "student" ? "#/my" : "#/";
  }
  window.addEventListener("hashchange", render);
  // grey placeholder shapes while a page loads
  function skeleton() {
    const bar = (w, hh = 14) => h("i", { class: "sk", style: `width:${w};height:${hh}px` });
    return h("div", { class: "sk-page", "aria-busy": "true", "aria-label": "Loading" },
      h("div", { class: "sk-head" }, bar("38%", 26), bar("24%")),
      h("div", { class: "sk-tiles" }, ...[0, 1, 2].map(() => h("div", { class: "sk-card" }, bar("40%", 22), bar("60%")))),
      h("div", { class: "sk-card" }, bar("30%", 18), bar("100%"), bar("92%"), bar("96%"), bar("70%")));
  }
  // score tiles count up briefly when a page opens
  const calm = () => window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  function countUp(root) {
    if (calm() || document.body.classList.contains("exam-mode")) return;
    for (const b of root.querySelectorAll(".stats .stat > b")) {
      if (b.children.length) continue;
      const m = /^(\D{0,2})(\d{1,6}(?:\.\d+)?)(.*)$/.exec(b.textContent.trim()); if (!m) continue;
      const end = parseFloat(m[2]), dec = (m[2].split(".")[1] || "").length, t0 = performance.now(), dur = 650;
      if (!end) continue;
      const tick = now => { const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
        b.textContent = m[1] + (end * e).toFixed(dec) + m[3]; if (k < 1 && b.isConnected) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    }
  }
  // ---- the frame: a side menu on wide screens, a top bar with a slide-in menu on narrow ones (students get tabs at the bottom)
  const NAV_ICON = {
    home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h5v-6h4v6h5V10"/>',
    tests: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h3"/>',
    analysis: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
    students: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.5 3.3-5.5 6.5-5.5s5.9 2 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c2 .7 3.2 2.5 3.5 5.2"/>',
    bank: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 21V5M8 7h7"/>',
    structure: '<rect x="9" y="3" width="6" height="5" rx="1"/><rect x="3" y="16" width="6" height="5" rx="1"/><rect x="15" y="16" width="6" height="5" rx="1"/><path d="M12 8v4M6 16v-2h12v2"/>',
    admins: '<path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
    account: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4.4-6 8-6s7 2 8 6"/>',
    results: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    mistakes: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2"/>',
    practice: '<path d="M14 4l6 6L9 21H3v-6z"/><path d="M12 6l6 6"/>',
  };
  const navIcon = k => h("span", { class: "nav-ic", "aria-hidden": "true", html: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${NAV_ICON[k]}</svg>` });
  const initials = s => String(s || "?").trim().split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join("").toUpperCase() || "?";
  let brandLoaded = false;
  async function loadBrand() {
    if (brandLoaded) return; brandLoaded = true;
    let b = {}; try { b = await GET("/api/brand"); } catch (e) { /* default look */ }
    const name = (b.institute || "").trim();
    $("#brand-name").textContent = name ? name.split(/[,(]/)[0].trim().slice(0, 28) : "Test Portal";
    $("#brand-sub").textContent = "Test Portal";
    $("#brand-sub").hidden = !name;
    show($("#brand-logo"), b.logo ? h("img", { src: b.logo, alt: "" }) : h("span", {}, initials(name || "Test Portal").slice(0, 1)));
  }
  function setMenu(open) {
    document.body.classList.toggle("menu-open", open);
    $("#menu-btn").setAttribute("aria-expanded", String(open));
    $("#scrim").hidden = !open;
  }
  $("#menu-btn").addEventListener("click", () => setMenu(!document.body.classList.contains("menu-open")));
  $("#scrim").addEventListener("click", () => setMenu(false));
  addEventListener("keydown", e => { if (e.key === "Escape" && document.body.classList.contains("menu-open")) setMenu(false); });
  function drawBar(hash) {
    $("#bar").hidden = false;
    const me = state.me, student = me.role === "student";
    document.body.classList.toggle("role-student", student);
    document.body.classList.toggle("role-admin", !student);
    setMenu(false);
    loadBrand();
    const items = student ? [["#/my", "My results", "results"], ["#/mistakes", "My mistakes", "mistakes"], ["#/practice", "Practice", "practice"], ["#/account", "Account", "account"]]
      : [["#/", "Home", "home"], ["#/tests", "Tests", "tests"], ["#/dashboard", "Analysis", "analysis"], ["#/students", "Students", "students"],
        ...(me.role === "central" ? [["#/bank", "Question bank", "bank"], ["#/structure", "Zones & batches", "structure"], ["#/admins", "Admins", "admins"]] : [["#/structure", "Campuses & batches", "structure"]]),
        ["#/account", "Account", "account"]];
    $("#nav").replaceChildren(...items.map(([href, t, ic]) => {
      const on = "#" + hash === href || (href !== "#/" && ("#" + hash).startsWith(href) && !(href === "#/my" && hash.startsWith("/mistakes")));
      return h("a", { href, class: on ? "on" : "", "aria-current": on ? "page" : null }, navIcon(ic), h("span", {}, t));
    }));
    const place = me.role === "zone" ? me.zone : me.role === "campus" ? me.campus : student ? `Roll ${me.roll}` : "";
    $("#who").textContent = me.name || me.username;
    $("#who-role").textContent = [ROLE[me.role], place].filter(Boolean).join(" · ");
    $("#avatar").textContent = initials(me.name || me.username);
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
    const eye = h("button", { class: "eye", type: "button", "aria-label": "Show password", html: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M12 5C6.5 5 2.7 9.3 1.5 12c1.2 2.7 5 7 10.5 7s9.3-4.3 10.5-7C21.3 9.3 17.5 5 12 5zm0 11.5A4.5 4.5 0 1 1 12 7.5a4.5 4.5 0 0 1 0 9zm0-7a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z"/></svg>', onclick: () => { const show = p.type === "password"; p.type = show ? "text" : "password"; eye.setAttribute("aria-label", show ? "Hide password" : "Show password"); eye.classList.toggle("on", show); } });
    const brandBox = h("div", { class: "login-brand" }, h("h1", {}, "Test Portal"));
    GET("/api/brand").then(b => { if (b.logo || b.institute) show(brandBox, b.logo ? h("img", { src: b.logo, alt: b.institute || "Logo" }) : null,
      b.institute ? h("div", { class: "login-org" }, b.institute) : null, b.tagline ? h("div", { class: "small muted" }, b.tagline) : null); }).catch(() => {});
    const form = h("form", { class: "card login", onsubmit: async e => {
      e.preventDefault(); err.textContent = "";
      try { await POST("/api/login", { username: u.value, password: p.value }); state.me = await GET("/api/me"); state.s = null; location.hash = state.me.role === "student" ? "#/my" : "#/"; }
      catch (x) { err.textContent = x.message; }
    } }, brandBox, h("p", { class: "sub", style: "text-align:center;margin:0" }, "Log in with the username and password your institute gave you."),
      field("Username / Roll number", u), h("label", { class: "f" }, "Password", h("div", { class: "pw" }, p, eye)), err, h("button", { class: "btn login-btn", type: "submit" }, "LOGIN"));
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
    const tile = (n, label, ic, tone) => n == null ? null : h("div", { class: "stat si " + (tone || "") }, h("span", { class: "si-ic" }, navIcon(ic)), h("b", {}, n), h("span", {}, label));
    show(view,
      h("section", { class: "hero" }, h("div", { class: "hero-id" }, h("span", { class: "hero-av" }, initials(me.name || me.username)),
          h("div", {}, h("p", { class: "hero-hi" }, greeting()), h("h1", {}, me.name || me.username),
            h("p", { class: "hero-sub" }, me.role === "central" ? "You can see every zone, campus and batch." : me.role === "zone" ? `You can see all campuses in ${me.zone} zone.` : `You can see ${me.campus} campus.`))),
        h("div", { class: "hero-actions" }, me.role === "central" ? h("a", { class: "btn gold", href: "#/tests/new" }, "+ New test") : null, h("a", { class: "btn glass", href: "#/dashboard" }, "Open analysis"))),
      o.temporary_storage ? h("div", { class: "card", style: "border-left:4px solid var(--bad)" }, h("h2", { class: "err" }, "Data is not being kept"),
        h("p", {}, "This site has no disk attached, so every student, test and mark is erased when the server restarts or updates. Fine for trying things out; attach a disk before adding real data.")) : null,
      h("div", { class: "stats" },
        tile(o.zones, "Zones", "structure", "t-violet"), tile(o.campuses, "Campuses", "home", "t-blue"), tile(o.batches, "Batches", "students", "t-teal"),
        tile(o.students, "Students", "account", "t-gold"), tile(o.tests, "Tests", "tests", "t-green"), me.role === "central" ? tile(o.questions, "Questions in bank", "bank", "t-rose") : null),
      h("div", { class: "card" }, h("div", { class: "head" }, h("h2", {}, "Recent tests"), h("a", { href: "#/tests" }, "All tests")),
        testsTable(tests.slice(0, 8))));
  }, ["central", "zone", "campus"]);

  // exam cards: compact, clickable, with quick links (central/zone/campus)
  const tWhen = ms => { const d = new Date(ms); return [d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true }).toUpperCase(),
    d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" }) + " '" + String(d.getFullYear()).slice(2)]; };
  function testStatus(t) {
    const online = t.mode && t.mode !== "omr", now = Date.now();
    if (online && t.opens_at && now < t.opens_at) return ["upcoming", "Upcoming"];
    if (online && t.opens_at && (!t.closes_at || now <= t.closes_at)) return ["live", "Live now"];
    if (online && t.closes_at && now > t.closes_at) return ["over", "Window closed"];
    return null;
  }
  const ICON = {
    results: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    analysis: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
    print: '<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M7 14h10v7H7z"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    sheet: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h3"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.5 3.3-5.5 6.5-5.5s5.9 2 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c2 .7 3.2 2.5 3.5 5.2"/>',
  };
  const icon = k => { const sp = document.createElement("span"); sp.className = "ic"; sp.setAttribute("aria-hidden", "true");
    sp.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON[k]}</svg>`; return sp; };
  function examCard(t) {
    const online = t.mode && t.mode !== "omr";
    const kind = t.mode === "cbt" ? "Online" : t.mode === "both" ? "Online + OMR" : "OMR";
    const st = testStatus(t);
    const open = () => (location.hash = `#/tests/${t.id}`);
    const when = online && t.opens_at ? new Date(t.opens_at) : t.test_date ? new Date(t.test_date + "T00:00:00") : null;
    const ok = when && !isNaN(when);
    const names = t.batch_ids.map(id => { const b = batchOf(id); return b ? `${campusName(b.campus_id)} · ${b.name}` : ""; }).filter(Boolean);
    const done = online ? (t.attempt_count || 0) : t.result_count, of = t.student_count || 0;
    const pct = of ? Math.min(100, Math.round((done / of) * 100)) : 0;
    const act = (k, label, href) => h("a", { class: "ec-a", href, onclick: e => e.stopPropagation() }, icon(k), h("span", {}, label));
    const hm = ms => new Date(ms).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true }).toUpperCase();
    return h("article", { class: "ec " + (online ? "ec-on" : "ec-omr") + (st ? " st-" + st[0] : ""), tabindex: 0, role: "link", "aria-label": `Open ${t.name}`,
      onclick: open, onkeydown: e => { if (e.key === "Enter" && e.target === e.currentTarget) open(); } },
      h("div", { class: "ec-top" },
        h("div", { class: "ec-date" + (ok ? "" : " none") }, ok ? [h("small", {}, when.toLocaleDateString("en-IN", { month: "short" }).toUpperCase()),
          h("b", {}, when.getDate()), h("small", {}, when.toLocaleDateString("en-IN", { weekday: "short" }))] : h("b", {}, "—")),
        h("div", { class: "ec-head" },
          h("div", { class: "ec-badges" }, h("span", { class: "ec-kind" }, kind), st ? h("span", { class: "ec-st " + st[0] }, st[1]) : null,
            h("span", { class: "ec-pub " + (t.published ? "ok" : "") }, t.published ? "✓ Published" : "Draft")),
          h("b", { class: "ec-title", title: t.name }, t.name),
          h("span", { class: "ec-sub" }, h("span", { class: "mono" }, t.code), ` · ${t.linked_count ? `${t.linked_count}/` : ""}${t.questions} Qs`))),
      h("div", { class: "ec-facts" },
        online ? h("span", {}, icon("clock"), t.opens_at ? `${hm(t.opens_at)}${t.closes_at ? " – " + hm(t.closes_at) : ""}` : "No window set", h("em", {}, ` · ${t.duration} min`))
          : h("span", {}, icon("sheet"), t.sheet_title.replace(/\s*\(.*\)$/, "")),
        names.length ? h("span", { title: names.join("\n") }, icon("users"), names.length === 1 ? names[0] : `${names.length} batches`) : null),
      h("div", { class: "ec-prog" }, h("div", { class: "ec-prog-l" }, h("span", {}, online ? "Attempted" : "OMRs read"), h("b", {}, `${done}`, h("small", {}, ` / ${of}`))),
        h("div", { class: "ec-bar-t" }, h("i", { style: `width:${pct}%` }))),
      h("div", { class: "ec-foot" },
        h("span", { class: "ec-acts" }, act("results", "Results", `#/tests/${t.id}/results`), act("analysis", "Analysis", `#/tests/${t.id}/analysis`), act("print", "Print", `#/print/${t.id}`))));
  }
  function testsTable(tests) {
    if (!tests.length) return h("p", { class: "empty" }, state.me.role === "central" ? "No tests yet. Create one with New test." : "No tests for your campuses yet.");
    return h("div", { class: "ecards" }, tests.map(examCard));
  }
  function testsList(tests) {
    if (!tests.length) return h("p", { class: "empty" }, "No tests match.");
    return h("div", { class: "tablebox" }, h("table", {}, h("thead", {}, h("tr", {}, ["Date", "Code", "Test", "Type", "Batches", "Sheets read", "Results"].map(t => h("th", {}, t)))),
      h("tbody", {}, tests.map(t => h("tr", { tabindex: 0, onclick: () => (location.hash = `#/tests/${t.id}`), onkeydown: e => e.key === "Enter" && (location.hash = `#/tests/${t.id}`) },
        h("td", {}, fmtDate(t.test_date)), h("td", { class: "mono" }, t.code), h("td", {}, t.name), h("td", {}, t.mode === "cbt" ? "Online" : t.mode === "both" ? "Online + OMR" : "OMR"),
        h("td", {}, t.batch_ids.length), h("td", { class: "num" }, `${t.result_count} / ${t.student_count}`),
        h("td", {}, h("span", { class: "pill " + (t.published ? "ok" : "") }, t.published ? "Published" : "Not published")))))));
  }

  // ================================================================ structure
  route(/^\/structure$/, async view => {
    const s = await structure(true);
    const central = state.me.role === "central";
    const box = h("div", { class: "st-zones" }), tiles = h("div", { class: "stats" }), logBox = h("div");
    const q = h("input", { id: "st-find", type: "search", placeholder: "Find a campus or batch", "aria-label": "Find a campus or batch" });
    const plural = (n, w, ws) => `${n} ${n === 1 ? w : ws || w + "s"}`;
    const zoneStats = z => { const cs = s.campuses.filter(c => c.zone_id === z.id), bs = s.batches.filter(b => cs.some(c => c.id === b.campus_id));
      return { cs, bs, students: cs.reduce((a, c) => a + (c.students || 0), 0) }; };
    // "⋯" menu: rename / remove live here, away from one-tap reach
    function more(label, items) {
      const menu = h("div", { class: "more-menu", role: "menu", hidden: true }, items.map(([t, fn, danger]) => h("button", { type: "button", role: "menuitem", class: danger ? "danger" : "", onclick: () => { close(); fn(); } }, t)));
      const btn = h("button", { class: "more-btn", type: "button", "aria-label": `More for ${label}`, "aria-haspopup": "menu", "aria-expanded": "false", onclick: e => { e.stopPropagation(); menu.hidden ? open() : close(); } },
        h("span", { "aria-hidden": "true" }, "⋯"));
      const outside = e => { if (!wrap.contains(e.target)) close(); }, esc = e => { if (e.key === "Escape") { close(); btn.focus(); } };
      function open() { document.querySelectorAll(".more-menu").forEach(m => (m.hidden = true)); menu.hidden = false; btn.setAttribute("aria-expanded", "true"); document.addEventListener("click", outside); document.addEventListener("keydown", esc); }
      function close() { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); document.removeEventListener("click", outside); document.removeEventListener("keydown", esc); }
      const wrap = h("div", { class: "more" }, btn, menu);
      return wrap;
    }
    const draw = () => {
      const f = q.value.trim().toLowerCase();
      const allStudents = s.campuses.reduce((a, c) => a + (c.students || 0), 0);
      show(tiles, ...[[s.zones.length, "Zones", "structure", "t-violet"], [s.campuses.length, "Campuses", "home", "t-blue"], [s.batches.length, "Batches", "students", "t-teal"], [allStudents, "Students", "account", "t-gold"]]
        .map(([n, l, ic, t]) => h("div", { class: "stat si " + t }, h("span", { class: "si-ic" }, navIcon(ic)), h("b", {}, n), h("span", {}, l))));
      if (!s.zones.length) { show(box, h("div", { class: "card" }, h("p", { class: "empty" }, central ? "No zones yet. Use Add zone to create the first one." : "Nothing assigned to you yet."))); return; }
      const shown = s.zones.map(z => {
        const { cs, bs, students } = zoneStats(z);
        const campusCards = cs.map(c => {
          const cb = s.batches.filter(b => b.campus_id === c.id);
          const hit = !f || z.name.toLowerCase().includes(f) || c.name.toLowerCase().includes(f) || cb.some(b => b.name.toLowerCase().includes(f));
          if (!hit) return null;
          const groups = ["11", "12", "Dropper"].map(l => [l, cb.filter(b => b.level === l)]).filter(([, l]) => l.length);
          return h("div", { class: "st-campus" },
            h("div", { class: "st-campus-h" }, h("div", { class: "st-campus-t" }, h("b", {}, c.name), h("span", { class: "small muted" }, `${plural(c.students || 0, "student")} · ${plural(cb.length, "batch", "batches")}`)),
              central ? more(c.name, [["Rename campus", () => nameBox("Rename campus", c.name, n => PATCH(`/api/campuses/${c.id}`, { name: n }))], ["Remove campus…", () => removeBox("campus", c.id), true]]) : null),
            groups.length ? groups.map(([l, list]) => h("div", { class: "st-level" }, h("span", { class: "st-lv lv-" + l }, LEVEL[l]),
              h("div", { class: "st-batches" }, list.map(b => h("span", { class: "st-batch" + (f && b.name.toLowerCase().includes(f) ? " hit" : "") },
                h("a", { href: `#/students?batch=${b.id}`, title: `Students in ${b.name}` }, h("b", {}, b.name), h("span", {}, b.students || 0)),
                central ? h("button", { type: "button", class: "st-edit", "aria-label": `Edit batch ${b.name}`, title: "Edit batch", onclick: () => batchBox(c, b) }, "✎") : null)))))
              : h("p", { class: "small muted", style: "margin:0" }, "No batches yet."),
            central ? h("button", { class: "st-add", type: "button", onclick: () => batchBox(c) }, "+ Add batch") : null);
        }).filter(Boolean);
        if (f && !campusCards.length && !z.name.toLowerCase().includes(f)) return null;
        return h("section", { class: "st-zone" },
          h("header", { class: "st-zone-h" }, h("span", { class: "si-ic t-violet" }, navIcon("structure")),
            h("div", { class: "st-zone-t" }, h("h2", {}, z.name), h("span", { class: "small muted" }, `${plural(cs.length, "campus", "campuses")} · ${plural(bs.length, "batch", "batches")} · ${plural(students, "student")}`)),
            central ? h("button", { class: "btn small ghost", type: "button", onclick: () => nameBox("New campus in " + z.name, "", n => POST("/api/campuses", { zone_id: z.id, name: n })) }, "+ Campus") : null,
            central ? more(z.name, [["Rename zone", () => nameBox("Rename zone", z.name, n => PATCH(`/api/zones/${z.id}`, { name: n }))], ["Remove zone…", () => removeBox("zone", z.id), true]]) : null),
          campusCards.length ? h("div", { class: "st-campuses" }, campusCards) : h("p", { class: "small muted", style: "margin:0" }, "No campuses yet."));
      }).filter(Boolean);
      show(box, ...(shown.length ? shown : [h("div", { class: "card" }, h("p", { class: "empty" }, "Nothing matches that name."))]));
    };
    async function drawLog() {
      if (!central) return;
      let rows = []; try { rows = await GET("/api/structure/log"); } catch (e) { return; }
      show(logBox, rows.length ? h("details", { class: "card st-log" }, h("summary", {}, h("b", {}, "Recent changes"), h("span", { class: "small muted" }, ` · last ${rows.length}`)),
        h("ul", {}, rows.map(r => h("li", {}, h("span", { class: "small muted" }, new Date(r.at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })),
          h("span", {}, h("b", {}, r.action), ` · ${r.detail}`), h("span", { class: "small muted" }, `by ${r.who}`))))) : null);
    }
    async function act(fn) { try { await fn(); Object.assign(s, await structure(true)); draw(); drawLog(); } catch (e) { toast(e.message); } }
    function nameBox(title, val, save) {
      modal((b, close) => {
        const i = h("input", { id: "name-box", value: val, maxlength: 80 });
        const err = h("p", { class: "err small" });
        b.append(h("form", { class: "card", style: "border:0;padding:0;box-shadow:none", onsubmit: async e => { e.preventDefault(); try { await save(i.value); close(); act(async () => {}); } catch (x) { err.textContent = x.message; } } },
          h("h2", {}, title), field("Name", i), err, h("div", { class: "row" }, h("button", { class: "btn", type: "submit" }, "Save"), h("button", { class: "btn ghost", type: "button", onclick: close }, "Cancel"))));
        setTimeout(() => i.focus(), 50);
      });
    }
    // removing: first show what still depends on it; when nothing does, ask for the exact name and the admin's password
    async function removeBox(kind, id) {
      let c; try { c = await GET(`/api/structure/${kind}/${id}/check`); } catch (e) { toast(e.message); return; }
      const what = { zone: "zone", campus: "campus", batch: "batch" }[kind], typeName = kind === "batch" ? c.name.replace(/ \(.*\)$/, "") : c.name;
      modal((b, close) => {
        if (c.blockers.length) {
          b.append(h("div", { class: "danger-box" }, h("h2", {}, `${c.name} can't be removed yet`),
            h("ul", {}, c.blockers.map(x => h("li", {}, x))),
            h("p", { class: "small muted", style: "margin:0" }, `This protects marks and accounts: a ${what} can be removed only when nothing is attached to it.`),
            h("div", { class: "row" }, h("button", { class: "btn", type: "button", onclick: close }, "OK"))));
          return;
        }
        const nm = h("input", { id: "rm-name", autocomplete: "off", spellcheck: "false", placeholder: typeName });
        const pw = h("input", { id: "rm-pass", type: "password", autocomplete: "current-password" });
        const err = h("p", { class: "err small" });
        const go = h("button", { class: "btn danger-solid", type: "submit", disabled: true }, `Remove ${what}`);
        const check = () => (go.disabled = nm.value.trim().toLowerCase() !== typeName.trim().toLowerCase() || !pw.value);
        nm.oninput = check; pw.oninput = check;
        b.append(h("form", { class: "danger-box", onsubmit: async e => { e.preventDefault(); go.disabled = true; err.textContent = "";
            try { await POST(`/api/structure/${kind}/${id}/remove`, { confirm: nm.value, password: pw.value }); close(); toast(`${c.name} removed`); act(async () => {}); }
            catch (x) { err.textContent = x.message; check(); } } },
          h("h2", {}, `Remove ${c.name}?`),
          h("p", { style: "margin:0" }, `This removes the ${what} for good. It can't be undone.`),
          field(h("span", {}, "Type ", h("b", { class: "mono" }, typeName), " to confirm"), nm),
          field("Your password", pw, "The password you log in with"), err,
          h("div", { class: "row" }, go, h("button", { class: "btn ghost", type: "button", onclick: close }, "Cancel"))));
        setTimeout(() => nm.focus(), 50);
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
          h("h2", {}, bt ? `Edit batch ${bt.name}` : `New batch in ${c.name}`), field("Batch name", n), field("Class", l), field("Academic year", y, "Optional"), err,
          h("div", { class: "row" }, h("button", { class: "btn", type: "submit" }, "Save"), h("button", { class: "btn ghost", type: "button", onclick: close }, "Cancel")),
          bt ? h("div", { class: "danger-zone" }, h("span", { class: "small muted" }, "Remove this batch only if it was made by mistake."),
            h("button", { class: "link danger-link", type: "button", onclick: () => { close(); removeBox("batch", bt.id); } }, "Remove batch…")) : null));
      });
    }
    q.oninput = draw;
    show(view, h("div", { class: "head" }, h("div", {}, h("h1", {}, central ? "Zones, campuses & batches" : "Campuses & batches"),
        h("p", { class: "sub" }, "Batches are 11th, 12th or Dropper groups inside a campus. Tap a batch to see its students.")),
        central ? h("button", { class: "btn gold", type: "button", onclick: () => nameBox("New zone", "", n => POST("/api/zones", { name: n })) }, "+ Add zone") : null),
      tiles, h("div", { class: "st-find" }, q), box, logBox);
    draw(); drawLog();
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
      cs.replaceChildren(h("option", { value: "" }, "All campuses"), ...campuses.map(c => h("option", { value: c.id, selected: String(c.id) === cv }, c.name)));
      const batches = s.batches.filter(b => (cs.value ? String(b.campus_id) === cs.value : campuses.some(c => c.id === b.campus_id)));
      bs.replaceChildren(h("option", { value: "" }, "All batches"), ...batches.map(b => h("option", { value: b.id, selected: String(b.id) === bv }, `${b.name} · ${LEVEL[b.level]}${cs.value ? "" : " · " + campusName(b.campus_id)}`)));
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
  const QLEVELS = ["Easy", "Medium", "Difficult"];
  // ---- question bank: JEE Main bank / JEE Advanced bank (past-year or practice → subject → chapter) and the Portal bank (imported papers, own questions)
  const BANK_TABS = [["main", "JEE Main bank"], ["adv", "JEE Advanced bank"], ["eapcet", "EAPCET bank"], ["neet", "NEET bank"], ["portal", "Portal bank"]];
  const BANK_SUBJECTS = { main: ["Physics", "Chemistry", "Mathematics"], adv: ["Physics", "Chemistry", "Mathematics"], eapcet: ["Mathematics", "Physics", "Chemistry"],
    neet: ["Physics", "Chemistry", "Botany", "Zoology"], portal: [] };
  const SUBJ_ORDER = ["physics", "chemistry", "mathematics", "maths", "biology", "botany", "zoology"];
  const bankView = { bank: "main", pyq: "1", subject: "", chapter: "" };
  route(/^\/bank$/, async view => {
    const V = bankView;
    const chap = h("select", { id: "qb-chapter", "aria-label": "Chapter" });
    const yr = h("select", { id: "qb-year", "aria-label": "Year" });
    const paper = h("select", { id: "qb-paper", "aria-label": "Imported paper" });
    const typ = h("select", { id: "qb-type", "aria-label": "Question type" });
    let typBank = null;
    const fillTypes = () => { // JEE Main, EAPCET and NEET have no "one or more correct"; JEE Advanced adds paragraph and match the column
      if (typBank === V.bank) return; typBank = V.bank;
      const keep = typ.value;
      const list = [["", "All types"], ...Object.entries(QT).filter(([k]) => k !== "multi" || V.bank === "adv" || V.bank === "portal"),
        ...(V.bank === "adv" ? [["style:paragraph", "Paragraph"], ["style:matrix", "Match the column"]] : [])];
      typ.replaceChildren(...list.map(([k, v]) => h("option", { value: k, selected: k === keep }, v)));
      if (typ.value !== keep) typ.value = "";
    };
    const dif = h("select", { id: "qb-diff", "aria-label": "Level" }, h("option", { value: "" }, "Any level"), QLEVELS.map(d => h("option", {}, d)));
    const size = h("select", { id: "qb-size", "aria-label": "Questions per page" }, [10, 15, 20].map(n => h("option", { value: n }, `${n} per page`)));
    const q = h("input", { id: "qb-q", placeholder: "Search words, chapter or exam", "aria-label": "Search" });
    const tabsBox = h("div", { class: "bank-tabs", role: "tablist" }), pyqBox = h("div", { class: "seg" }), subjBox = h("div", { class: "subj-pills" });
    const list = h("div", { class: "qlist" }), count = h("span", { class: "muted small" });
    const pager = h("div", { class: "pager" }), pagerTop = h("div", { class: "pager" });
    const ids = [];
    let page = 0, matching = 0;
    const fill = (sel, first, items, keep) => sel.replaceChildren(h("option", { value: "" }, first), ...items.map(([v, t]) => h("option", { value: v, selected: String(v) === String(keep) }, t)));
    const nice = s => (/^math/i.test(s) ? "Maths" : s.charAt(0).toUpperCase() + s.slice(1).toLowerCase());
    function drawPager(box) {
      const pages = Math.max(1, Math.ceil(matching / +size.value));
      const go = p => { page = Math.min(Math.max(0, p), pages - 1); load(true); };
      const jump = h("input", { type: "number", min: 1, max: pages, value: page + 1, "aria-label": "Page number", style: "width:70px" });
      jump.onchange = () => go(+jump.value - 1);
      box.replaceChildren(h("button", { class: "btn ghost small", type: "button", disabled: page === 0, onclick: () => go(page - 1) }, "‹ Previous"),
        h("span", { class: "small" }, "Page ", jump, ` of ${pages}`),
        h("button", { class: "btn ghost small", type: "button", disabled: page >= pages - 1, onclick: () => go(page + 1) }, "Next ›"));
      box.hidden = matching <= +size.value;
    }
    const pick = (k, v) => { V[k] = v; if (k === "bank") { V.subject = ""; V.chapter = ""; V.pyq = v === "portal" ? "" : "1"; paper.value = ""; yr.value = ""; }
      if (k === "pyq") { V.subject = ""; V.chapter = ""; yr.value = ""; } if (k === "subject") V.chapter = ""; load(false); };
    async function load(keepPage) {
      if (!keepPage) page = 0;
      fillTypes();
      const n = +size.value, jee = V.bank !== "portal";
      const p = new URLSearchParams(Object.entries({ bank: V.bank, pyq: jee ? V.pyq : "", subject: V.subject, chapter: V.chapter, qtype: typ.value.startsWith("style:") ? "" : typ.value, qstyle: typ.value.startsWith("style:") ? typ.value.slice(6) : "", difficulty: dif.value,
        year: jee && V.pyq === "1" ? yr.value : "", paper: jee ? "" : paper.value, q: q.value.trim() }).filter(([, v]) => v));
      p.set("limit", n); p.set("offset", page * n); p.set("full", "1");
      const r = await GET("/api/questions?" + p), F = r.facets;
      tabsBox.replaceChildren(...BANK_TABS.map(([k, t]) => h("button", { type: "button", role: "tab", class: V.bank === k ? "on" : "", "aria-selected": String(V.bank === k), onclick: () => pick("bank", k) },
        h("b", {}, t), h("span", {}, `${(F.banks || {})[k] || 0} questions`))));
      const pc = F.pyq_counts || {};
      pyqBox.hidden = !jee;
      pyqBox.replaceChildren(...[["1", "PYQ", pc.pyq], ["0", "Non-PYQ", pc.practice], ["", "All", (pc.pyq || 0) + (pc.practice || 0)]].map(([v, t, c]) =>
        h("button", { type: "button", class: V.pyq === v ? "on" : "", "aria-pressed": String(V.pyq === v), onclick: () => pick("pyq", v) }, t, h("small", {}, ` ${c || 0}`))));
      const std = BANK_SUBJECTS[V.bank] || [];
      const subs = [...std, ...F.subjects.filter(x => !std.some(y => y.toLowerCase() === x.toLowerCase()))];
      if (!std.length) subs.sort((a, b) => (SUBJ_ORDER.indexOf(a.toLowerCase()) + 1 || 99) - (SUBJ_ORDER.indexOf(b.toLowerCase()) + 1 || 99) || a.localeCompare(b));
      const tot = Object.values(F.subject_counts || {}).reduce((a, b) => a + b, 0);
      subjBox.replaceChildren(...[["", "All subjects", tot], ...subs.map(x => [x, nice(x), Object.entries(F.subject_counts || {}).filter(([k]) => k.toLowerCase() === x.toLowerCase()).reduce((a, [, n]) => a + n, 0)])].map(([v, t, c]) =>
        h("button", { type: "button", class: "sp" + (V.subject.toLowerCase() === v.toLowerCase() ? " on" : "") + (c ? "" : " none"), onclick: () => pick("subject", v) }, t, h("small", {}, c))));
      const sv = V.subject.toLowerCase();
      fill(chap, V.subject ? `All ${nice(V.subject)} chapters` : "All chapters", [...F.chapters.filter(c => !sv || c.subject.toLowerCase() === sv).map(c => [c.chapter, `${c.chapter} (${c.n})`]),
        ...((F.untagged || []).some(x => !sv || x.toLowerCase() === sv) ? [["__none", "Not tagged yet"]] : [])], V.chapter);
      fill(paper, "All imported papers", (F.papers || []).map(x => [x, x]), paper.value); paper.hidden = jee || !(F.papers || []).length;
      fill(yr, "Any year", F.years.map(y => [y, y]), yr.value); yr.hidden = !jee || V.pyq !== "1";
      matching = r.matching;
      ids.length = 0; ids.push(...r.rows.map(x => x.id));
      count.textContent = matching ? `${matching} question${matching === 1 ? "" : "s"} · showing ${page * n + 1}–${page * n + r.rows.length}` : "";
      const emptyMsg = !((F.banks || {})[V.bank]) ? (["adv", "eapcet", "neet"].includes(V.bank) ? `The ${BANK_TABS.find(b => b[0] === V.bank)[1]} is empty for now.` : V.bank === "portal" ? "No questions here yet. Questions from papers you import (a test's Questions tab → Import from PDF) and questions you add yourself appear here." : "This bank is empty. Add a ready-made set above.") : "No questions match these filters.";
      show(list, r.rows.length ? r.rows.map((x, i) => questionCard(x, page * n + i + 1, ids)) : h("p", { class: "empty" }, emptyMsg));
      drawPager(pager); drawPager(pagerTop);
      if (keepPage === true) list.scrollIntoView({ block: "start", behavior: "smooth" });
    }
    chap.onchange = () => { V.chapter = chap.value; load("chap"); };
    [yr, paper, typ, dif, size].forEach(x => (x.onchange = () => load(false)));
    let t; q.oninput = () => { clearTimeout(t); t = setTimeout(() => load(false), 300); };
    show(view, h("div", { class: "head" }, h("div", {}, h("h1", {}, "Question bank"), h("p", { class: "sub" }, "Choose a bank, then PYQ or Non-PYQ, subject and chapter.")),
      h("div", { class: "row" }, h("button", { class: "btn ghost", type: "button", onclick: () => findDuplicates(() => load(true)) }, "Find duplicates"),
        h("a", { class: "btn gold", href: `#/bank/new` }, "Add question"))),
      packsCard(() => load(false)), tabsBox,
      h("div", { class: "card bank-card" }, h("div", { class: "row", style: "align-items:center" }, pyqBox, paper), subjBox,
        h("div", { class: "row" }, chap, yr, typ, dif), h("div", { class: "row", style: "align-items:center" }, q, count, h("span", { class: "shrink" }, size)), pagerTop, list, pager));
    load(false);
  }, ["central"]);

  // groups of identical / nearly identical questions, side by side, with delete
  function findDuplicates(after) {
    const box = h("div", { class: "picker" }), list = h("div", { class: "qlist" }), info = h("p", { class: "small muted", style: "margin:0" }, "Checking every question…");
    async function load() {
      let r; try { r = await GET("/api/questions/duplicates"); } catch (x) { info.textContent = x.message; return; }
      info.textContent = r.total ? `${r.total} group${r.total === 1 ? "" : "s"} of matching questions among ${r.checked}. Questions that are at least 80% the same are shown together. Keep one and delete the others. (NTA sometimes repeats a question in a later year; those are real repeats you may want to keep.)`
        : `No duplicates found among ${r.checked} questions.`;
      const all = await Promise.all(r.groups.slice(0, 30).map(g => Promise.all(g.ids.map(id => GET(`/api/questions/${id}`).catch(() => null)))));
      show(list, r.groups.slice(0, 30).map((g, gi) => h("div", { class: "dup-group" },
        h("h3", {}, `Group ${gi + 1} · ${g.similarity >= 100 ? "identical" : g.similarity + "% the same"}`),
        all[gi].filter(Boolean).map((q, k) => questionCard(q, "ABCDEFGH"[k] || k + 1, [], x => [
          h("a", { class: "btn ghost small", href: `#/bank/${x.id}`, onclick: () => $("#modal").hidden = true }, "Edit"),
          h("button", { class: "btn danger small", type: "button", onclick: async e => {
            e.target.disabled = true;
            try { await DEL(`/api/questions/${x.id}`); toast(`Question ${x.id} deleted`); load(); after(); } catch (err) { toast(err.message); e.target.disabled = false; }
          } }, "Delete")])))));
      if (r.total > 30) list.append(h("p", { class: "small muted" }, `Showing the first 30 groups. Delete some and press Find duplicates again to see the rest.`));
    }
    wideModal((b, close) => { b.append(box); show(box, h("div", { class: "qv-head" }, h("b", {}, "Duplicate questions"), h("span", { class: "small" }),
      h("button", { class: "btn ghost small shrink", type: "button", "aria-label": "Close", onclick: close }, "✕")), info, list); load(); });
  }

  // ready-made questions keep their options as "(A) …" lines at the end of the text: split them off so they can be clicked
  function splitOptions(x) {
    if ((x.options || []).some(Boolean) || x.fmt !== "html" || !(x.qtype === "single" || x.qtype === "multi")) return { stem: x.text, options: x.options || [] };
    const t = x.text || "", at = t.search(/<p>\s*\((A|1)\)/);
    if (at < 0) return { stem: t, options: [] };
    const tail = t.slice(at), re = /<p>\s*\(([A-D1-4])\)\s*([\s\S]*?)<\/p>/g, found = [];
    let m; while ((m = re.exec(tail))) found.push(m[2].trim());
    if (found.length < 2 || found.length > 4 || tail.replace(re, "").trim()) return { stem: t, options: [] };
    return { stem: t.slice(0, at), options: found };
  }
  // options you can click (or a number you can type) to check the answer; "Show answer" reveals it
  function tryIt(x) {
    const box = h("div", { class: "try" }), fb = h("div", { class: "try-fb", "aria-live": "polite" });
    const L = "ABCD", mc = x.qtype === "single" || x.qtype === "multi", ans = String(x.answer || "");
    let done = false;
    const reveal = (msg, good) => { done = true; fb.className = "try-fb " + (good === true ? "ok" : good === false ? "bad" : ""); fb.replaceChildren(msg); again.hidden = false; showBtn.hidden = true; };
    const again = h("button", { class: "link small", type: "button", hidden: true, onclick: () => reset() }, "Try again");
    const showBtn = h("button", { class: "link small", type: "button", onclick: () => mark(null) }, "Show answer");
    let opts = [], input = null, checkBtn = null;
    function mark(picked) {
      if (mc) {
        opts.forEach((b, k) => { b.disabled = true; b.classList.toggle("right", ans.includes(L[k])); b.classList.toggle("wrong", picked != null && picked.includes(L[k]) && !ans.includes(L[k])); });
        if (checkBtn) checkBtn.hidden = true;
      } else if (input) { input.disabled = true; checkBtn.hidden = true; }
      const show = h("span", {}, "Answer: ", h("b", { class: "mono" }, ans.replace(":", " to ")));
      if (picked == null) return reveal(show);
      const good = mc ? [...picked].sort().join("") === ans : (() => { const v = parseFloat(picked); const [lo, hi = lo] = ans.split(":").map(Number); return !isNaN(v) && v >= Math.min(lo, hi) - 1e-9 && v <= Math.max(lo, hi) + 1e-9; })();
      reveal(good ? h("span", {}, "✓ Correct") : h("span", {}, "✗ Not quite. ", show), good);
    }
    function reset() {
      done = false; fb.className = "try-fb"; fb.replaceChildren(); again.hidden = true; showBtn.hidden = false;
      opts.forEach(b => { b.disabled = false; b.classList.remove("right", "wrong", "sel"); b.setAttribute("aria-pressed", "false"); });
      if (input) { input.disabled = false; input.value = ""; checkBtn.hidden = false; }
      if (checkBtn && mc) { checkBtn.hidden = false; checkBtn.disabled = true; }
    }
    const optList = splitOptions(x).options;
    if (mc && optList.some(Boolean)) {
      const multi = x.qtype === "multi";
      if (multi) checkBtn = h("button", { class: "btn small", type: "button", disabled: true, onclick: () => mark(opts.filter(b => b.classList.contains("sel")).map(b => b.dataset.k).join("")) }, "Check");
      opts = optList.map((o, k) => o ? h("button", { type: "button", class: "opt", "data-k": L[k], "aria-pressed": "false", onclick: e => {
        if (done) return; const b = e.currentTarget;
        if (!multi) return mark(L[k]);
        b.classList.toggle("sel"); b.setAttribute("aria-pressed", String(b.classList.contains("sel")));
        checkBtn.disabled = !opts.some(z => z.classList.contains("sel"));
      } }, h("span", { class: "opt-l" }, L[k]), x.fmt === "html" ? richNode(o) : h("span", {}, o)) : null).filter(Boolean);
      opts.forEach(b => renderMath(b));
      box.append(h("div", { class: "opts-i" }, opts), ...(multi ? [h("p", { class: "small muted", style: "margin:0" }, "One or more options may be correct. Pick them, then press Check.")] : []));
    } else if (!mc) {
      input = h("input", { type: "text", inputmode: "decimal", placeholder: x.qtype === "integer" ? "Your answer (integer)" : "Your answer", "aria-label": "Your answer", style: "max-width:200px",
        onkeydown: e => { if (e.key === "Enter") { e.preventDefault(); checkBtn.click(); } } });
      checkBtn = h("button", { class: "btn small", type: "button", onclick: () => input.value.trim() && mark(input.value.trim()) }, "Check");
      box.append(h("div", { class: "row", style: "align-items:center;gap:8px" }, input, checkBtn));
    }
    box.append(h("div", { class: "try-row" }, fb, checkBtn && mc ? checkBtn : null, showBtn, again));
    return box;
  }

  // one question shown in full in the bank list
  function questionCard(x, no, ids, actions) {
    const sol = x.solution ? h("details", { class: "qc-sol" }, h("summary", {}, "Solution")) : null;
    if (sol) sol.addEventListener("toggle", () => { if (sol.open && sol.children.length === 1) sol.append(x.fmt === "html" ? richNode(x.solution) : h("div", { style: "white-space:pre-wrap" }, x.solution)); });
    return h("article", { class: "qc" },
      h("div", { class: "qc-head" }, h("b", { class: "qc-no" }, `${no}.`),
        h("span", { class: "small muted qc-meta" }, [x.chapter, x.topic, x.qstyle === "paragraph" ? "Paragraph" : x.qstyle === "matrix" ? "Match the column" : "", QT[x.qtype]].filter(Boolean).join(" · ")),
        h("span", { class: "pill lv" + (QLEVELS.indexOf(x.difficulty) + 1) }, x.difficulty), x.source ? h("span", { class: "pill navy" }, x.source) : x.exam ? h("span", { class: "pill" }, x.exam) : null),
      x.fmt === "html" ? richNode(splitOptions(x).stem) : x.text ? h("div", { style: "white-space:pre-wrap" }, x.text) : null,
      x.image ? h("img", { src: x.image, alt: `Question ${x.id}`, style: "max-width:100%;border-radius:4px" }) : null,
      tryIt(x),
      h("div", { class: "qc-foot" }, sol,
        h("span", { class: "small muted" }, `ID ${x.id}`), h("span", { style: "flex:1" }),
        actions ? actions(x) : [h("button", { class: "btn ghost small", type: "button", onclick: () => viewQuestion(x.id, ids) }, "View"),
          h("a", { class: "btn small", href: `#/bank/${x.id}` }, "Edit")]));
  }

  // read-only pop-up of a bank question; Edit opens the edit screen; arrows step through the list
  function viewQuestion(id, ids) {
    let cur = id, closeFn = null;
    const keys = e => {
      if ($("#modal").hidden) { document.removeEventListener("keydown", keys); return; }
      if (e.key === "Escape") closeFn();
      else if (e.key === "ArrowRight") step(1); else if (e.key === "ArrowLeft") step(-1);
    };
    const step = d => { const i = ids.indexOf(cur) + d; if (i >= 0 && i < ids.length) { cur = ids[i]; draw(); } };
    let bodyEl;
    async function draw() {
      const box = h("div", { class: "qview" }, h("p", { class: "muted small" }, "Loading…"));
      bodyEl.replaceChildren(box);
      let q; try { q = await GET(`/api/questions/${cur}`); } catch (x) { box.replaceChildren(h("p", { class: "err" }, x.message)); return; }
      if (cur !== q.id) return;
      const i = ids.indexOf(cur);
      show(box,
        h("div", { class: "qv-head" }, h("b", {}, `Question ${q.id}`),
          h("span", { class: "small muted" }, i >= 0 ? `${i + 1} of ${ids.length}` : ""),
          h("button", { class: "btn ghost small shrink", type: "button", "aria-label": "Close", onclick: () => closeFn() }, "✕")),
        h("div", { class: "chips" }, [q.exam, q.chapter, q.topic, QT[q.qtype]].filter(Boolean).map(t => h("span", { class: "chip" }, t)),
          h("span", { class: "pill lv" + (QLEVELS.indexOf(q.difficulty) + 1) }, q.difficulty), q.source ? h("span", { class: "pill navy" }, q.source) : null),
        q.fmt === "html" ? richNode(splitOptions(q).stem) : q.text ? h("div", { style: "white-space:pre-wrap" }, q.text) : null,
        q.image ? h("img", { src: q.image, alt: `Question ${q.id}`, style: "max-width:100%;border-radius:4px" }) : null,
        tryIt(q),
        q.solution ? h("details", {}, h("summary", {}, "Solution"), q.fmt === "html" ? richNode(q.solution) : h("div", { style: "white-space:pre-wrap" }, q.solution)) : null,
        h("div", { class: "qv-foot" },
          h("button", { class: "btn ghost small", type: "button", disabled: i <= 0, onclick: () => step(-1) }, "‹ Previous"),
          h("button", { class: "btn ghost small", type: "button", disabled: i < 0 || i >= ids.length - 1, onclick: () => step(1) }, "Next ›"),
          h("span", { style: "flex:1" }),
          h("button", { class: "btn small", type: "button", onclick: () => { closeFn(); location.hash = `#/bank/${q.id}`; } }, "Edit")));
      bodyEl.parentElement.scrollTop = 0;
    }
    closeFn = modal((b, close) => { bodyEl = b; closeFn = close; draw(); });
    $("#modal .modal-card").classList.add("wide");
    const m = $("#modal"), obs = new MutationObserver(() => { if (m.hidden) { $("#modal .modal-card").classList.remove("wide"); document.removeEventListener("keydown", keys); obs.disconnect(); } });
    obs.observe(m, { attributes: true, attributeFilter: ["hidden"] });
    document.addEventListener("keydown", keys);
  }

  // ready-made question sets that ship with the portal: one click adds them to the bank
  function packsCard(reload) {
    const box = h("div", { class: "card" }, h("h2", {}, "Ready-made question sets"), h("p", { class: "small muted", style: "margin:0" }, "Loading…"));
    GET("/api/packs").then(packs => {
      if (!packs.length) { box.remove(); return; }
      box.replaceChildren(h("h2", {}, "Ready-made question sets"), ...packs.map(p => {
        const done = p.loaded >= p.count;
        const btn = h("button", { class: "btn gold", type: "button", hidden: done, onclick: async () => {
          btn.disabled = true; btn.textContent = `Adding ${p.count - p.loaded} questions…`;
          try { const r = await POST(`/api/packs/${p.id}/load`); toast(`Added ${r.added} questions to the bank`); box.replaceWith(packsCard(reload)); reload(); }
          catch (x) { toast(x.message); btn.disabled = false; btn.textContent = "Try again"; }
        } }, p.loaded ? `Add the remaining ${p.count - p.loaded}` : `Add all ${p.count} questions`);
        return h("div", { class: "row", style: "align-items:center" }, h("div", {}, h("b", {}, p.name), h("div", { class: "small muted" }, p.note,
          done ? ` All ${p.count} are in your bank.` : p.loaded ? ` ${p.loaded} of ${p.count} added.` : "")), done ? h("span", { class: "pill ok shrink" }, "Added") : btn);
      }));
    }).catch(() => box.remove());
    return box;
  }

  route(/^\/bank\/(new|\d+)$/, async (view, id) => {
    const isNew = id === "new";
    const qd = isNew ? { subject: "Physics", chapter: "", topic: "", qtype: "single", difficulty: "Medium", exam: "", text: "", image: "", options: ["", "", "", ""], answer: "", solution: "" } : await GET(`/api/questions/${id}`);
    const subject = h("input", { id: "q-subject", value: qd.subject, list: "subj-list", maxlength: 40 });
    const chapter = h("input", { id: "q-chapter", value: qd.chapter, maxlength: 120 });
    const topic = h("input", { id: "q-topic", value: qd.topic, maxlength: 120 });
    const qtype = h("select", { id: "q-type" }, Object.entries(QT).map(([k, v]) => h("option", { value: k, selected: qd.qtype === k }, v)));
    const diff = h("select", { id: "q-diff" }, QLEVELS.map(d => h("option", { selected: qd.difficulty === d }, d)));
    const exam = h("input", { id: "q-exam", value: qd.exam || "", list: "exam-list", maxlength: 40, placeholder: "e.g. JEE Main" });
    const qstyle = h("select", { id: "q-style" }, [["", "Normal"], ["paragraph", "Paragraph"], ["matrix", "Match the column"]].map(([k, v]) => h("option", { value: k, selected: (qd.qstyle || "") === k }, v)));
    const bank = h("select", { id: "q-bank" }, BANK_TABS.map(([k, t]) => h("option", { value: k, selected: (qd.bank || "portal") === k }, t)));
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
    const preview = qd.fmt === "html" ? h("div", { class: "card" }, h("div", { class: "head" }, h("h2", {}, "How students see it"), qd.source ? h("span", { class: "pill navy" }, qd.source) : null),
      richNode(qd.text), h("div", { class: "small" }, h("b", {}, "Answer: "), qd.answer),
      qd.solution ? h("details", {}, h("summary", {}, "Solution"), richNode(qd.solution)) : null) : null;
    show(view, h("div", { class: "head" }, h("div", {}, h("a", { href: "#/bank" }, "‹ Question bank"), h("h1", {}, isNew ? "New question" : `Question ${id}`))), preview,
      h("form", { class: "card", onsubmit: async e => {
        e.preventDefault(); err.textContent = "";
        const body = { subject: subject.value, chapter: chapter.value, topic: topic.value, qtype: qtype.value, difficulty: diff.value, text: text.value, image, options: opts.map(o => o.value), answer: answer.value, solution: solution.value, fmt: qd.fmt || "", source: qd.source || "", bank: bank.value, qstyle: qstyle.value, exam: exam.value };
        try { if (isNew) { const r = await POST("/api/questions", body); toast("Question saved"); location.hash = `#/bank/${r.id}`; } else { await PUT(`/api/questions/${id}`, body); toast("Saved"); } }
        catch (x) { err.textContent = x.message; }
      } },
        h("datalist", { id: "subj-list" }, ["Physics", "Chemistry", "Mathematics", "Botany", "Zoology"].map(s => h("option", { value: s }))),
        h("div", { class: "row" }, field("Subject", subject), field("Chapter", chapter), field("Topic", topic, "Optional")),
        h("datalist", { id: "exam-list" }, ["JEE Main", "JEE Advanced", "NEET", "EAPCET", "Board"].map(s => h("option", { value: s }))),
        h("div", { class: "row" }, field("Question type", qtype), field("Level", diff), field("Exam", exam, "Optional"), field("Bank", bank), field("Style", qstyle, "Paragraph or match the column (JEE Advanced)")),
        field("Question", text, "Type the question, or add an image of it below (or both)."),
        h("div", { class: "row" }, field("Question image", imgIn, "PNG or JPG, up to 2 MB"), rmImg), imgPrev,
        optBox, h("label", { class: "f" }, "Correct answer", ansHint, answer), field("Solution", solution, "Optional. Shown to students after results are published."), err,
        h("div", { class: "row" }, h("button", { class: "btn", type: "submit" }, "Save question"),
          !isNew ? h("button", { class: "btn danger", type: "button", onclick: () => confirmBox("Delete this question?", "Delete", async () => { try { await DEL(`/api/questions/${id}`); location.hash = "#/bank"; } catch (x) { toast(x.message); } }) }, "Delete") : null)));
    sync(); showImg();
  }, ["central"]);

  // ================================================================ tests
  route(/^\/tests$/, async view => {
    const [tests] = await Promise.all([GET("/api/tests"), structure()]);
    let kind = "", look = "cards";
    try { look = localStorage.getItem("tests-look") || "cards"; } catch (e) { /* ignore */ }
    const q = h("input", { placeholder: "Search test name or code", "aria-label": "Search tests" });
    const stSel = h("select", { "aria-label": "Status" }, [["", "Any status"], ["live", "Live now"], ["upcoming", "Upcoming"], ["pub", "Published"], ["unpub", "Not published"]].map(([v, t]) => h("option", { value: v }, t)));
    const seg = h("div", { class: "seg", role: "group", "aria-label": "Exam type" });
    const lookBtn = h("button", { class: "btn ghost small", type: "button" });
    const box = h("div", {}), count = h("span", { class: "small muted" });
    function draw() {
      seg.replaceChildren(...[["", "All"], ["online", "Online"], ["omr", "OMR"]].map(([v, t]) => h("button", { type: "button", class: kind === v ? "on" : "", "aria-pressed": String(kind === v), onclick: () => { kind = v; draw(); } },
        t, h("small", {}, ` ${tests.filter(x => !v || (v === "omr" ? !x.mode || x.mode === "omr" : x.mode && x.mode !== "omr")).length}`))));
      lookBtn.textContent = look === "cards" ? "☰ List view" : "▦ Card view";
      const words = q.value.trim().toLowerCase();
      const list = tests.filter(t => (!kind || (kind === "omr" ? !t.mode || t.mode === "omr" : t.mode && t.mode !== "omr"))
        && (!words || (t.name + " " + t.code).toLowerCase().includes(words))
        && (!stSel.value || (stSel.value === "pub" ? t.published : stSel.value === "unpub" ? !t.published : (testStatus(t) || [])[0] === stSel.value)));
      count.textContent = `${list.length} of ${tests.length} tests`;
      show(box, look === "cards" ? (list.length ? h("div", { class: "ecards" }, list.map(examCard)) : h("p", { class: "empty" }, tests.length ? "No tests match." : "No tests yet.")) : testsList(list));
    }
    lookBtn.onclick = () => { look = look === "cards" ? "list" : "cards"; try { localStorage.setItem("tests-look", look); } catch (e) { /* ignore */ } draw(); };
    q.oninput = draw; stSel.onchange = draw;
    show(view, h("div", { class: "head" }, h("div", {}, h("h1", {}, "Exams (Online & OMR)"), h("p", { class: "sub" }, "Create and edit exams, and view results. Click a card to open it.")),
      state.me.role === "central" ? h("a", { class: "btn gold", href: "#/tests/new" }, "New test") : null),
      h("div", { class: "ec-bar" }, seg, q, stSel, count, h("span", { style: "flex:1" }), lookBtn), box);
    draw();
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
    const DEF_MIN = { JM: 180, RJM: 180, JA: 180, NEET: 200, R180: 180, JMP: 60, JAP: 60, NEETP: 60, DR30: 30 };
    const mode = h("select", { id: "t-mode" }, [["omr", "On OMR sheets (paper)"], ["cbt", "Online (computer-based, NTA style)"], ["both", "Both: online and on OMR sheets"]].map(([v, l]) => h("option", { value: v, selected: (t.mode || "omr") === v }, l)));
    const dur = h("input", { id: "t-duration", type: "number", min: 5, max: 600, value: t.duration || DEF_MIN[t.sheet] || 180, style: "max-width:140px" });
    const localDT = ms => { if (!ms) return ""; const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };
    const opens = h("input", { id: "t-opens", type: "datetime-local", value: localDT(t.opens_at) }), closes = h("input", { id: "t-closes", type: "datetime-local", value: localDT(t.closes_at) });
    const exitsSel = h("select", { id: "t-exits" }, [[0, "Never — only warn"], [10, "After 10 exits"]].map(([v, l]) => h("option", { value: v, selected: (t.max_exits || 0) === v }, l)));
    const cbtBox = h("div", { class: "row" }, field("Duration (minutes)", dur), field("Auto-submit", exitsSel, "Leaving the test window (another app, tab or window) counts as an exit. Every exit is recorded; from the 5th exit students get a warning."), field("Opens at", opens, "Optional. Students can start from this time."), field("Closes at", closes, "Optional. No one can start after this, and time ends here."));
    const syncMode = () => (cbtBox.hidden = mode.value === "omr");
    const levelFilter = h("select", { id: "t-level", "aria-label": "Select by class" }, h("option", { value: "" }, "Tick all of a class…"), ["11", "12", "Dropper"].map(l => h("option", { value: l }, `All ${LEVEL[l]} batches`)));
    const checks = h("div", { class: "checks" });
    const drawChecks = () => checks.replaceChildren(...state.s.batches.map(bt => h("label", {}, h("input", { type: "checkbox", checked: chosen.has(bt.id), onchange: e => { e.target.checked ? chosen.add(bt.id) : chosen.delete(bt.id); } }),
      `${bt.name} · ${LEVEL[bt.level]} · ${campusName(bt.campus_id)}`)));
    levelFilter.onchange = () => { state.s.batches.filter(bt => bt.level === levelFilter.value).forEach(bt => chosen.add(bt.id)); levelFilter.value = ""; drawChecks(); };
    drawChecks();
    sheet.addEventListener("change", () => { if (!t.duration) dur.value = DEF_MIN[sheet.value] || 180; });
    mode.onchange = syncMode; syncMode();
    const err = h("p", { class: "err small" });
    show(view, h("div", { class: "head" }, h("div", {}, h("a", { href: isNew ? "#/tests" : `#/tests/${id}` }, "‹ Back"), h("h1", {}, isNew ? "New test" : "Edit test"))),
      h("form", { class: "card", onsubmit: async e => {
        e.preventDefault(); err.textContent = "";
        const body = { code: code.value, name: name.value, test_date: date.value, sheet: sheet.value, batch_ids: [...chosen],
          mode: mode.value, duration: +dur.value, max_exits: +exitsSel.value, opens_at: opens.value ? new Date(opens.value).getTime() : null, closes_at: closes.value ? new Date(closes.value).getTime() : null };
        try { const r = isNew ? await POST("/api/tests", body) : await PUT(`/api/tests/${id}`, body); location.hash = isNew ? `#/tests/${r.id}/questions` : `#/tests/${id}`; }
        catch (x) { err.textContent = x.message; }
      } }, h("div", { class: "row" }, field("Test code", code, "Short, printed in the QR of every sheet"), field("Test name", name), field("Date", date)),
        field("Paper pattern", sheet, "Sets the sections, question types and marking scheme (also the OMR sheet design)."),
        field("How students write it", mode), cbtBox,
        h("div", { class: "row" }, h("h3", { class: "shrink" }, "Batches writing this test"), levelFilter), checks, err,
        h("div", { class: "row" }, h("button", { class: "btn", type: "submit" }, isNew ? "Create test" : "Save"),
          !isNew ? h("button", { class: "btn danger", type: "button", onclick: () => confirmBox("Delete this test and all its results?", "Delete", async () => { await DEL(`/api/tests/${id}`); location.hash = "#/tests"; }) }, "Delete test") : null)));
  }, ["central"]);

  route(/^\/tests\/(\d+)\/import$/, async (view, id) => {
    await need("pdf", "pdfworker", "importer");
    const t = await GET(`/api/tests/${id}`);
    window.TPImport.page(view, t, O.getLayout(t.sheet), h("a", { href: `#/tests/${id}/questions` }, "‹ Questions"));
  }, ["central"]);
  route(/^\/tests\/(\d+)(?:\/(key|sheets|scans|results|questions|toppers|analysis))?$/, async (view, id, tab = "results") => {
    if (tab === "toppers") tab = "analysis";
    await structure();
    const t = await GET(`/api/tests/${id}`);
    const layout = O.getLayout(t.sheet);
    const central = state.me.role === "central";
    const tabs = [["results", "Results"], ["analysis", "Analysis"], ["discuss", "Paper discussion"], ["sheets", "Print sheets"], ["scans", "Upload scans"], ...(central ? [["questions", "Questions"], ["key", "Answer key"]] : [])];
    const body = h("div", { style: "display:grid;gap:16px" });
    show(view, 
      h("div", { class: "head" }, h("div", {}, h("a", { href: "#/tests" }, "‹ Tests"), h("h1", {}, `${t.name}`),
        h("p", { class: "sub" }, `${t.code} · ${fmtDate(t.test_date)} · ${t.sheet_title} · ${t.questions} questions · ${t.batch_ids.length} batch${t.batch_ids.length === 1 ? "" : "es"}`)),
        h("div", { class: "row" }, t.mode && t.mode !== "omr" ? h("span", { class: "pill navy" }, t.mode === "cbt" ? `Online · ${t.duration} min` : `Online + OMR · ${t.duration} min`) : null,
          h("span", { class: "pill " + (t.published ? "ok" : "warn") }, t.published ? "Published to students" : "Not published yet"),
          h("a", { class: "btn gold small", href: `#/print/${id}` }, "Print paper"),
          central ? h("a", { class: "btn ghost small", href: `#/tests/${id}/edit` }, "Edit") : null)),
      h("div", { class: "tabs" }, tabs.map(([k, v]) => h("a", { href: k === "discuss" ? `#/discuss/${id}` : `#/tests/${id}/${k}`, class: k === tab ? "on" : "" }, v))), body);
    if (tab === "key" && central) return keyTab(body, t, layout);
    if (tab === "analysis") { if (await resultsTab(body, t, layout, "analysis") !== false) await toppersTab(body, t, true); return; }
    if (tab === "questions" && central) return questionsTab(body, t, layout);
    if (tab === "sheets") return sheetsTab(body, t, layout);
    if (tab === "scans") return scansTab(body, t, layout);
    if (t.mode && t.mode !== "omr") body.append(await attemptsCard(t));
    return resultsTab(body, t, layout);
  }, ["central", "zone", "campus"]);
  async function attemptsCard(t) {
    const list = await GET(`/api/tests/${t.id}/attempts`);
    const when = ms => (ms ? new Date(ms).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "");
    const win = [t.opens_at ? `opens ${when(t.opens_at)}` : "open now", t.closes_at ? `closes ${when(t.closes_at)}` : "no closing time"].join(" · ");
    const done = list.filter(a => a.submitted_at).length;
    const box = h("div", { class: "card" }, h("div", { class: "head" }, h("div", {}, h("h2", {}, "Online test"),
      h("p", { class: "small muted", style: "margin:0" }, `${t.duration} minutes · ${win} · ${list.length} started · ${done} submitted. Submitted answers are marked with the answer key like OMR sheets.`))));
    if (list.length) box.append(h("details", {}, h("summary", {}, "Students who started"), h("div", { class: "tablebox" }, h("table", {}, h("thead", {}, h("tr", {}, ["Roll", "Name", "Started", "Status", "Left the test", ""].map(x => h("th", {}, x)))),
      h("tbody", {}, list.map(a => h("tr", {}, h("td", { class: "mono" }, a.roll), h("td", {}, a.name), h("td", {}, when(a.started_at)),
        h("td", {}, a.auto_submitted ? h("span", { class: "pill bad" }, "Auto-submitted") : a.submitted_at ? h("span", { class: "pill ok" }, "Submitted") : Date.now() < a.ends_at ? h("span", { class: "pill warn" }, "Writing now") : h("span", { class: "pill" }, "Time over")),
        h("td", {}, a.exits ? h("span", { class: "pill " + (a.exits >= 5 ? "bad" : "warn") }, `${a.exits} time${a.exits === 1 ? "" : "s"}`) : h("span", { class: "muted" }, "0"),
          a.screen_off ? h("div", { class: "small muted" }, `screen went dark ${a.screen_off}× (not counted)`) : null),
        h("td", {}, h("button", { class: "link small", type: "button", onclick: () => confirmBox(`Let ${a.name || a.roll} take the test again? Their online answers for this test will be deleted.`, "Allow retake", async () => {
          try { await DEL(`/api/tests/${t.id}/attempts/${a.student_id}`); toast("They can start again"); render(); } catch (x) { toast(x.message); } }) }, "Allow retake")))))))));
    return box;
  }

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
      h("div", { class: "card" }, h("p", { class: "small", style: "margin:0" }, `${t.linked.length} of ${idx.length} questions are picked from the question bank; their answers are filled in above automatically. `,
        h("a", { href: `#/tests/${t.id}/questions` }, "Pick questions"))));
  }


  // ================================================================ analysis dashboard
  const SERIES = ["#257de0", "#f47230", "#00b894", "#f2a600", "#ee7fac", "#008a17", "#6a4ce2", "#ec4647"];
  const SERIES_DARK = ["#338ced", "#e76624", "#00a888", "#d28e05", "#e24d8b", "#0aac23", "#9887ef", "#eb6263"];
  const seriesColor = i => (matchMedia("(prefers-color-scheme: dark)").matches ? SERIES_DARK : SERIES)[i % 8];
  const svgEl = (tag, attrs, text) => { const e = document.createElementNS("http://www.w3.org/2000/svg", tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (text != null) e.textContent = text; return e; };
  // line chart of percentages across tests, with crosshair tooltip and legend
  function lineChart({ labels, sub, series, height = 300, title }) {
    const W = 860, H = height, L = 44, R = 110, T = 14, B = 44;
    const n = labels.length;
    const x = i => (n === 1 ? (L + W - R) / 2 : L + (i * (W - L - R)) / (n - 1));
    const vals = series.flatMap(s => s.values.filter(v => v != null));
    const lo = Math.max(0, Math.floor((Math.min(...vals, 100) - 5) / 10) * 10), hi = Math.min(100, Math.ceil((Math.max(...vals, 0) + 5) / 10) * 10);
    const y = v => T + ((hi - v) * (H - T - B)) / (hi - lo || 1);
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "dash-chart", role: "img", "aria-label": title || "Trend of average percentage across tests" });
    for (let v = lo; v <= hi; v += hi - lo > 40 ? 20 : 10) svg.append(svgEl("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), class: "grid" }), svgEl("text", { x: L - 8, y: y(v) + 4, "text-anchor": "end", class: "axis" }, `${v}%`));
    const every = Math.ceil(n / 12);
    labels.forEach((lab, i) => { if (i % every === 0 || i === n - 1) { svg.append(svgEl("text", { x: x(i), y: H - 24, "text-anchor": "middle", class: "axis" }, lab)); if (sub && sub[i]) svg.append(svgEl("text", { x: x(i), y: H - 10, "text-anchor": "middle", class: "axis small" }, sub[i])); } });
    const ends = [];
    series.forEach(s => {
      if (s.hidden) return;
      let d = "", pen = false;
      s.values.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? "L" : "M"}${x(i)},${y(v)} `; pen = true; });
      svg.append(svgEl("path", { d, class: "ln" + (s.dashed ? " dashed" : ""), stroke: s.color }));
      s.values.forEach((v, i) => { if (v != null) svg.append(svgEl("circle", { cx: x(i), cy: y(v), r: 4, fill: s.color, class: "pt" })); });
      const li = s.values.map((v, i) => (v != null ? i : -1)).filter(i => i >= 0).pop();
      if (li != null && li >= 0) ends.push({ s, yv: y(s.values[li]), x: x(li) });
    });
    if (series.filter(s => !s.hidden).length <= 4) { // direct labels at line ends, nudged apart
      ends.sort((a, b) => a.yv - b.yv);
      for (let i = 1; i < ends.length; i++) if (ends[i].yv - ends[i - 1].yv < 14) ends[i].yv = ends[i - 1].yv + 14;
      ends.forEach(e => svg.append(svgEl("text", { x: W - R + 8, y: e.yv + 4, class: "endlab" }, e.s.name.length > 14 ? e.s.name.slice(0, 13) + "…" : e.s.name)));
    }
    const cross = svgEl("line", { y1: T, y2: H - B, class: "cross", visibility: "hidden" });
    const hit = svgEl("rect", { x: L - 10, y: 0, width: W - L - R + 20, height: H, fill: "transparent" });
    svg.append(cross, hit);
    const tip = h("div", { class: "dash-tip", hidden: true });
    const box = h("div", { class: "dash-chartbox" }, svg, tip);
    hit.addEventListener("mousemove", e => {
      const r = svg.getBoundingClientRect(), px = ((e.clientX - r.left) / r.width) * W;
      const i = Math.max(0, Math.min(n - 1, Math.round(n === 1 ? 0 : ((px - L) / (W - L - R)) * (n - 1))));
      cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("visibility", "visible");
      const rows = series.filter(s => !s.hidden && s.values[i] != null).sort((a, b) => b.values[i] - a.values[i]);
      show(tip, h("b", {}, labels[i] + (sub && sub[i] ? ` · ${sub[i]}` : "")), rows.map(s => h("div", { class: "tr" }, h("i", { style: `background:${s.color}` }), h("span", {}, s.name), h("b", {}, `${s.values[i]}%`))));
      tip.hidden = !rows.length;
      const left = (x(i) / W) * r.width;
      tip.style.left = Math.min(r.width - 220, Math.max(0, left + 12)) + "px";
    });
    hit.addEventListener("mouseleave", () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); });
    return box;
  }

  route(/^\/dashboard$/, async view => {
    let st = {}; try { st = JSON.parse(sessionStorage.getItem("tp-dash") || "{}"); } catch (e) { /* off */ }
    st = Object.assign({ by: state.me.role === "central" ? "zone" : state.me.role === "zone" ? "campus" : "batch", zone_id: "", campus_id: "", level: "", sheet: "", last: "10", published: "" }, st);
    const save = () => { try { sessionStorage.setItem("tp-dash", JSON.stringify(st)); } catch (e) { /* off */ } };
    const body = h("div", { style: "display:grid;gap:16px" });
    async function draw() {
      save();
      const p = new URLSearchParams(Object.entries(st).filter(([, v]) => v));
      const r = await GET("/api/dashboard?" + p);
      const o = r.options;
      const seg = h("div", { class: "seg-row", role: "group", "aria-label": "Compare" }, [["all", "Whole institute"], ...(r.role === "central" ? [["zone", "Zones"]] : []), ...(r.role !== "campus" ? [["campus", "Campuses"]] : []), ["batch", "Batches"]]
        .map(([v, t]) => h("button", { type: "button", class: "btn small " + (st.by === v ? "" : "ghost"), onclick: () => { st.by = v; draw(); } }, t)));
      const sel = (id, label, first, items, k, after) => h("select", { id, "aria-label": label, onchange: e => { st[k] = e.target.value; if (after) after(); draw(); } },
        h("option", { value: "" }, first), items.map(([v, t]) => h("option", { value: v, selected: String(st[k]) === String(v) }, t)));
      const zs = o.zones.length ? sel("d-zone", "Zone", "All zones", o.zones.map(z => [z.id, z.name]), "zone_id", () => (st.campus_id = "")) : null;
      const cs = r.role !== "campus" ? sel("d-campus", "Campus", "All campuses", o.campuses.filter(c => !st.zone_id || c.zone_id === +st.zone_id).map(c => [c.id, c.name]), "campus_id") : null;
      const ls = sel("d-level", "Class", "All classes", o.levels.map(l => [l, /^\d+$/.test(l) ? `Class ${l}` : l]), "level");
      const ps = sel("d-sheet", "Pattern", "All patterns", o.sheets.map(s => [s.id, s.title]), "sheet");
      const lt = h("select", { id: "d-last", "aria-label": "Tests shown", onchange: e => { st.last = e.target.value; draw(); } }, [["10", "Last 10 tests"], ["20", "Last 20 tests"], ["", "All tests"]].map(([v, t]) => h("option", { value: v, selected: st.last === v }, t)));
      const pub = h("label", { class: "pp-opt" }, h("input", { type: "checkbox", checked: st.published === "1", onchange: e => { st.published = e.target.checked ? "1" : ""; draw(); } }), "Published tests only");
      const filters = h("div", { class: "card" }, h("div", { class: "row", style: "align-items:center" }, h("b", { class: "shrink" }, "Compare"), seg),
        h("div", { class: "filters" }, zs, cs, ls, ps, lt, pub));
      if (!r.tests.length) { show(body, filters, h("div", { class: "card" }, h("p", { class: "empty" }, "No marks yet for this selection. Results appear here once sheets are read or online tests are submitted."))); return; }
      const T = r.tests, labels = T.map(t => t.code), sub = T.map(t => (t.test_date ? fmtDate(t.test_date).replace(/ \d{4}$/, "") : ""));
      const lastT = T[T.length - 1], prevT = T[T.length - 2];
      const delta = prevT ? +(lastT.avg_pct - prevT.avg_pct).toFixed(1) : null;
      // groups: change from first to last test each group wrote
      const gl = r.groups.map(g => { const pts = T.map(t => g.points[t.id]).filter(Boolean); const first = pts[0], last = pts[pts.length - 1];
        const prev = pts[pts.length - 2]; return { ...g, change: pts.length > 1 ? +(last.avg_pct - first.avg_pct).toFixed(1) : null, recent: prev ? +(last.avg_pct - prev.avg_pct).toFixed(1) : null, latest: last.avg_pct }; });
      const best = r.by !== "all" && gl.length > 1 ? gl.filter(g => g.change != null).sort((a, b) => b.change - a.change)[0] : null;
      const arrow = v => (v > 0 ? "▲ " : v < 0 ? "▼ " : "");
      const kpis = h("div", { class: "stats" },
        h("div", { class: "stat" }, h("b", {}, T.length), h("span", {}, "Tests in this view")),
        h("div", { class: "stat gold" }, h("b", {}, `${lastT.avg_pct}%`), h("span", {}, `Average in latest test (${lastT.code}, ${lastT.n} students)`)),
        delta != null ? h("div", { class: "stat " + (delta >= 0 ? "ok" : "warn") }, h("b", {}, `${arrow(delta)}${delta > 0 ? "+" : ""}${delta}`), h("span", {}, `Points vs previous test (${prevT.code})`)) : null,
        T.length > 1 ? (() => { const c = +(lastT.avg_pct - T[0].avg_pct).toFixed(1); return h("div", { class: "stat " + (c >= 0 ? "ok" : "warn") }, h("b", {}, `${arrow(c)}${c > 0 ? "+" : ""}${c}`), h("span", {}, `Points since ${T[0].code}`)); })() : null,
        best && best.change > 0 ? h("div", { class: "stat ok" }, h("b", { style: "font-size:20px" }, best.name), h("span", {}, `Most improved: +${best.change} points`)) : null);
      // chart series (8 max, in a fixed order; the rest are in the table)
      const shownG = gl.slice(0, 8);
      const series = r.by === "all" ? [{ name: "All students", color: seriesColor(0), values: T.map(t => t.avg_pct) }]
        : [...shownG.map((g, i) => ({ name: g.name, color: seriesColor(i), values: T.map(t => (g.points[t.id] ? g.points[t.id].avg_pct : null)) })),
          ...(gl.length > 1 ? [{ name: "Overall", color: "var(--fg)", dashed: true, values: T.map(t => t.avg_pct) }] : [])];
      const legend = h("div", { class: "dash-legend" }, series.map(s => h("label", {}, h("input", { type: "checkbox", checked: true, onchange: e => { s.hidden = !e.target.checked; chartBox.replaceChildren(lineChart({ labels, sub, series })); } }),
        h("i", { class: s.dashed ? "dash" : "", style: `background:${s.color}` }), s.name)));
      const chartBox = h("div", {}, lineChart({ labels, sub, series }));
      const what = { all: "the whole institute", zone: "each zone", campus: "each campus", batch: "each batch" }[r.by];
      const chartCard = h("div", { class: "card" }, h("div", { class: "head" }, h("h2", {}, `Average % in each test — ${what}`),
        h("span", { class: "small muted" }, "Marks as % of the test's maximum, so different tests can be compared")), legend, chartBox,
        gl.length > 8 ? h("p", { class: "small muted", style: "margin:0" }, `The chart shows the first 8 of ${gl.length}. All are in the table below.`) : null);
      // table: groups x tests
      const drill = g => { if (r.by === "zone") { st.by = "campus"; st.zone_id = String(g.id); st.campus_id = ""; draw(); } else if (r.by === "campus") { st.by = "batch"; st.campus_id = String(g.id); draw(); } };
      const cell = v => (v ? h("td", { class: "num" }, `${v.avg_pct}%`, h("div", { class: "small muted" }, `${v.n} st.`)) : h("td", { class: "num muted" }, "—"));
      const chg = v => h("td", { class: "num" }, v == null ? "—" : h("span", { class: "pill " + (v >= 0 ? "ok" : "bad") }, `${arrow(v)}${v > 0 ? "+" : ""}${v}`));
      const rowsT = (r.by === "all" ? [{ name: "All students", points: Object.fromEntries(T.map(t => [t.id, { avg_pct: t.avg_pct, n: t.n }])), change: T.length > 1 ? +(lastT.avg_pct - T[0].avg_pct).toFixed(1) : null, recent: delta }] : gl);
      const table = h("div", { class: "card" }, h("div", { class: "head" }, h("h2", {}, "Test by test"), r.by === "zone" || r.by === "campus" ? h("span", { class: "small muted" }, `Click a ${r.by} to see its ${r.by === "zone" ? "campuses" : "batches"}`) : null),
        h("div", { class: "tablebox" }, h("table", { class: "dash-table" },
          h("thead", {}, h("tr", {}, h("th", {}, { all: "", zone: "Zone", campus: "Campus", batch: "Batch" }[r.by]), T.map((t, i) => h("th", { class: "num", title: t.name }, t.code, h("div", { class: "small" }, sub[i]))), h("th", { class: "num" }, "Since first"), h("th", { class: "num" }, "Vs previous"))),
          h("tbody", {}, rowsT.map(g => h("tr", { tabindex: r.by === "zone" || r.by === "campus" ? 0 : null, onclick: () => drill(g), onkeydown: e => e.key === "Enter" && drill(g) },
            h("td", {}, h("b", {}, g.name)), T.map(t => cell(g.points[t.id])), chg(g.change), chg(g.recent)))))));
      // subjects
      const subjCard = r.subjects.length > 1 ? h("div", { class: "card" }, h("h2", {}, "Subjects — average % (this selection)"),
        lineChart({ labels, sub, height: 240, title: "Subject averages across tests", series: r.subjects.map((k, i) => ({ name: k.charAt(0) + k.slice(1).toLowerCase(), color: seriesColor(i), values: T.map(t => (t.subjects[k] != null ? t.subjects[k] : null)) })) })) : null;
      // tests list
      const testsCard = h("div", { class: "card" }, h("h2", {}, "Tests"), h("div", { class: "tablebox" }, h("table", {},
        h("thead", {}, h("tr", {}, ["Test", "Date", "Students", "Average", "Top score", "60% or more"].map(x => h("th", {}, x)))),
        h("tbody", {}, [...T].reverse().map(t => h("tr", { tabindex: 0, onclick: () => (location.hash = `#/tests/${t.id}`), onkeydown: e => e.key === "Enter" && (location.hash = `#/tests/${t.id}`) },
          h("td", {}, h("b", {}, t.code), " ", t.name), h("td", {}, fmtDate(t.test_date)), h("td", { class: "num" }, t.n), h("td", { class: "num" }, `${t.avg_pct}% (${t.avg_marks}/${t.max})`), h("td", { class: "num" }, `${t.top_pct}%`), h("td", { class: "num" }, `${t.above60}% of students`)))))));
      const crumbs = [];
      if (st.zone_id) crumbs.push(h("button", { class: "link", type: "button", onclick: () => { st.zone_id = ""; st.campus_id = ""; st.by = r.role === "central" ? "zone" : st.by; draw(); } }, "All zones"), " › ", (o.zones.find(z => z.id === +st.zone_id) || {}).name || "");
      if (st.campus_id) crumbs.push(" › ", (o.campuses.find(c => c.id === +st.campus_id) || {}).name || "");
      show(body, filters, crumbs.length ? h("p", { class: "small", style: "margin:0" }, crumbs) : null, kpis, chartCard, table, subjCard, testsCard);
    }
    show(view, h("div", { class: "head" }, h("div", {}, h("h1", {}, "Analysis"), h("p", { class: "sub" }, "How marks are moving from test to test, for the whole institute, each zone, campus or batch."))), body);
    await draw();
  }, ["central", "zone", "campus"]);

  // ================================================================ printed papers
  // heading used on every printed paper: logo, institute name, a second line, default instructions
  route(/^\/settings\/paper$/, async view => {
    const st = await GET("/api/settings/paper");
    let logo = st.logo || "";
    const inst = h("input", { id: "ps-inst", value: st.institute, maxlength: 120, placeholder: "Institute name, as it should appear on papers" });
    const tag = h("input", { id: "ps-tag", value: st.tagline, maxlength: 160, placeholder: "e.g. Madhapur, Hyderabad · Ph. 98xxxxxx · www.example.com" });
    const ins = h("textarea", { id: "ps-inst-text", rows: 5, placeholder: "Optional extra instructions, one per line. Marking rules for each section are added automatically." }, st.instructions || "");
    const prev = h("img", { alt: "Logo", style: "max-height:70px;max-width:220px" });
    const rm = h("button", { class: "btn ghost small", type: "button", onclick: () => { logo = ""; draw(); } }, "Remove logo");
    const file = h("input", { id: "ps-logo", type: "file", accept: "image/png,image/jpeg,image/webp" });
    const draw = () => { prev.hidden = !logo; rm.hidden = !logo; if (logo) prev.src = logo; };
    file.onchange = () => {
      const f = file.files[0]; if (!f) return;
      const img = new Image(), url = URL.createObjectURL(f);
      img.onload = () => { // shrink to a sharp but small image so papers stay light
        const scale = Math.min(1, 600 / img.width, 240 / img.height), c = document.createElement("canvas");
        c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
        const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height); x.drawImage(img, 0, 0, c.width, c.height);
        logo = c.toDataURL("image/png"); if (logo.length > 380000) logo = c.toDataURL("image/jpeg", 0.85);
        URL.revokeObjectURL(url); draw();
      };
      img.src = url;
    };
    const err = h("p", { class: "err small" });
    show(view, h("div", { class: "head" }, h("div", {}, h("a", { href: "javascript:history.back()" }, "‹ Back"), h("h1", {}, "Paper heading"),
      h("p", { class: "sub" }, "Shown at the top of every printed question paper, answer key and solutions sheet."))),
      h("form", { class: "card", onsubmit: async e => {
        e.preventDefault(); err.textContent = "";
        try { await PUT("/api/settings/paper", { institute: inst.value.trim(), tagline: tag.value.trim(), instructions: ins.value, logo }); toast("Paper heading saved"); }
        catch (x) { err.textContent = x.message; }
      } }, field("Institute name", inst), field("Second line", tag, "Optional: campus, address, phone or website"),
        h("div", { class: "row", style: "align-items:center" }, field("Logo", file, "PNG or JPG. A logo on a white background prints best."), h("span", { class: "shrink" }, prev), rm),
        field("Extra instructions", ins), err, h("div", {}, h("button", { class: "btn", type: "submit" }, "Save heading"))));
    draw();
  }, ["central"]);

  // ================================================================ paper discussion report: most skipped, most wrong, easy ones missed, with names
  route(/^\/discuss\/(\d+)$/, async (view, id) => {
    await structure();
    const [t, brand] = await Promise.all([GET(`/api/tests/${id}`), GET("/api/brand").catch(() => ({}))]);
    const me = state.me, s = state.s;
    const pref = (() => { try { return JSON.parse(localStorage.getItem("tp-discuss") || "{}"); } catch (e) { return {}; } })();
    const opt = Object.assign({ subject: "", top: "10", showQ: true, names: true, campus: "", batch: "" }, pref);
    const keep = () => { try { localStorage.setItem("tp-discuss", JSON.stringify(opt)); } catch (e) { /* off */ } };
    const testBatches = s.batches.filter(b => t.batch_ids.includes(b.id));
    const campuses = s.campuses.filter(c => testBatches.some(b => b.campus_id === c.id));
    if (me.role === "campus") opt.campus = String(me.campus_id || (campuses[0] || {}).id || "");
    if (opt.campus && !campuses.some(c => String(c.id) === String(opt.campus))) opt.campus = campuses.length === 1 ? String(campuses[0].id) : "";
    const out = h("div", { class: "pp-out dq-out" }), note = h("span", { class: "small muted" });
    const nice = x => (x ? x[0] + x.slice(1).toLowerCase() : "");
    const ans = (q, a) => (!a ? "—" : q.opts === "1234" && /^[A-D]+$/.test(a) ? [...a].map(c => "ABCD".indexOf(c) + 1).join(", ") : (q.qtype === "multi" ? [...a].join(", ") : a));
    const pc = (k, n) => (n ? Math.round((k / n) * 100) : 0);
    let data = null;
    async function load() {
      note.textContent = "Loading…";
      const p = new URLSearchParams(Object.entries({ campus: opt.campus, batch: opt.batch }).filter(([, v]) => v));
      try { data = await GET(`/api/tests/${id}/discussion?${p}`); note.textContent = ""; draw(); } catch (e) { note.textContent = e.message; }
    }
    const people = (label, list, withAns, q) => {
      if (!list.length) return null;
      // when most of the room is on the list, name the few who are not
      if (!withAns && list.length >= 8 && list.length > q.n * 0.7) {
        const on = new Set(list.map(p => String(p.roll))), rest = data.roster.filter(p => !on.has(String(p.roll)));
        return h("div", { class: "dq-names" }, h("b", {}, `${label} (${list.length}): `), rest.length ? h("span", {}, `everyone except ${rest.length}: `, rest.flatMap((p, i) => [h("span", { class: "dq-p" }, `${p.roll} ${p.name}${i < rest.length - 1 ? "," : ""}`), " "])) : h("span", {}, "every student"));
      }
      return h("div", { class: "dq-names" }, h("b", {}, `${label} (${list.length}): `),
      h("span", {}, list.flatMap((p, i) => [h("span", { class: "dq-p" }, `${p.roll} ${p.name}${withAns ? ` (${ans(q, p.answer)})` : ""}${i < list.length - 1 ? "," : ""}`), " "])));
    };
    function block(q, focus) {
      const missed = q.skipped.length + q.wrong.length;
      return h("article", { class: "dq" },
        h("div", { class: "dq-h" }, h("span", { class: "dq-no" }, `Q${q.qno}`),
          h("span", { class: "dq-stat" + (focus === "skip" ? " hot" : "") }, `Skipped ${q.skipped.length} (${pc(q.skipped.length, q.n)}%)`),
          h("span", { class: "dq-stat" + (focus === "wrong" ? " hot" : "") }, `Wrong ${q.wrong.length} (${pc(q.wrong.length, q.n)}%)`),
          h("span", { class: "dq-stat" }, `Right ${q.right} (${pc(q.right, q.n)}%)`),
          h("span", { class: "dq-stat" }, `All campuses: ${q.all_right_pct}% right`),
          h("span", { class: "dq-key" }, `Answer: ${ans(q, q.key)}`)),
        q.question && (q.question.chapter || q.question.level) ? h("div", { class: "dq-tags" }, [q.question.chapter, q.question.topic].filter(Boolean).join(" · "), q.question.level ? h("span", { class: "dq-lv" }, q.question.level) : null) : null,
        q.common_wrong && q.wrong.length > 1 ? h("div", { class: "dq-common" }, `Most common wrong answer: ${ans(q, q.common_wrong.answer)} (${q.common_wrong.count} student${q.common_wrong.count === 1 ? "" : "s"})`) : null,
        opt.showQ && q.question ? h("div", { class: "dq-body" }, q.question.fmt === "html" ? richNode(q.question.text) : h("div", { style: "white-space:pre-wrap" }, q.question.text), q.question.image ? h("img", { src: q.question.image, alt: "" }) : null) : null,
        opt.names ? h("div", { class: "dq-people" }, focus === "wrong" ? [people("Wrong", q.wrong, true, q), people("Skipped", q.skipped, false, q)] : [people("Skipped", q.skipped, false, q), people("Wrong", q.wrong, true, q)], people("Partly right", q.partial, true, q)) : null,
        focus === "easy" && !missed ? null : null);
    }
    function subjectDoc(subj, first) {
      const qs = data.questions.filter(q => q.subject === subj), top = opt.top === "all" ? 999 : Number(opt.top);
      const skipped = qs.filter(q => q.skipped.length).sort((a, b) => b.skipped.length - a.skipped.length || b.wrong.length - a.wrong.length || a.qno - b.qno).slice(0, top);
      const wrong = qs.filter(q => q.wrong.length).sort((a, b) => b.wrong.length - a.wrong.length || b.skipped.length - a.skipped.length || a.qno - b.qno).slice(0, top);
      const easy = qs.filter(q => ((q.question && q.question.level === "Easy") || q.all_right_pct >= 60) && q.skipped.length + q.wrong.length)
        .sort((a, b) => b.skipped.length + b.wrong.length - (a.skipped.length + a.wrong.length) || a.qno - b.qno).slice(0, top);
      const avgRight = qs.length ? Math.round(qs.reduce((x, q) => x + pc(q.right, q.n), 0) / qs.length) : 0;
      const part = (title, hint, list, focus) => h("section", { class: "dq-part" }, h("h3", {}, title, h("span", {}, ` · ${hint}`)),
        list.length ? list.map(q => block(q, focus)) : h("p", { class: "muted" }, "None."));
      return h("section", { class: "pp-page dq-page" + (first ? "" : " pp-break") },
        h("header", { class: "pp-head" }, brand.logo ? h("img", { class: "pp-logo", src: brand.logo, alt: "" }) : null,
          h("div", { class: "pp-inst-name" }, h("div", { class: "pp-org" }, brand.institute || "Paper discussion"), brand.tagline ? h("div", { class: "pp-tag" }, brand.tagline) : null),
          h("div", { class: "pp-test" }, h("b", {}, data.test.name), h("div", {}, `${data.test.code}${data.test.test_date ? " · " + fmtDate(data.test.test_date) : ""}`), h("div", { class: "pp-doc" }, `Paper discussion · ${nice(subj)}`))),
        h("div", { class: "dq-sum" }, h("span", {}, h("b", {}, data.campus || "All campuses"), data.batch ? ` · ${data.batch}` : ""),
          h("span", {}, `Students: ${data.appeared}`), h("span", {}, `${qs.length} questions`), h("span", {}, `Average right per question: ${avgRight}%`)),
        part("1. Most skipped", "discuss first: many students did not even try these", skipped, "skip"),
        part("2. Most wrong", "students tried but got these wrong", wrong, "wrong"),
        part("3. Easy questions missed", "marked Easy, or 60% or more of all students got them right", easy, "easy"));
    }
    function draw() {
      if (!data) return;
      if (!data.appeared) { show(out, h("p", { class: "empty" }, "No results for this choice yet. Upload scans first.")); return; }
      const subs = opt.subject ? data.subjects.filter(x => x === opt.subject) : data.subjects;
      show(out, ...subs.map((x, i) => subjectDoc(x, i === 0)));
    }
    const cSel = h("select", { id: "dq-campus", "aria-label": "Campus", disabled: me.role === "campus" },
      me.role === "campus" ? null : h("option", { value: "" }, "All campuses"), campuses.map(c => h("option", { value: c.id, selected: String(c.id) === String(opt.campus) }, c.name)));
    const bSel = h("select", { id: "dq-batch", "aria-label": "Batch" });
    const fillB = () => { const list = testBatches.filter(b => !cSel.value || String(b.campus_id) === cSel.value);
      bSel.replaceChildren(h("option", { value: "" }, "All batches"), ...list.map(b => h("option", { value: b.id, selected: String(b.id) === String(opt.batch) }, b.name + (cSel.value ? "" : ` · ${campusName(b.campus_id)}`))));
      if (!list.some(b => String(b.id) === String(opt.batch))) { opt.batch = ""; bSel.value = ""; } };
    fillB();
    cSel.onchange = () => { opt.campus = cSel.value; opt.batch = ""; fillB(); keep(); load(); };
    bSel.onchange = () => { opt.batch = bSel.value; keep(); load(); };
    const subj = h("select", { id: "dq-subject", "aria-label": "Subject", onchange: e => { opt.subject = e.target.value; keep(); draw(); } },
      h("option", { value: "" }, "All subjects"), [...new Set(O.getLayout(t.sheet).sections.map(x => x.subject))].map(x => h("option", { value: x, selected: opt.subject === x }, nice(x))));
    const topSel = h("select", { id: "dq-top", "aria-label": "How many per list", onchange: e => { opt.top = e.target.value; keep(); draw(); } },
      [["5", "Top 5 per list"], ["10", "Top 10 per list"], ["15", "Top 15 per list"], ["all", "Every question"]].map(([v, l]) => h("option", { value: v, selected: opt.top === v }, l)));
    const chk = (k, label) => h("label", { class: "pp-opt" }, h("input", { type: "checkbox", checked: !!opt[k], onchange: e => { opt[k] = e.target.checked; keep(); draw(); } }), label);
    document.body.classList.add("print-mode");
    const leave = () => { document.body.classList.remove("print-mode"); window.removeEventListener("hashchange", leave); };
    window.addEventListener("hashchange", leave);
    show(view, h("div", { class: "pp-toolbar no-print" }, h("a", { href: `#/tests/${id}` }, "‹ Back to test"),
        h("h1", { style: "margin:0;font-size:22px" }, "Paper discussion report"),
        h("div", { class: "pp-tools" }, h("label", { class: "pp-opt" }, "Campus", cSel), h("label", { class: "pp-opt" }, "Batch", bSel), h("label", { class: "pp-opt" }, "Subject", subj),
          h("label", { class: "pp-opt" }, "Show", topSel), chk("showQ", "Show questions"), chk("names", "Show student names"),
          h("button", { class: "btn gold", type: "button", onclick: () => window.print() }, "Print / Save as PDF")),
        h("p", { class: "small muted", style: "margin:0" }, "Each subject prints on its own pages. Use it for paper discussion right after the exam.", " ", note)),
      h("style", {}, `@page { size: A4; margin: 11mm 10mm 13mm; @bottom-center { content: "${t.code.replace(/"/g, "")} · Paper discussion · Page " counter(page) " of " counter(pages); font: 8pt Arial, sans-serif; color: #444; } }`),
      out);
    await load();
  }, ["central", "zone", "campus"]);

  route(/^\/print\/(\d+)$/, async (view, id) => {
    const P = await GET(`/api/tests/${id}/paper`);
    const S = P.settings, T = P.test;
    const pref = (() => { try { return JSON.parse(localStorage.getItem("tp-print") || "{}"); } catch (e) { return {}; } })();
    const opt = Object.assign({ cols: "2", size: "10.5", paper: true, key: false, sol: false, tags: false }, pref);
    const keep = () => { try { localStorage.setItem("tp-print", JSON.stringify(opt)); } catch (e) { /* off */ } };
    const byNo = Object.fromEntries(P.questions.map(q => [q.qno, q]));
    const total = P.sections.reduce((n, s) => n + s.count, 0), maxMarks = P.sections.reduce((n, s) => n + s.count * s.marks.correct, 0);
    const missing = total - P.questions.length;
    const hours = T.duration % 60 ? `${T.duration} minutes` : `${T.duration / 60} hour${T.duration === 60 ? "" : "s"}`;
    const nice = s => s.charAt(0) + s.slice(1).toLowerCase();
    const ans = (s, a) => (a == null || a === "" ? "—" : s.options === "1234" && /^[A-D]+$/.test(a) ? [...a].map(c => "ABCD".indexOf(c) + 1).join(", ") : s.qtype === "multi" ? [...a].join(", ") : a);
    const markLine = s => `${s.qtype === "single" ? "Single correct" : s.qtype === "multi" ? "One or more correct" : s.qtype === "integer" ? "Integer answer" : "Numerical answer"} · +${s.marks.correct} correct${s.marks.wrong ? `, −${Math.abs(s.marks.wrong)} wrong` : ", no negative marks"}`;
    // put the four options of a question side by side when they are short
    function tidyOptions(box) {
      const ps = [...box.children];
      for (let i = 0; i + 3 < ps.length; i++) {
        const four = ps.slice(i, i + 4);
        if (!four.every((p, k) => p.tagName === "P" && p.textContent.trim().startsWith(`(${"ABCD"[k]})`))) continue;
        const short = four.every(p => p.textContent.trim().length <= 34 && !p.querySelector("img,.katex-display"));
        const tiny = four.every(p => p.textContent.trim().length <= 16 && !p.querySelector("img,.katex-display"));
        const grid = h("div", { class: "pp-opts " + (tiny ? "c4" : short ? "c2" : "c1") });
        four[0].before(grid); grid.append(...four);
        break;
      }
    }
    function head(title) {
      return h("header", { class: "pp-head" },
        S.logo ? h("img", { class: "pp-logo", src: S.logo, alt: "" }) : null,
        h("div", { class: "pp-inst-name" }, h("div", { class: "pp-org" }, S.institute || "Your institute name"), S.tagline ? h("div", { class: "pp-tag" }, S.tagline) : null),
        h("div", { class: "pp-test" }, h("b", {}, T.name), h("div", {}, `${T.code}${T.test_date ? " · " + fmtDate(T.test_date) : ""}`), title ? h("div", { class: "pp-doc" }, title) : null));
    }
    function paperDoc() {
      const idx = []; let q = 1; P.sections.forEach(s => { idx.push([s, q, q + s.count - 1]); q += s.count; });
      const extra = (S.instructions || "").split(/\r?\n/).map(x => x.trim()).filter(Boolean);
      const doc = h("section", { class: "pp-page" }, head(""),
        h("div", { class: "pp-meta" }, h("span", {}, h("b", {}, "Time: "), hours), h("span", {}, h("b", {}, "Maximum marks: "), maxMarks), h("span", {}, h("b", {}, "Questions: "), total)),
        h("div", { class: "pp-cand" }, h("span", {}, "Name: ", h("i", {})), h("span", {}, "Roll No.: ", h("i", { class: "short" }))),
        h("div", { class: "pp-instr" }, h("b", {}, "Instructions"), h("ol", {},
          ...idx.map(([s, a, b]) => h("li", {}, `Q${a}–Q${b} (${s.name}): ${markLine(s)}.`)),
          ...extra.map(x => h("li", {}, x)))));
      const cols = h("div", { class: "pp-cols" });
      idx.forEach(([s, a, b]) => {
        cols.append(h("h3", { class: "pp-sec" }, `${s.name}`, h("span", {}, ` · Q${a}–Q${b} · ${markLine(s)}`)));
        for (let n = a; n <= b; n++) {
          const qq = byNo[n];
          if (!qq) { cols.append(h("div", { class: "pp-q missing" }, h("b", { class: "pp-no" }, `${n}.`), " Question not picked yet.")); continue; }
          const body = qq.fmt === "html" ? richNode(qq.text) : h("div", { style: "white-space:pre-wrap" }, qq.text || "");
          if (qq.fmt === "html") tidyOptions(body);
          cols.append(h("div", { class: "pp-q" }, h("b", { class: "pp-no" }, `${n}.`), h("div", { class: "pp-body" },
            opt.tags && qq.source ? h("span", { class: "pp-src" }, `[${qq.source}]`) : null, body,
            qq.image ? h("img", { src: qq.image, alt: "", class: "pp-img" }) : null,
            (qq.qtype === "single" || qq.qtype === "multi") && qq.options.some(Boolean) ? h("div", { class: "pp-opts c2" }, qq.options.map((o, k) => h("p", {}, `(${s.options === "1234" ? k + 1 : "ABCD"[k]}) ${o}`))) : null)));
        }
      });
      doc.append(cols, h("p", { class: "pp-end" }, "— End of question paper —"));
      return doc;
    }
    function keyDoc() {
      const cells = []; let q = 1;
      P.sections.forEach(s => { for (let i = 0; i < s.count; i++, q++) cells.push(h("div", { class: "pp-kc" }, h("b", {}, q), h("span", {}, ans(s, T.answer_key[q])))); });
      return h("section", { class: "pp-page pp-break" }, head("Answer key"), h("div", { class: "pp-key" }, cells));
    }
    function solDoc() {
      const cols = h("div", { class: "pp-cols" }); let q = 1;
      P.sections.forEach(s => {
        cols.append(h("h3", { class: "pp-sec" }, s.name));
        for (let i = 0; i < s.count; i++, q++) {
          const qq = byNo[q];
          cols.append(h("div", { class: "pp-q" }, h("b", { class: "pp-no" }, `${q}.`), h("div", { class: "pp-body" }, h("div", { class: "pp-ans" }, `Answer: ${ans(s, T.answer_key[q])}`),
            qq && qq.solution ? (qq.fmt === "html" ? richNode(qq.solution) : h("div", { style: "white-space:pre-wrap" }, qq.solution)) : h("p", { class: "muted" }, "No solution in the bank."))));
        }
      });
      return h("section", { class: "pp-page pp-break" }, head("Solutions"), cols);
    }
    const out = h("div", { class: "pp-out" });
    const pageStyle = h("style", {});
    function draw() {
      out.className = `pp-out cols${opt.cols}`; out.style.fontSize = opt.size + "pt";
      const docs = [opt.paper ? paperDoc() : null, opt.key ? keyDoc() : null, opt.sol ? solDoc() : null].filter(Boolean);
      if (docs[0]) docs[0].classList.remove("pp-break");
      show(out, docs.length ? docs : h("p", { class: "empty" }, "Tick what to print above."));
      pageStyle.textContent = `@page { size: A4; margin: 11mm 10mm 13mm; @bottom-center { content: "${T.code.replace(/"/g, "")}  ·  Page " counter(page) " of " counter(pages); font: 8pt Arial, sans-serif; color: #444; } }`;
    }
    const sel = (id, label, vals, k) => h("label", { class: "pp-opt" }, label, h("select", { id, onchange: e => { opt[k] = e.target.value; keep(); draw(); } }, vals.map(([v, t]) => h("option", { value: v, selected: opt[k] === v }, t))));
    const chk = (id, label, k) => h("label", { class: "pp-opt" }, h("input", { id, type: "checkbox", checked: !!opt[k], onchange: e => { opt[k] = e.target.checked; keep(); draw(); } }), label);
    const bar = h("div", { class: "pp-toolbar no-print" },
      h("a", { href: `#/tests/${id}` }, "‹ Back to test"),
      h("div", { class: "pp-tools" },
        chk("pp-paper", "Question paper", "paper"), chk("pp-key", "Answer key", "key"), chk("pp-sol", "Solutions", "sol"),
        sel("pp-cols", "Layout", [["2", "2 columns (saves paper)"], ["1", "1 column"]], "cols"),
        sel("pp-size", "Text size", [["10", "Small"], ["10.5", "Medium"], ["11.5", "Large"]], "size"),
        chk("pp-tags", "Show exam & year with questions", "tags"),
        h("button", { class: "btn gold", type: "button", onclick: () => window.print() }, "Print / Save as PDF")),
      h("p", { class: "small muted", style: "margin:0" }, missing ? h("span", { class: "err" }, `${missing} question${missing === 1 ? " is" : "s are"} not picked yet. `) : null,
        "In the print window choose A4, print on both sides, and turn off “Headers and footers”. ",
        state.me.role === "central" ? h("a", { href: "#/settings/paper" }, S.institute || S.logo ? "Change logo and heading" : "Add your logo and institute name") : null));
    document.body.classList.add("print-mode");
    const leave = () => { document.body.classList.remove("print-mode"); window.removeEventListener("hashchange", leave); };
    window.addEventListener("hashchange", leave);
    show(view, pageStyle, bar, out);
    draw();
  }, ["central", "zone", "campus"]);


  // ---- toppers: institute / zone / campus rank lists, best zone & campus, presence in top N
  async function toppersTab(body, t, embedded) {
    const R = await GET(`/api/tests/${t.id}/toppers`);
    if (!R.students.length) { if (embedded) return; body.append(h("div", { class: "card" }, h("p", { class: "empty" }, "No marks yet. Toppers appear once sheets are read or online tests are submitted."))); return; }
    const role = state.me.role;
    const subj = R.subjects.length > 1 ? R.subjects : [];
    const nice = s => s.charAt(0) + s.slice(1).toLowerCase();
    let topN = 20, within = role === "central" ? "institute" : role === "zone" ? "zone" : "campus";
    const minN = 5; // groups smaller than this are not called "best"
    const bestBy = list => list.filter(x => x.n >= minN).sort((a, b) => b.avg_pct - a.avg_pct)[0] || list.slice().sort((a, b) => b.avg_pct - a.avg_pct)[0];
    const mostIn = (list, c) => list.slice().sort((a, b) => (b.top[c] || 0) - (a.top[c] || 0) || b.avg_pct - a.avg_pct)[0];
    const bz = R.zones.length ? bestBy(R.zones) : null, bc = R.campuses.length ? bestBy(R.campuses) : null, mc = R.campuses.length ? mostIn(R.campuses, 100) : null;
    const tiles = h("div", { class: "stats" },
      h("div", { class: "stat gold" }, h("b", {}, R.students[0].name || R.students[0].roll), h("span", {}, `Rank 1 · ${R.students[0].total}/${R.max} · ${R.students[0].campus}`)),
      h("div", { class: "stat" }, h("b", {}, R.appeared), h("span", {}, "Students ranked in this test")),
      bz ? h("div", { class: "stat ok" }, h("b", { style: "font-size:20px" }, bz.name), h("span", {}, `Top zone · average ${bz.avg_pct}%`)) : null,
      bc ? h("div", { class: "stat ok" }, h("b", { style: "font-size:20px" }, bc.name), h("span", {}, `Top campus · average ${bc.avg_pct}%`)) : null,
      mc && (mc.top[100] || 0) ? h("div", { class: "stat" }, h("b", { style: "font-size:20px" }, mc.name), h("span", {}, `Most students in top 100 (${mc.top[100]})`)) : null);
    // presence tables
    const presence = (title, list, isCampus) => {
      let sortKey = 100;
      const tb = h("tbody");
      const draw = () => {
        const rows = list.slice().sort((a, b) => sortKey === "avg" ? b.avg_pct - a.avg_pct : (b.top[sortKey] || 0) - (a.top[sortKey] || 0) || b.avg_pct - a.avg_pct);
        show(tb, rows.map((x, i) => h("tr", {}, h("td", { class: "num" }, i + 1), h("td", {}, h("b", {}, x.name), isCampus && x.zone ? h("div", { class: "small muted" }, x.zone) : null),
          h("td", { class: "num" }, x.n), ...R.cuts.map(c => h("td", { class: "num" }, x.top[c] ? h("b", {}, x.top[c]) : h("span", { class: "muted" }, "0"))),
          h("td", { class: "num" }, `${x.avg_pct}%`), ...(R.subjects.length > 1 ? R.subjects.map(k => h("td", { class: "num" }, (x.subjects || {})[k] ?? "—")) : []), h("td", { class: "small" }, x.best ? `#${x.best.rank} ${x.best.name || x.best.roll}` : ""))));
        head.querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.k === String(sortKey)));
      };
      const sortBtn = (label, k) => h("button", { class: "link", type: "button", "data-k": k, onclick: () => { sortKey = k; draw(); } }, label);
      const head = h("tr", {}, h("th", { class: "num" }, "#"), h("th", {}, isCampus ? "Campus" : "Zone"), h("th", { class: "num" }, "Students"),
        ...R.cuts.map(c => h("th", { class: "num" }, sortBtn(`Top ${c}`, c))), h("th", { class: "num" }, sortBtn("Average", "avg")),
        ...(R.subjects.length > 1 ? R.subjects.map(k => h("th", { class: "num" }, `${k[0] + k.slice(1).toLowerCase()} avg`)) : []), h("th", {}, "Best rank"));
      draw();
      return h("div", { class: "card" }, h("div", { class: "head" }, h("h2", {}, title), h("span", { class: "small muted" }, "How many of each one's students are in the institute's top 20 / 50 / 100 / 500. Click a heading to sort.")),
        h("div", { class: "tablebox" }, h("table", { class: "top-table" }, h("thead", {}, head), tb)));
    };
    // rank lists
    const listBox = h("div", { class: "card" });
    const rowsFor = (list, rankKey) => list.map(s => h("tr", { class: s.rank <= 3 && rankKey === "rank" ? "podium" : "" }, h("td", { class: "num" }, h("b", {}, s[rankKey])),
      rankKey !== "rank" ? h("td", { class: "num muted" }, s.rank) : null, h("td", { class: "mono" }, s.roll), h("td", {}, s.name),
      h("td", {}, s.campus, h("div", { class: "small muted" }, [s.batch, role === "central" ? s.zone : ""].filter(Boolean).join(" · "))),
      ...subj.map(k => h("td", { class: "num" }, (s.subjects || {})[k] ?? "")), h("td", { class: "num" }, h("b", {}, s.total)), h("td", { class: "num" }, `${s.pct}%`)));
    const thead = rankKey => h("thead", {}, h("tr", {}, h("th", { class: "num" }, rankKey === "rank" ? "Rank" : within === "zone" ? "Zone rank" : "Campus rank"),
      rankKey !== "rank" ? h("th", { class: "num" }, "Institute rank") : null, h("th", {}, "Roll"), h("th", {}, "Name"), h("th", {}, "Campus"),
      ...subj.map(k => h("th", { class: "num" }, nice(k))), h("th", { class: "num" }, `Marks /${R.max}`), h("th", { class: "num" }, "%")));
    const groupsOf = key => { const m = new Map(); for (const s of R.students) { const k = s[key]; if (!m.has(k)) m.set(k, []); m.get(k).push(s); } return [...m.values()]; };
    const withLocalRank = list => { let prev = null, r = 0; return list.map((s, i) => { if (!prev || s.total !== prev.total) r = i + 1; prev = s; return { ...s, local: r }; }); };
    let current = [];
    function drawList() {
      const nSel = h("select", { id: "top-n", "aria-label": "How many" }, [20, 50, 100, 500, 0].map(n => h("option", { value: n, selected: n === topN }, n ? `Top ${n}` : "Everyone")));
      nSel.onchange = () => { topN = +nSel.value; drawList(); };
      const wSel = h("select", { id: "top-within", "aria-label": "List" }, [...(role === "central" ? [["institute", "Whole institute"], ["zone", "Each zone"]] : role === "zone" ? [["institute", "Institute ranks (my zone)"], ["zone", "My zone"]] : [["institute", "Institute ranks (my campus)"]]),
        ...(role !== "campus" ? [["campus", "Each campus"]] : [["campus", "My campus"]])].map(([v, l]) => h("option", { value: v, selected: v === within }, l)));
      wSel.onchange = () => { within = wSel.value; drawList(); };
      const blocks = [];
      current = [];
      if (within === "institute") {
        const list = R.students.filter(s => !topN || s.rank <= topN);
        current = list.map(s => ({ ...s, list: "Institute" }));
        blocks.push(h("div", { class: "tablebox" }, h("table", { class: "top-table" }, thead("rank"), h("tbody", {}, rowsFor(list, "rank")))));
        if (!list.length) blocks.push(h("p", { class: "empty" }, "None of your students are in this list."));
      } else {
        const key = within === "zone" ? "zone_id" : "campus_id";
        for (const g of groupsOf(key).sort((a, b) => (within === "zone" ? a[0].zone : a[0].campus).localeCompare(within === "zone" ? b[0].zone : b[0].campus))) {
          const ranked = withLocalRank(g).filter(s => !topN || s.local <= topN);
          const label = within === "zone" ? g[0].zone : g[0].campus;
          current.push(...ranked.map(s => ({ ...s, list: label })));
          blocks.push(h("h3", { class: "top-h" }, !topN || g.length <= topN ? `${label} · all ${g.length} students` : `${label} · top ${topN} of ${g.length}`),
            h("div", { class: "tablebox" }, h("table", { class: "top-table" }, thead("local"), h("tbody", {}, rowsFor(ranked, "local")))));
        }
      }
      show(listBox, h("div", { class: "head" }, h("h2", {}, "Rank list"), h("div", { class: "row", style: "align-items:center" }, nSel, wSel,
        h("button", { class: "btn ghost small shrink", type: "button", onclick: download }, "Download Excel"))),
        h("p", { class: "small muted", style: "margin:0" }, "Students with equal marks share a rank. Ranks are among everyone who wrote this test."), blocks);
    }
    async function download() {
      await need("xlsx");
      const rows = current.map(s => ({ List: s.list, Rank: s.local ?? s.rank, "Institute rank": s.rank, Roll: s.roll, Name: s.name, Zone: s.zone, Campus: s.campus, Batch: s.batch,
        ...Object.fromEntries(subj.map(k => [nice(k), (s.subjects || {})[k] ?? ""])), Marks: s.total, "Out of": R.max, Percent: s.pct, Correct: s.correct, Wrong: s.wrong }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Rank list");
      const pres = list => list.map(x => ({ Name: x.name, ...(x.zone ? { Zone: x.zone } : {}), Students: x.n, ...Object.fromEntries(R.cuts.map(c => [`Top ${c}`, x.top[c] || 0])), "Average %": x.avg_pct, ...Object.fromEntries((R.subjects.length > 1 ? R.subjects : []).map(k => [`${k} avg`, (x.subjects || {})[k] ?? ""])), "Best rank": x.best ? x.best.rank : "" }));
      if (R.campuses.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(pres(R.campuses)), "Campuses");
      if (R.zones.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(pres(R.zones)), "Zones");
      XLSX.writeFile(wb, `${R.test.code}-toppers.xlsx`);
    }
    drawList();
    body.append(...[tiles, R.zones.length > 1 ? presence("Zones in the top lists", R.zones, false) : null, R.campuses.length > 1 ? presence("Campuses in the top lists", R.campuses, true) : null, listBox].filter(Boolean));
  }

  // ---- questions: pick from the bank, section by section
  const SEC_QTYPE = { single: "single", multi: "multi", integer: "integer", decimal: "decimal|integer" };
  const titleCase = s => s.charAt(0) + s.slice(1).toLowerCase();
  function wideModal(build) {
    const close = modal(build);
    const card = $("#modal .modal-card"), m = $("#modal");
    card.classList.add("wide");
    const obs = new MutationObserver(() => { if (m.hidden) { card.classList.remove("wide"); obs.disconnect(); } });
    obs.observe(m, { attributes: true, attributeFilter: ["hidden"] });
    return close;
  }
  async function questionsTab(body, t, layout) {
    const idx = O.questionIndex(layout);
    let links = {}, info = {};
    const setLinked = linked => { links = {}; info = {}; linked.forEach(l => { links[l.qno] = l.id; info[l.id] = l; }); };
    setLinked(t.linked);
    const secs = layout.sections.map((sec, si) => ({ sec, si, qnos: idx.filter(x => x.si === si).map(x => x.qno) }));
    const summary = h("div", { class: "card" }), wrap = h("div", { style: "display:grid;gap:16px" });
    async function save(next) {
      await PUT(`/api/tests/${t.id}/questions`, { links: next });
      const fresh = await GET(`/api/tests/${t.id}`); t.linked = fresh.linked; t.answer_key = fresh.answer_key; setLinked(fresh.linked);
      draw();
    }
    const used = () => Object.values(links);
    function draw() {
      const n = Object.keys(links).length;
      show(summary, h("div", { class: "head" }, h("div", {}, h("h2", {}, "Questions for this test"),
        h("p", { class: "small muted", style: "margin:0" }, "Pick questions for each section from the question bank. Their answers go into the answer key automatically, and students see each question with its solution in their results.")),
        h("div", { class: "row" }, h("span", { class: "pill " + (n === idx.length ? "ok" : "warn") }, `${n} of ${idx.length} picked`),
          h("a", { class: "btn ghost small", href: `#/tests/${t.id}/import` }, "Import paper from PDF"), n ? h("a", { class: "btn gold small", href: `#/print/${t.id}` }, "Print paper") : null)),
        t.mode && t.mode !== "omr" && n < idx.length ? h("p", { class: "err small", style: "margin:0" }, "This is an online test: students can start it only after every question number has a question.") : null);
      show(wrap, secs.map(s => sectionCard(s)));
    }
    function sectionCard(s) {
      const picked = s.qnos.filter(q => links[q]).length;
      const rows = [];
      let gap = [];
      const flush = () => { if (gap.length) { rows.push(h("div", { class: "slot empty" }, gap.length === 1 ? `Q${gap[0]} not picked yet` : `Q${gap[0]}–Q${gap[gap.length - 1]} not picked yet`)); gap = []; } };
      for (const qno of s.qnos) {
        const id = links[qno];
        if (!id) { gap.push(qno); continue; }
        flush();
        const q = info[id] || {};
        rows.push(h("div", { class: "slot" }, h("b", { class: "mono" }, `Q${qno}`),
          h("div", { class: "slot-main" }, h("div", { class: "slot-text" }, q.fmt === "html" ? plainText(q.text, 150) : (q.text || "").slice(0, 150)), h("div", { class: "small muted" }, [q.chapter, `Answer ${q.answer}`, `ID ${id}`].filter(Boolean).join(" · "))),
          h("button", { class: "btn ghost small shrink", type: "button", onclick: () => viewQuestion(id, s.qnos.map(x => links[x]).filter(Boolean)) }, "View"),
          h("button", { class: "btn danger small shrink", type: "button", onclick: async () => { const next = { ...links }; delete next[qno]; try { await save(next); toast(`Removed from Q${qno}`); } catch (x) { toast(x.message); } } }, "Remove")));
      }
      flush();
      const full = picked === s.qnos.length;
      return h("div", { class: "card" },
        h("div", { class: "head" }, h("div", {}, h("h2", {}, s.sec.name), h("p", { class: "small muted", style: "margin:0" }, `Q${s.qnos[0]}–Q${s.qnos[s.qnos.length - 1]} · ${picked} of ${s.qnos.length} picked`)),
          h("div", { class: "row" }, picked ? h("button", { class: "btn ghost small", type: "button", onclick: () => confirmBox(`Remove all ${picked} questions from ${s.sec.name}?`, "Remove all", async () => {
            const next = { ...links }; s.qnos.forEach(q => delete next[q]); try { await save(next); } catch (x) { toast(x.message); } }) }, "Clear section") : null,
            h("button", { class: "btn gold small", type: "button", disabled: full, onclick: () => picker(s) }, full ? "Section full" : "Pick from bank"))),
        h("div", { class: "slots" }, rows));
    }
    // the bank, filtered to this section's subject and question type, with Add buttons
    function picker(s) {
      const subject = s.sec.subject.toLowerCase(), qtype = SEC_QTYPE[s.sec.qtype];
      const chap = h("select", { "aria-label": "Chapter", id: "pk-chapter" }), yr = h("select", { "aria-label": "Year", id: "pk-year" });
      const dif = h("select", { "aria-label": "Level", id: "pk-level" }, h("option", { value: "" }, "Any level"), QLEVELS.map(d => h("option", {}, d)));
      const pyq = h("select", { "aria-label": "Past-year questions", id: "pk-pyq" }, h("option", { value: "" }, "All questions"), h("option", { value: "1" }, "Past-year only"), h("option", { value: "0" }, "Practice only"));
      const q = h("input", { placeholder: "Search words or exam (e.g. 2023)", "aria-label": "Search", id: "pk-q" });
      const list = h("div", { class: "qlist" }), pager = h("div", { class: "pager" }), status = h("span", { class: "pill warn shrink" }), count = h("span", { class: "small muted" });
      let page = 0, matching = 0;
      const free = () => s.qnos.filter(qn => !links[qn]);
      const params = () => { const p = new URLSearchParams(Object.entries({ subject, qtype, chapter: chap.value, difficulty: dif.value, year: yr.value, pyq: pyq.value, q: q.value.trim() }).filter(([, v]) => v)); return p; };
      const syncStatus = () => { const f = free().length; status.textContent = f ? `${s.qnos.length - f} of ${s.qnos.length} picked · ${f} to go` : `All ${s.qnos.length} picked`; status.className = "pill shrink " + (f ? "warn" : "ok"); fillBtn.disabled = !f; fillBtn.textContent = f ? `Fill the remaining ${f} at random` : "Section full"; };
      async function add(x, btn) {
        const slot = free()[0]; if (!slot) { toast("This section is full."); return; }
        btn.disabled = true; btn.textContent = "Adding…";
        try { await save({ ...links, [slot]: x.id }); btn.textContent = `Added as Q${slot}`; btn.className = "btn ghost small"; syncStatus(); }
        catch (e) { toast(e.message); btn.disabled = false; btn.textContent = "Add"; }
      }
      const actions = x => {
        const at = Object.entries(links).find(([, id]) => id === x.id);
        if (at) return h("span", { class: "pill ok" }, `In this test as Q${at[0]}`);
        const b = h("button", { class: "btn gold small", type: "button" }, "Add");
        b.onclick = () => add(x, b);
        return b;
      };
      async function load(keep) {
        if (!keep) page = 0;
        const p = params(); p.set("full", "1"); p.set("limit", 10); p.set("offset", page * 10);
        const r = await GET("/api/questions?" + p);
        const fill = (sel, first, vals) => { const v = sel.value; sel.replaceChildren(h("option", { value: "" }, first), ...vals.map(x => h("option", { value: x, selected: String(x) === v }, x))); };
        fill(chap, "All chapters", [...new Set(r.facets.chapters.filter(c => c.subject.toLowerCase() === subject).map(c => c.chapter))]);
        fill(yr, "Any year", r.facets.years);
        matching = r.matching;
        count.textContent = matching ? `${matching} matching · showing ${page * 10 + 1}–${page * 10 + r.rows.length}` : "";
        show(list, r.rows.length ? r.rows.map((x, i) => questionCard(x, page * 10 + i + 1, [], actions))
          : h("p", { class: "empty" }, r.total ? `No ${titleCase(s.sec.subject)} ${QT[s.sec.qtype].toLowerCase()} questions match these filters.` : "The question bank is empty."));
        const pages = Math.max(1, Math.ceil(matching / 10));
        show(pager, h("button", { class: "btn ghost small", type: "button", disabled: page === 0, onclick: () => { page--; load(true); } }, "‹ Previous"),
          h("span", { class: "small" }, `Page ${page + 1} of ${pages}`),
          h("button", { class: "btn ghost small", type: "button", disabled: page >= pages - 1, onclick: () => { page++; load(true); } }, "Next ›"));
        pager.hidden = pages < 2;
        list.parentElement && (list.closest(".modal-card").scrollTop = 0);
      }
      const fillBtn = h("button", { class: "btn ghost small", type: "button", onclick: async () => {
        const slots = free(); if (!slots.length) return;
        const p = params(); p.set("order", "random"); p.set("limit", slots.length); if (used().length) p.set("exclude", used().join(","));
        fillBtn.disabled = true;
        try {
          const r = await GET("/api/questions?" + p);
          if (!r.rows.length) { toast("No more questions match these filters."); syncStatus(); return; }
          const next = { ...links }; r.rows.forEach((x, i) => (next[slots[i]] = x.id));
          await save(next); toast(`Added ${r.rows.length} question${r.rows.length === 1 ? "" : "s"}`); syncStatus(); load(true);
        } catch (x) { toast(x.message); syncStatus(); }
      } });
      [chap, dif, yr, pyq].forEach(x => (x.onchange = () => load(false)));
      let tm; q.oninput = () => { clearTimeout(tm); tm = setTimeout(() => load(false), 300); };
      wideModal((b, close) => {
        b.append(h("div", { class: "picker" },
          h("div", { class: "qv-head" }, h("b", {}, `Pick for ${s.sec.name}`), h("span", { class: "small" }), h("button", { class: "btn ghost small shrink", type: "button", "aria-label": "Close", onclick: close }, "✕")),
          h("p", { class: "small muted", style: "margin:0" }, `Showing ${titleCase(s.sec.subject)} questions of type “${QT[s.sec.qtype]}”${s.sec.qtype === "decimal" ? " (and integer)" : ""}. Each Add fills the next free question number.`),
          h("div", { class: "row" }, chap, dif, yr, pyq), q, h("div", { class: "row", style: "align-items:center" }, status, count, h("span", { class: "shrink" }, fillBtn)),
          list, pager, h("div", { class: "qv-foot" }, h("span", { style: "flex:1" }), h("button", { class: "btn small", type: "button", onclick: close }, "Done"))));
        syncStatus(); load(false);
      });
    }
    draw();
    body.append(summary, wrap);
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
      show(review, h("div", { class: "head" }, h("div", {}, h("h2", {}, `Roll ${r.roll}`), h("p", { class: "sub small" }, `${s ? s.name : "Unknown student"} · ${r.source}`)),
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
  async function resultsTab(body, t, layout, part = "results") {
    const a = await GET(`/api/tests/${t.id}/analysis`);
    const me = state.me;
    if (!a.students.length) {
      body.append(h("div", { class: "card empty" }, h("h2", {}, part === "analysis" ? "No marks yet" : "No sheets read yet"),
        h("p", {}, part === "analysis" ? "Analysis appears once OMR sheets are read or online tests are submitted." : "Print sheets for the batches, then upload the scans in Upload scans.")));
      return false;
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
    const multi = a.subjects.length > 1, cap = x => x[0] + x.slice(1).toLowerCase();
    const groupTable = (title, rows) => rows.length > 1 || (rows.length && title !== "Batches") ? h("div", { class: "card" }, h("h2", {}, title), h("div", { class: "tablebox" }, h("table", {},
      h("thead", {}, h("tr", {}, ["Name", "Students", "Average", ...(multi ? a.subjects.map(x => `${cap(x)} avg`) : []), "Top"].map(x => h("th", {}, x)))),
      h("tbody", {}, rows.sort((x, y) => y.avg - x.avg).map(r => h("tr", {}, h("td", {}, title === "Batches" ? batchFull(r.id) : r.name), h("td", { class: "num" }, r.n), h("td", { class: "num" }, h("b", {}, r.avg)),
        ...(multi ? a.subjects.map(x => h("td", { class: "num" }, (r.subjects || {})[x] ?? "—")) : []), h("td", { class: "num" }, r.top))))))) : null;
    const subTop = sub => sorted.reduce((b, s) => ((s.subjects[sub] ?? 0) > (b.subjects[sub] ?? 0) ? s : b), sorted[0]);
    const subjectCard = multi && a.subject_avg ? h("div", { class: "card" }, h("h2", {}, "Subject-wise summary"), h("div", { class: "tablebox" }, h("table", {},
      h("thead", {}, h("tr", {}, ["Subject", "Out of", "Average", "Average %", "Highest", "Topper"].map(x => h("th", {}, x)))),
      h("tbody", {}, a.subjects.map(sub => { const tp = subTop(sub), mx = (a.subject_max || {})[sub] || 0;
        return h("tr", {}, h("td", {}, h("b", {}, cap(sub))), h("td", { class: "num" }, mx), h("td", { class: "num" }, a.subject_avg[sub]), h("td", { class: "num" }, mx ? `${Math.round((a.subject_avg[sub] / mx) * 100)}%` : "—"),
          h("td", { class: "num" }, h("b", {}, tp.subjects[sub] ?? 0)), h("td", {}, tp.name || tp.roll)); }))))) : null;
    const hardest = a.questions.slice().sort((x, y) => x.right / x.n - y.right / y.n).slice(0, 10);
    if (a.keyCount < a.total_questions) body.append(h("p", { class: "pill warn", style: "padding:8px 12px;border-radius:6px;white-space:normal" }, `The answer key has ${a.keyCount} of ${a.total_questions} answers. Marks count only keyed questions.`));
    const statsRow = h("div", { class: "stats" }, h("div", { class: "stat" }, h("b", {}, `${a.students.length} / ${a.expected}`), h("span", {}, "Sheets read")),
        h("div", { class: "stat gold" }, h("b", {}, avg.toFixed(1)), h("span", {}, `Average of ${a.max}`)),
        h("div", { class: "stat ok" }, h("b", {}, sorted[0].total), h("span", {}, `Top · ${sorted[0].name || sorted[0].roll}`)),
        h("div", { class: "stat" }, h("b", {}, sorted[Math.floor(sorted.length / 2)].total), h("span", {}, "Median")));
    if (part === "analysis") {
      body.append(statsRow,
      ...(subjectCard ? [subjectCard] : []),
      h("div", { class: multi ? "stack" : "grid3" }, groupTable("Zones", a.by_zone), groupTable("Campuses", a.by_campus), groupTable("Batches", a.by_batch)),
      h("div", { class: "card" }, h("h2", {}, "Questions with the fewest right answers"), h("div", { class: "bars" }, hardest.map(q => {
        const pct = Math.round(q.right / q.n * 100);
        return h("div", { class: "barrow" }, h("span", { class: "mono" }, `Q${q.q}`), h("div", { class: "meter" }, h("i", { style: `width:${Math.max(1, pct)}%` })), h("span", { class: "num" }, `${pct}% right`));
      }))));
      return;
    }
    body.append(statsRow,
      h("div", { class: "card" }, h("div", { class: "head" }, h("h2", {}, "Students"), h("div", { class: "row" }, h("button", { class: "btn small ghost", type: "button", onclick: () => {
        download(`results_${t.code}.csv`, csv([["rank", "roll", "name", "zone", "campus", "batch", "total", ...a.subjects, "correct", "wrong", "blank", "campus rank", "batch rank"],
          ...sorted.map(s => [s.rank_all, s.roll, s.name, zoneName(s.zone_id), campusName(s.campus_id), (batchOf(s.batch_id) || {}).name, s.total, ...a.subjects.map(x => s.subjects[x] ?? 0), s.correct, s.wrong, s.blank, s.rank_campus, s.rank_batch])]));
      } }, "Download CSV"))),
        h("div", { class: "row" }, fb.els),
        h("div", { class: "tablebox" }, h("table", {}, h("thead", {}, h("tr", {}, ["Rank", "Roll", "Name", "Batch", "Total", ...a.subjects.map(s => s[0] + s.slice(1).toLowerCase()), "Right", "Wrong", "Blank", "Campus rank", "Batch rank"].map(x => h("th", {}, x)))), tbody))));
    drawTable();
  }

  // ================================================================ student report (admin view + student view share this)
  function reportView(view, rep, back) {
    const cap = x => (x ? x[0] + x.slice(1).toLowerCase() : "");
    const pct = rep.max ? Math.round((rep.total / rep.max) * 100) : 0;
    const RES = { correct: ["Right", "ok"], bonus: ["Bonus", "ok"], partial: ["Partly right", "warn"], wrong: ["Wrong", "bad"], blank: ["Not answered", ""], dropped: ["Dropped", ""], nokey: ["No key", ""], badkey: ["—", ""] };
    const D = rep.detail;
    const isRight = d => d.result === "correct" || d.result === "bonus";
    const missed = d => d.result === "wrong" || d.result === "blank" || d.result === "partial";
    const fmtT = s => (s == null ? "—" : s < 60 ? `${s}s` : s >= 3600 ? `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`);
    const hasTime = !!rep.attempt && D.some(d => d.time);
    const ch = d => (d.question && d.question.chapter) || "";
    const lv = d => (d.question && d.question.level) || "";
    const when = ms => new Date(ms).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

    // ---- one question in a pop-up, with your answer, the key, how others did, and the solution
    function openQ(list, i) {
      let cur = i, bodyEl, closeFn;
      const keys = e => { if ($("#modal").hidden) { document.removeEventListener("keydown", keys); return; }
        if (e.key === "ArrowRight") step(1); else if (e.key === "ArrowLeft") step(-1); else if (e.key === "Escape") closeFn(); };
      const step = k => { if (cur + k >= 0 && cur + k < list.length) { cur += k; draw(); } };
      function draw() {
        const d = list[cur], q = d.question, [label, tone] = RES[d.result] || [d.result, ""];
        show(bodyEl,
          h("div", { class: "qv-head" }, h("b", {}, `Question ${d.q}`), h("span", { class: "pill " + tone }, label), h("span", { class: "small muted" }, `${cur + 1} of ${list.length}`),
            h("button", { class: "btn ghost small shrink", type: "button", "aria-label": "Close", onclick: () => closeFn() }, "✕")),
          h("div", { class: "chips" }, [cap(d.subject), q && q.chapter, q && q.topic].filter(Boolean).map(t => h("span", { class: "chip" }, t)), q && q.level ? h("span", { class: "pill lv" + (QLEVELS.indexOf(q.level) + 1) }, q.level) : null),
          q ? (q.fmt === "html" ? richNode(q.text) : q.text ? h("div", { style: "white-space:pre-wrap" }, q.text) : null) : h("p", { class: "muted small" }, "The question text is not linked to this test."),
          q && q.image ? h("img", { src: q.image, alt: `Question ${d.q}`, style: "max-width:100%;border-radius:4px" }) : null,
          q && q.options && q.options.some(Boolean) ? h("div", { class: "opts" }, q.options.map((o, k) => o ? h("div", {}, `(${"ABCD"[k]}) ${o}`) : null)) : null,
          h("div", { class: "ra-facts" },
            h("div", {}, h("span", {}, "Your answer"), h("b", { class: "mono" }, d.marked || "—")),
            h("div", {}, h("span", {}, "Correct answer"), h("b", { class: "mono" }, d.key || "—")),
            h("div", {}, h("span", {}, "Marks"), h("b", {}, `${d.marks > 0 ? "+" : ""}${d.marks}`)),
            h("div", {}, h("span", {}, "Got it right"), h("b", {}, `${d.right_pct}% of students`)),
            d.time != null ? h("div", {}, h("span", {}, "Your time"), h("b", {}, fmtT(d.time)), h("span", { class: "small muted" }, `average ${fmtT(d.avg_time)}`)) : null),
          q && q.solution ? h("details", { open: !isRight(d) }, h("summary", {}, "Solution"), q.fmt === "html" ? richNode(q.solution) : h("div", { style: "white-space:pre-wrap" }, q.solution)) : null,
          h("div", { class: "qv-foot" },
            h("button", { class: "btn ghost small", type: "button", disabled: cur <= 0, onclick: () => step(-1) }, "‹ Previous"),
            h("button", { class: "btn ghost small", type: "button", disabled: cur >= list.length - 1, onclick: () => step(1) }, "Next ›")));
        bodyEl.parentElement.scrollTop = 0;
      }
      closeFn = wideModal((b, close) => { bodyEl = b; closeFn = close; draw(); });
      document.addEventListener("keydown", keys);
    }
    const qChip = (d, list) => h("button", { type: "button", class: "qchip " + ((RES[d.result] || [])[1] || ""), onclick: () => openQ(list, list.indexOf(d)) }, `Q${d.q}`);

    // ---- stacked right / partly / wrong / blank bar
    const LEG = [["ok", "Right"], ["warn", "Partly right"], ["bad", "Wrong"], ["blank", "Not answered"]];
    const legend = () => h("div", { class: "ra-legend small" }, LEG.map(([c, l]) => h("span", {}, h("i", { class: "sw " + c }), l)));
    const split = list => ({ ok: list.filter(isRight).length, warn: list.filter(d => d.result === "partial").length, bad: list.filter(d => d.result === "wrong").length, blank: list.filter(d => d.result === "blank").length });
    const stack = list => { const c = split(list), n = list.length || 1;
      return h("div", { class: "stackbar", role: "img", "aria-label": `${c.ok} right, ${c.warn} partly right, ${c.bad} wrong, ${c.blank} not answered` },
        ...LEG.map(([k]) => c[k] ? h("i", { class: k, style: `flex:${c[k] / n}`, title: `${c[k]} ${LEG.find(x => x[0] === k)[1].toLowerCase()}` }) : null).filter(Boolean)); };
    const marksOf = list => list.reduce((a, d) => a + (d.marks || 0), 0), fullOf = list => list.reduce((a, d) => a + (d.full || 0), 0);
    function breakdown(title, note, groups) {
      return h("div", { class: "card" }, h("div", { class: "head" }, h("div", {}, h("h2", {}, title), note ? h("p", { class: "small muted", style: "margin:2px 0 0" }, note) : null), legend()),
        h("div", { class: "tablebox" }, h("table", { class: "ra-break" }, h("thead", {}, h("tr", {}, ["", "Qs", "Right · Wrong · Blank", "Marks", "Score"].map((x, i) => h("th", { class: i === 1 || i > 2 ? "num" : "" }, x)))),
          h("tbody", {}, groups.map((g, gi) => { const m = marksOf(g.list), f = fullOf(g.list), sc = f ? Math.round((m / f) * 100) : 0, c = split(g.list);
            return h("tr", { tabindex: 0, hidden: gi >= 8, onclick: () => openQ(g.list, 0), onkeydown: e => e.key === "Enter" && openQ(g.list, 0) },
              h("td", {}, h("b", {}, g.name), g.sub ? h("div", { class: "small muted" }, g.sub) : null), h("td", { class: "num" }, g.list.length),
              h("td", { style: "min-width:160px" }, stack(g.list), h("div", { class: "small muted" }, `${c.ok + c.warn} · ${c.bad} · ${c.blank}`)),
              h("td", { class: "num" }, `${m} / ${f}`), h("td", { class: "num" }, h("b", { class: sc < 35 ? "t-bad" : sc >= 70 ? "t-ok" : "" }, `${sc}%`))); })))),
        groups.length > 8 ? h("button", { class: "link", type: "button", onclick: e => { e.target.closest(".card").querySelectorAll("tr[hidden]").forEach(r => (r.hidden = false)); e.target.remove(); } }, `Show all ${groups.length}`) : null);
    }

    // ---- where the marks went
    const easyMiss = D.filter(d => missed(d) && d.right_pct >= 60);
    const neg = D.filter(d => d.marks < 0), negSum = -marksOf(neg);
    const tough = D.filter(d => missed(d) && d.right_pct < 30);
    const gain = easyMiss.reduce((a, d) => a + (d.full - d.marks), 0);
    const attempted = D.filter(d => ["correct", "wrong", "partial", "bonus"].includes(d.result));
    const accuracy = attempted.length ? Math.round((attempted.filter(isRight).length / attempted.length) * 100) : 0;
    const insight = h("div", { class: "card" }, h("h2", {}, "Where your marks went"),
      h("div", { class: "stats" },
        h("div", { class: "stat" }, h("b", {}, `${accuracy}%`), h("span", {}, `Accuracy · ${attempted.filter(isRight).length} right of ${attempted.length} attempted`)),
        h("div", { class: "stat warn" }, h("b", {}, `−${negSum}`), h("span", {}, `Lost to negative marking (${neg.length} wrong)`)),
        h("div", { class: "stat gold" }, h("b", {}, `${rep.total + gain}`), h("span", {}, `Your score if you had got the ${easyMiss.length} easier ones right`))),
      easyMiss.length ? h("div", { class: "ra-group" }, h("p", {}, h("b", {}, "Missed but most students got right"), h("span", { class: "small muted" }, " — 60% or more of students got these. Revise these first.")), h("div", { class: "qchips" }, easyMiss.map(d => qChip(d, easyMiss)))) : null,
      tough.length ? h("div", { class: "ra-group" }, h("p", {}, h("b", {}, "Tough questions"), h("span", { class: "small muted" }, " — fewer than 30% of students got these. Don't worry too much about them.")), h("div", { class: "qchips" }, tough.map(d => qChip(d, tough)))) : null);

    // ---- chapter and difficulty breakdowns
    const groupBy = (keyFn, subFn) => { const m = new Map(); for (const d of D) { const k = keyFn(d); if (!k) continue; if (!m.has(k)) m.set(k, { name: k.split("|").pop(), sub: subFn ? subFn(d) : "", list: [] }); m.get(k).list.push(d); } return [...m.values()]; };
    const chapters = groupBy(d => ch(d) && `${d.subject}|${ch(d)}`, d => cap(d.subject))
      .sort((a, b) => marksOf(a.list) / (fullOf(a.list) || 1) - marksOf(b.list) / (fullOf(b.list) || 1));
    const levels = groupBy(lv).sort((a, b) => QLEVELS.indexOf(a.name) - QLEVELS.indexOf(b.name));

    // ---- time analysis (online tests)
    let timeCard = null;
    if (hasTime) {
      const used = Math.max(Math.round((rep.attempt.submitted_at - rep.attempt.started_at) / 1000), D.reduce((a, d) => a + (d.time || 0), 0));
      const tsum = list => list.reduce((a, d) => a + (d.time || 0), 0);
      const slow = D.filter(d => !isRight(d) && d.time > 120 && d.time > 1.5 * (d.avg_time || 0)).sort((a, b) => b.time - a.time).slice(0, 12);
      const W = 900, H = 200, L = 40, R = 8, T = 10, B = 26, n = D.length, bw = (W - L - R) / n;
      const maxT = Math.max(60, ...D.map(d => Math.max(d.time || 0, d.avg_time || 0)));
      const step = maxT > 600 ? 300 : maxT > 240 ? 120 : 60, top = Math.ceil(maxT / step) * step;
      const y = v => T + (H - T - B) * (1 - v / top);
      const NS = "http://www.w3.org/2000/svg", s = (tag, a, txt) => { const e = document.createElementNS(NS, tag); for (const k in a) e.setAttribute(k, a[k]); if (txt != null) e.textContent = txt; return e; };
      const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, class: "ra-time", role: "img", "aria-label": "Time you spent on each question, coloured by result" });
      for (let v = 0; v <= top; v += step) svg.append(s("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), class: "grid" }), s("text", { x: L - 6, y: y(v) + 4, "text-anchor": "end", class: "axis" }, `${v / 60}m`));
      const tip = h("div", { class: "ra-tip", hidden: true });
      D.forEach((d, i) => {
        const x = L + i * bw, tone = { correct: "ok", bonus: "ok", partial: "warn", wrong: "bad" }[d.result] || "blank";
        if (i > 0 && D[i - 1].subject !== d.subject) svg.append(s("line", { x1: x, x2: x, y1: T, y2: H - B, class: "divider" }), s("text", { x: x + 4, y: T + 10, class: "axis" }, cap(d.subject)));
        if (i === 0) svg.append(s("text", { x: x + 4, y: T + 10, class: "axis" }, cap(d.subject)));
        const hgt = Math.max(1.5, (H - T - B) - (y(d.time || 0) - T));
        svg.append(s("rect", { x: x + bw * 0.15, width: Math.max(1, bw * 0.7), y: H - B - hgt, height: hgt, rx: Math.min(2, bw * 0.3), class: "b " + tone }));
        if (d.avg_time) svg.append(s("line", { x1: x + bw * 0.05, x2: x + bw * 0.95, y1: y(d.avg_time), y2: y(d.avg_time), class: "avg" }));
        if (i % 5 === 0 || n <= 30) svg.append(s("text", { x: x + bw / 2, y: H - 8, "text-anchor": "middle", class: "axis" }, d.q));
        const hit = s("rect", { x, width: bw, y: T, height: H - T - B, class: "hit" });
        hit.addEventListener("mouseenter", () => { tip.hidden = false; show(tip, h("b", {}, `Q${d.q} · ${(RES[d.result] || [d.result])[0]}`), h("div", {}, `Your time ${fmtT(d.time)}`), h("div", { class: "muted" }, `Average ${fmtT(d.avg_time)}`));
          const r = svg.getBoundingClientRect(), px = ((x + bw / 2) / W) * r.width; tip.style.left = `${Math.min(Math.max(px, 70), r.width - 70)}px`; });
        hit.addEventListener("mouseleave", () => (tip.hidden = true));
        hit.addEventListener("click", () => openQ(D, i));
        svg.append(hit);
      });
      const bySub = rep.subjects.map(k => { const l = D.filter(d => d.subject === k), at = l.filter(d => d.result !== "blank");
        return h("tr", {}, h("td", {}, h("b", {}, cap(k))), h("td", { class: "num" }, fmtT(tsum(l))), h("td", { class: "num" }, at.length), h("td", { class: "num" }, at.length ? fmtT(Math.round(tsum(l) / at.length)) : "—"), h("td", { class: "num" }, fmtT(tsum(l.filter(isRight)))), h("td", { class: "num" }, fmtT(tsum(l.filter(d => d.result === "wrong"))))); });
      timeCard = h("div", { class: "card" }, h("div", { class: "head" }, h("div", {}, h("h2", {}, "Time analysis"), h("p", { class: "small muted", style: "margin:2px 0 0" }, `Started ${when(rep.attempt.started_at)} · submitted ${when(rep.attempt.submitted_at)}`)),
          h("div", { class: "ra-legend small" }, LEG.map(([c, l]) => h("span", {}, h("i", { class: "sw " + c }), l)), h("span", {}, h("i", { class: "sw avgline" }), "Average of all students"))),
        h("div", { class: "stats" },
          h("div", { class: "stat" }, h("b", {}, fmtT(used)), h("span", {}, `Time used${rep.attempt.duration ? ` of ${rep.attempt.duration} min` : ""}`)),
          h("div", { class: "stat ok" }, h("b", {}, fmtT(tsum(D.filter(isRight)))), h("span", {}, "On right answers")),
          h("div", { class: "stat warn" }, h("b", {}, fmtT(tsum(D.filter(d => d.result === "wrong")))), h("span", {}, "On wrong answers")),
          h("div", { class: "stat" }, h("b", {}, fmtT(tsum(D.filter(d => d.result === "blank")))), h("span", {}, "On questions left blank"))),
        h("div", { class: "ra-chart" }, svg, tip),
        h("div", { class: "tablebox" }, h("table", {}, h("thead", {}, h("tr", {}, ["Subject", "Time", "Attempted", "Per attempt", "On right", "On wrong"].map((x, i) => h("th", { class: i ? "num" : "" }, x)))), h("tbody", {}, bySub))),
        slow.length ? h("div", { class: "ra-group" }, h("p", {}, h("b", {}, "Too long, still not right"), h("span", { class: "small muted" }, " — over 2 minutes and much longer than average. Next time, move on sooner.")), h("div", { class: "qchips" }, slow.map(d => qChip(d, slow)))) : null);
    }

    // ---- micro analysis: every question
    const sel = (id, label, opts) => h("select", { id, "aria-label": label }, h("option", { value: "" }, label), opts.map(([v, t]) => h("option", { value: v }, t)));
    const fRes = sel("ra-res", "All results", [["right", "Right"], ["wrong", "Wrong"], ["blank", "Not answered"], ["partial", "Partly right"]]);
    const fSub = rep.subjects.length > 1 ? sel("ra-sub", "All subjects", rep.subjects.map(k => [k, cap(k)])) : null;
    const chs = [...new Set(D.map(ch).filter(Boolean))].sort();
    const fCh = chs.length ? sel("ra-ch", "All chapters", chs.map(c => [c, c])) : null;
    const lvs = QLEVELS.filter(l => D.some(d => lv(d) === l));
    const fLv = lvs.length ? sel("ra-lv", "All levels", lvs.map(l => [l, l])) : null;
    const tb = h("tbody"), count = h("span", { class: "small muted" });
    const drawTable = () => {
      const list = D.filter(d => (!fRes.value || (fRes.value === "right" ? isRight(d) : d.result === fRes.value)) && (!fSub || !fSub.value || d.subject === fSub.value)
        && (!fCh || !fCh.value || ch(d) === fCh.value) && (!fLv || !fLv.value || lv(d) === fLv.value));
      count.textContent = `${list.length} question${list.length === 1 ? "" : "s"} · tap one to see it with the solution`;
      tb.replaceChildren(...list.map((d, i) => { const [label, tone] = RES[d.result] || [d.result, ""], q = d.question;
        return h("tr", { tabindex: 0, class: "ra-row " + tone, onclick: () => openQ(list, i), onkeydown: e => e.key === "Enter" && openQ(list, i) },
          h("td", {}, h("span", { class: "qdot " + tone }, d.q)), h("td", {}, cap(d.subject)),
          h("td", { class: "ra-topic" }, q && q.chapter ? h("b", {}, q.chapter) : h("span", { class: "muted" }, "—"), q && q.topic ? h("div", { class: "small muted" }, q.topic) : null),
          h("td", {}, q && q.level ? h("span", { class: "pill lv" + (QLEVELS.indexOf(q.level) + 1) }, q.level) : "—"),
          h("td", { class: "mono" }, `${d.marked || "–"} / ${d.key || "–"}`), h("td", {}, h("span", { class: "pill " + tone }, label)),
          h("td", { class: "num" }, `${d.marks > 0 ? "+" : ""}${d.marks}`), hasTime ? h("td", { class: "num" }, fmtT(d.time)) : null, h("td", { class: "num" }, `${d.right_pct}%`)); }));
    };
    [fRes, fSub, fCh, fLv].filter(Boolean).forEach(f => (f.onchange = drawTable));

    // the student's OMR sheet, redrawn from what the scanner read
    async function openSheet() {
      let svg;
      try { await need("qrcode"); svg = SH.sheetSvg(O.getLayout(rep.test.sheet), { code: rep.test.code, name: rep.test.name }, { roll: (rep.student || {}).roll, name: (rep.student || {}).name }, rep.detail); }
      catch (e) { toast("This sheet could not be drawn."); return; }
      const online = false;
      wideModal((b, close) => b.append(
        h("div", { class: "qv-head" }, h("b", {}, online ? "Your answers on an OMR sheet" : "Your OMR sheet"), h("span", { style: "flex:1" }),
          h("button", { class: "btn ghost small shrink", type: "button", "aria-label": "Close", onclick: close }, "✕")),
        h("div", { class: "ra-legend small" }, h("span", {}, h("i", { class: "sw ok" }), "Your mark, right"), h("span", {}, h("i", { class: "sw bad" }), "Your mark, wrong"),
          h("span", {}, h("i", { class: "sw warn" }), "Partly right"), h("span", {}, h("i", { class: "sw ring" }), "Correct answer you did not mark")),
        h("div", { class: "omr-view", html: svg }),
        h("p", { class: "small muted", style: "margin:0" }, online ? "Drawn from the answers you submitted in the online test."
          : "Drawn from what the scanner read on your sheet. If you think a bubble was read wrongly, tell your campus office: they keep your paper sheet and can check it.")));
    }
    show(view, h("div", { class: "head" }, h("div", {}, back, h("h1", {}, rep.test.name), h("p", { class: "sub" }, `${rep.test.code} · ${fmtDate(rep.test.test_date)} · ${rep.test.sheet_title}`)),
        rep.test.sheet && !/online/i.test(rep.source || "") ? h("button", { class: "btn ghost small", type: "button", onclick: openSheet }, "View OMR sheet") : null),
      h("div", { class: "stats" }, h("div", { class: "stat gold" }, h("b", {}, `${rep.total} / ${rep.max}`), h("span", {}, `${pct}% of full marks`)),
        h("div", { class: "stat" }, h("b", {}, `${rep.rank_batch} / ${rep.rank_batch_of}`), h("span", {}, "Rank in batch")),
        h("div", { class: "stat" }, h("b", {}, `${rep.rank_campus} / ${rep.rank_campus_of}`), h("span", {}, "Rank in campus")),
        h("div", { class: "stat" }, h("b", {}, `${rep.rank_all} / ${rep.rank_all_of}`), h("span", {}, "Overall rank")),
        h("div", { class: "stat ok" }, h("b", {}, rep.correct), h("span", {}, "Right")), h("div", { class: "stat warn" }, h("b", {}, rep.wrong), h("span", {}, "Wrong")), h("div", { class: "stat" }, h("b", {}, rep.blank), h("span", {}, "Not answered"))),
      h("div", { class: "card" }, h("h2", {}, "Subject-wise"), h("div", { class: "bars" }, rep.subjects.map(s => {
        const got = rep.by_subject[s] || 0, out = rep.subject_max[s] || 1;
        return h("div", { class: "barrow", style: "grid-template-columns:110px minmax(0,1fr) 80px" }, h("span", {}, cap(s)),
          h("div", { class: "meter" }, h("i", { style: `width:${Math.max(0, Math.min(100, (got / out) * 100))}%` })), h("span", { class: "num" }, `${got} / ${out}`));
      })),
        rep.subject_detail ? h("div", { class: "tablebox", style: "margin-top:12px" }, h("table", {},
          h("thead", {}, h("tr", {}, ["Subject", "Marks", "Right", "Wrong", "Blank", "Accuracy", "Batch avg", "Institute avg", "Highest", "Rank in batch", "Overall rank"].map(x => h("th", {}, x)))),
          h("tbody", {}, rep.subject_detail.map(d => h("tr", {}, h("td", {}, h("b", {}, cap(d.subject))),
            h("td", { class: "num" }, h("b", {}, `${d.marks} / ${rep.subject_max[d.subject] || 0}`)), h("td", { class: "num" }, d.right + (d.partial ? ` (+${d.partial} part)` : "")), h("td", { class: "num" }, d.wrong), h("td", { class: "num" }, d.blank),
            h("td", { class: "num" }, d.accuracy == null ? "—" : `${d.accuracy}%`), h("td", { class: "num" }, d.batch_avg), h("td", { class: "num" }, d.all_avg), h("td", { class: "num" }, d.top),
            h("td", { class: "num" }, `${d.rank_batch.rank} / ${d.rank_batch.of}`), h("td", { class: "num" }, `${d.rank_all.rank} / ${d.rank_all.of}`))),
            rep.subject_detail.length > 1 ? h("tr", { class: "totalrow" }, h("td", {}, h("b", {}, "Total")), h("td", { class: "num" }, h("b", {}, `${rep.total} / ${rep.max}`)), h("td", { class: "num" }, rep.correct), h("td", { class: "num" }, rep.wrong), h("td", { class: "num" }, rep.blank),
              h("td", {}, ""), h("td", { class: "num" }, rep.batch_avg), h("td", { class: "num" }, rep.all_avg), h("td", { class: "num" }, rep.top_total), h("td", { class: "num" }, `${rep.rank_batch} / ${rep.rank_batch_of}`), h("td", { class: "num" }, `${rep.rank_all} / ${rep.rank_all_of}`)) : null))) : null),
      insight,
      timeCard,
      chapters.length ? breakdown("Chapter-wise", "Weakest chapters first. Tap a chapter to go through its questions.", chapters) : null,
      levels.length ? breakdown("By difficulty", "", levels) : null,
      h("div", { class: "card" }, h("div", { class: "head" }, h("div", {}, h("h2", {}, "Micro analysis"), count), h("div", { class: "row ra-filters" }, [fRes, fSub, fCh, fLv].filter(Boolean))),
        h("div", { class: "tablebox" }, h("table", { class: "ra-micro" }, h("thead", {}, h("tr", {}, ["Q", "Subject", "Chapter · topic", "Level", "Yours / key", "Result", "Marks", hasTime ? "Time" : null, "Class right"].filter(Boolean).map(x => h("th", {}, x)))), tb))));
    drawTable();
  }
  route(/^\/report\/(\d+)\/(\d+)$/, async (view, tid, sid) => {
    await structure();
    reportView(view, await GET(`/api/tests/${tid}/student/${sid}`), h("a", { href: `#/tests/${tid}` }, "‹ Test results"));
  }, ["central", "zone", "campus"]);

  // ================================================================ student side
  function greeting() { const hr = new Date().getHours(); return hr < 12 ? "Good morning" : hr < 17 ? "Good afternoon" : "Good evening"; }
  // a ring that fills to a percentage
  const ring = (pc, label) => h("div", { class: "ring", style: `--p:${Math.max(0, Math.min(100, pc))}`, role: "img", "aria-label": label }, h("b", {}, `${Math.round(pc)}%`));
  route(/^\/my$/, async view => {
    const tests = await GET("/api/my/tests");
    const me = state.me;
    const last = tests[0], prev = tests[1], pc = t => (t && t.max ? (t.total / t.max) * 100 : 0);
    const delta = last && prev ? Math.round((pc(last) - pc(prev)) * 10) / 10 : null;
    show(view, h("section", { class: "hero" },
        h("div", { class: "hero-id" }, h("span", { class: "hero-av" }, initials(me.name || me.username)),
          h("div", {}, h("p", { class: "hero-hi" }, greeting()), h("h1", {}, me.name || me.username),
            h("p", { class: "hero-sub" }, [`Roll ${me.roll}`, me.batch ? me.batch.name : "", me.campus || ""].filter(Boolean).join(" · ")))),
        last ? h("a", { class: "hero-score", href: `#/my/${last.id}` }, ring(pc(last), `Latest test score ${Math.round(pc(last))} percent`),
          h("div", {}, h("span", { class: "hero-lbl" }, "Latest test"), h("b", {}, last.name), h("span", { class: "hero-sub" }, `${last.total} / ${last.max} · rank ${last.rank_batch} of ${last.rank_batch_of} in batch`),
            delta != null ? h("span", { class: "hero-chip " + (delta >= 0 ? "up" : "down") }, `${delta >= 0 ? "▲" : "▼"} ${Math.abs(delta)} points from the test before`) : null)) : null),
      installHint(),
      await onlineTestsCard(),
      tests.length ? progressView(tests) : null,
      h("h2", { class: "tc-title" }, "My tests"),
      tests.length ? h("div", { class: "tcards" }, tests.map(testCard)) : h("div", { class: "card" }, h("p", { class: "empty" }, "No results yet. Your marks appear here once your institute publishes them.")));
  }, ["student"]);

  // one result card per test: name, size, timing, total and subject scores, Analytics button
  function testCard(t) {
    const cap = x => x[0] + x.slice(1).toLowerCase();
    const when = ms => new Date(ms).toLocaleString("en-IN", { hour: "numeric", minute: "2-digit", day: "numeric", month: "short", year: "numeric" });
    const pct = t.max ? Math.round((t.total / t.max) * 100) : 0;
    const subs = (t.subjects || Object.keys(t.by_subject || {}));
    return h("article", { class: "tcard" },
      h("header", {}, h("b", {}, t.name), h("span", { class: "tc-code" }, t.code)),
      h("div", { class: "tc-body" },
        h("div", { class: "tc-chips" }, h("span", { class: "tc-chip q" }, `${t.questions} Questions`), t.duration ? h("span", { class: "tc-chip m" }, `${t.duration} Mins`) : null, h("span", { class: "tc-chip k" }, `${t.max} Marks`)),
        h("dl", { class: "tc-when" }, ...(t.attempt ? [h("dt", {}, "Started at"), h("dd", {}, when(t.attempt.started_at)), h("dt", {}, "Submitted at"), h("dd", {}, when(t.attempt.submitted_at))]
          : [h("dt", {}, "Test date"), h("dd", {}, fmtDate(t.test_date)), h("dt", {}, "Written on"), h("dd", {}, "OMR sheet")])),
        h("div", { class: "tc-scores" }, h("div", { class: "tc-total" }, h("span", {}, "Total"), h("b", {}, `${t.total} / ${t.max}`), h("span", { class: "muted" }, `${pct}%`)),
          subs.length ? h("div", { class: "tc-subs" }, subs.map(k => { const got = (t.by_subject || {})[k] || 0, out = (t.subject_max || {})[k] || 0;
            return h("div", {}, h("span", {}, cap(k)), h("div", { class: "meter" }, h("i", { style: `width:${out ? Math.max(0, Math.min(100, (got / out) * 100)) : 0}%` })), h("b", {}, `${got} / ${out}`)); })) : null),
        h("div", { class: "tc-ranks small" }, h("span", {}, "Batch rank ", h("b", {}, `${t.rank_batch}/${t.rank_batch_of}`)), h("span", {}, "Overall ", h("b", {}, `${t.rank_all}/${t.rank_all_of}`)),
          h("span", {}, h("b", { class: "t-ok" }, t.correct), " right · ", h("b", { class: "t-bad" }, t.wrong), " wrong")),
        h("a", { class: "btn tc-go", href: `#/my/${t.id}` }, "Analytics ›")));
  }

  async function onlineTestsCard() {
    let r; try { r = await GET("/api/my/cbt"); } catch (e) { return null; }
    if (!r.tests.length) return null;
    const off = Date.now() - r.now;
    const when = ms => new Date(ms + off).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
    const rows = r.tests.filter(t => t.status !== "submitted" || !t.published).map(t => {
      const act = t.status === "open" ? h("a", { class: "btn gold small", href: `#/exam/${t.id}` }, "Start")
        : t.status === "in_progress" ? h("a", { class: "btn small", href: `#/exam/${t.id}` }, "Resume")
        : t.status === "submitted" ? h("span", { class: "pill ok" }, "Submitted")
        : t.status === "not_open" ? h("span", { class: "pill" }, `Opens ${when(t.opens_at)}`) : h("span", { class: "pill" }, "Closed");
      return h("div", { class: "result-row", style: "grid-template-columns:minmax(0,1fr) auto" },
        h("div", { class: "rr-main" }, h("b", {}, t.name), h("span", { class: "small muted" }, `${t.questions} questions · ${t.duration} minutes${t.closes_at && t.status === "open" ? ` · closes ${when(t.closes_at)}` : ""}`)), act);
    });
    return rows.length ? h("div", { class: "card" }, h("h2", {}, "Online tests"), h("div", { class: "results-list" }, rows)) : null;
  }

  route(/^\/exam\/(\d+)$/, async (view, id) => {
    await need("exam");
    const r = await GET("/api/my/cbt");
    const t = r.tests.find(x => x.id === +id);
    if (!t) throw new Error("This online test is not available to you.");
    if (t.status === "in_progress") return window.TPExam.exam(view, id);
    if (t.status !== "open") throw new Error(t.status === "submitted" ? "You have already submitted this test." : t.status === "not_open" ? "This test has not opened yet." : "This test is closed.");
    window.TPExam.instructions(view, t, () => window.TPExam.exam(view, id));
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
      weakest ? h("p", { class: "small", style: "margin:0" }, "Focus area: ", h("b", {}, title(weakest.k)), ". Open a test and choose \"Wrong only\" to review those questions.") : null,
      subjectMarksTable(tests));
  }
  // every test as a row, each subject's marks as a column (newest first); tap a row to open the test
  function subjectMarksTable(tests) {
    const order = ["PHYSICS", "CHEMISTRY", "MATHEMATICS", "BIOLOGY", "BOTANY", "ZOOLOGY"];
    const keys = [...new Set(tests.flatMap(t => t.subjects || Object.keys(t.by_subject || {})))]
      .sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99) || a.localeCompare(b));
    if (!keys.length) return null;
    const cap = k => k[0] + k.slice(1).toLowerCase();
    const open = t => (location.hash = `#/my/${t.id}`);
    const cell = (got, out) => out ? h("td", { class: "num" }, h("b", { class: got < 0 ? "t-bad" : "" }, got), h("span", { class: "muted small" }, ` / ${out}`),
      h("div", { class: "sm-bar" }, h("i", { style: `width:${Math.max(0, Math.min(100, (got / out) * 100))}%` }))) : h("td", { class: "num muted" }, "—");
    return h("div", { style: "display:grid;gap:6px" }, h("h3", {}, "Subject marks in each test"),
      h("div", { class: "tablebox" }, h("table", { class: "sm-table" },
        h("thead", {}, h("tr", {}, h("th", {}, "Test"), ...keys.map(k => h("th", { class: "num" }, cap(k))), h("th", { class: "num" }, "Total"), h("th", { class: "num" }, "Batch rank"))),
        h("tbody", {}, tests.map(t => h("tr", { tabindex: 0, onclick: () => open(t), onkeydown: e => e.key === "Enter" && open(t) },
          h("td", {}, h("b", {}, t.name), h("div", { class: "small muted" }, `${t.code} · ${fmtDate(t.test_date)}`)),
          ...keys.map(k => cell((t.by_subject || {})[k] ?? 0, (t.subject_max || {})[k] || 0)),
          cell(t.total, t.max), h("td", { class: "num" }, `${t.rank_batch} / ${t.rank_batch_of}`)))))));
  }
  route(/^\/my\/(\d+)$/, async (view, id) => reportView(view, await GET(`/api/my/tests/${id}`), h("a", { href: "#/my" }, "‹ My results")), ["student"]);

  // ================================================================ practice: chapter strength report and short practice tests from the bank
  const capS = x => (x ? x[0].toUpperCase() + x.slice(1).toLowerCase() : "");
  async function startPractice(chapters, opts = {}) {
    try {
      const r = await POST("/api/my/practice", { chapters, count: opts.count || 10, level: opts.level || "", retry: opts.retry !== false });
      location.hash = `#/practice/${r.id}`;
    } catch (e) { toast(e.message); }
  }
  route(/^\/practice$/, async view => {
    const [rep, avail, past] = await Promise.all([GET("/api/my/chapters"), GET("/api/my/practice/chapters"), GET("/api/my/practice")]);
    const picked = new Map(rep.weak.map(w => [`${w.subject}|${w.chapter}`, { subject: w.subject, chapter: w.chapter }]));
    const has = new Set(avail.map(a => `${a.subject}|${a.chapter}`));
    const chipsBox = h("div", { class: "qchips" }), startBtn = h("button", { class: "btn gold", type: "button" }, "Start practice");
    const count = h("select", { id: "pr-count", "aria-label": "Number of questions" }, [10, 15, 20, 25].map(n => h("option", { value: n }, `${n} questions`)));
    const level = h("select", { id: "pr-level", "aria-label": "Level" }, h("option", { value: "" }, "Any level"), QLEVELS.map(l => h("option", { value: l }, l)));
    const retry = h("input", { type: "checkbox", id: "pr-retry", checked: true });
    const subs = [...new Set(avail.map(a => a.subject))];
    const addSub = h("select", { id: "pr-sub", "aria-label": "Subject" }, subs.map(s => h("option", { value: s }, capS(s))));
    const addCh = h("select", { id: "pr-ch", "aria-label": "Chapter to add" });
    const fillCh = () => addCh.replaceChildren(h("option", { value: "" }, "Add a chapter…"), ...avail.filter(a => a.subject === addSub.value).map(a => h("option", { value: a.chapter }, `${a.chapter} (${a.n})`)));
    addSub.onchange = fillCh; fillCh();
    addCh.onchange = () => { if (addCh.value) { picked.set(`${addSub.value}|${addCh.value}`, { subject: addSub.value, chapter: addCh.value }); addCh.value = ""; drawPicked(); } };
    function drawPicked() {
      show(chipsBox, ...(picked.size ? [...picked].map(([k, c]) => h("span", { class: "chip pr-chip" }, c.chapter, h("span", { class: "muted small" }, ` · ${capS(c.subject)}`),
        h("button", { type: "button", "aria-label": `Remove ${c.chapter}`, onclick: () => { picked.delete(k); drawPicked(); } }, "✕"))) : [h("span", { class: "small muted" }, "No chapters chosen yet. Add one below.")]));
      startBtn.disabled = !picked.size;
    }
    startBtn.onclick = () => startPractice([...picked.values()].filter(c => has.has(`${c.subject}|${c.chapter}`)).length ? [...picked.values()] : [], { count: +count.value, level: level.value, retry: retry.checked });
    drawPicked();
    const bar = pc => h("div", { class: "meter pr-meter" }, h("i", { style: `width:${Math.max(2, pc)}%;background:${pc < 40 ? "var(--bad)" : pc < 60 ? "var(--warn)" : "var(--ok)"}` }));
    const weakCard = h("div", { class: "card" }, h("div", { class: "head" }, h("div", {}, h("h2", {}, "Your weakest chapters"),
        h("p", { class: "small muted", style: "margin:2px 0 0" }, rep.weak.length ? "Revise in this order: the chapters where you lost the most marks come first." : "")),
        rep.weak.length ? h("span", { class: "pill" }, `From ${rep.tests} test${rep.tests === 1 ? "" : "s"}`) : null),
      rep.weak.length ? h("ol", { class: "pr-weak" }, rep.weak.map(w => h("li", {},
        h("div", { class: "pr-weak-t" }, h("b", {}, w.chapter), h("span", { class: "small muted" }, `${capS(w.subject)} · ${w.right} of ${w.n} right · ${w.lost} marks lost`)),
        bar(w.accuracy), h("span", { class: "pr-acc" }, `${w.accuracy}%`),
        has.has(`${w.subject}|${w.chapter}`) ? h("button", { class: "btn small ghost", type: "button", onclick: () => startPractice([{ subject: w.subject, chapter: w.chapter }]) }, "Practise") : h("span", { class: "small muted" }, "No bank questions"))))
        : h("p", { class: "empty" }, rep.chapters.length ? "No weak chapters right now: you're above 60% in every chapter with 2 or more questions. Pick any chapter below to keep practising." : "Your chapter report appears after your first results are published (for tests made from the question bank)."));
    const allCard = rep.chapters.length ? h("details", { class: "card" }, h("summary", {}, h("b", {}, "All my chapters"), h("span", { class: "small muted" }, ` · ${rep.chapters.length}, weakest first`)),
      h("div", { class: "tablebox", style: "margin-top:12px" }, h("table", {}, h("thead", {}, h("tr", {}, ["Chapter", "Subject", "Questions", "Right", "Wrong", "Skipped", "Accuracy", "Marks lost", ""].map((x, i) => h("th", { class: i >= 2 && i <= 7 ? "num" : "" }, x)))),
        h("tbody", {}, rep.chapters.map(c => h("tr", {}, h("td", {}, h("b", {}, c.chapter)), h("td", {}, capS(c.subject)), h("td", { class: "num" }, c.n), h("td", { class: "num" }, c.right), h("td", { class: "num" }, c.wrong), h("td", { class: "num" }, c.blank + c.partial),
          h("td", { class: "num" }, h("div", { class: "pr-acc-cell" }, bar(c.accuracy), h("span", {}, `${c.accuracy}%`))), h("td", { class: "num" }, c.lost),
          h("td", {}, has.has(`${c.subject}|${c.chapter}`) ? h("button", { class: "link small", type: "button", onclick: () => startPractice([{ subject: c.subject, chapter: c.chapter }]) }, "Practise") : null))))))) : null;
    const pastCard = h("div", { class: "card" }, h("h2", {}, "My practice tests"),
      past.length ? h("div", { class: "pr-past" }, past.map(p => h("a", { class: "pr-row", href: `#/practice/${p.id}` },
        h("div", { class: "pr-row-t" }, h("b", {}, p.title), h("span", { class: "small muted" }, `${new Date(p.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })} · ${p.count} questions`)),
        p.submitted_at ? h("span", { class: "pr-score" }, h("b", {}, `${p.score} / ${p.max}`), h("span", { class: "small muted" }, `${p.n_right} right · ${p.n_wrong} wrong`)) : h("span", { class: "pill warn" }, "Continue"),
        h("span", { class: "rr-go", "aria-hidden": "true" }, "›"))))
        : h("p", { class: "empty" }, "Your practice tests will be listed here."));
    show(view, h("div", { class: "head" }, h("div", {}, h("h1", {}, "Practice"), h("p", { class: "sub" }, "Short tests from the question bank on the chapters you choose, marked as soon as you submit."))),
      weakCard,
      h("div", { class: "card" }, h("h2", {}, "Make a practice test"), chipsBox,
        h("div", { class: "row filters" }, addSub, addCh),
        h("div", { class: "row filters" }, count, level, h("label", { class: "imp-check" }, retry, h("span", {}, "Include questions I got wrong in tests"))),
        h("div", { class: "row" }, startBtn)),
      allCard, pastCard);
  }, ["student"]);

  route(/^\/practice\/(\d+)$/, async (view, id) => {
    const P = await GET(`/api/my/practice/${id}`);
    const back = h("a", { href: "#/practice" }, "‹ Practice");
    const Q = P.questions, A = { ...P.answers };
    const body = q => (q.fmt === "html" ? richNode(q.text) : h("div", { style: "white-space:pre-wrap" }, q.text));
    const RES = { correct: ["Right", "ok"], wrong: ["Wrong", "bad"], blank: ["Skipped", ""] };
    if (P.submitted_at) {
      const acc = P.n_right + P.n_wrong ? Math.round((P.n_right / (P.n_right + P.n_wrong)) * 100) : 0;
      const chapters = [...new Map(Q.map(q => [`${q.subject}|${q.chapter}`, { subject: q.subject, chapter: q.chapter }])).values()];
      show(view, h("div", { class: "head" }, h("div", {}, back, h("h1", {}, P.title), h("p", { class: "sub" }, `Practice · ${Q.length} questions · submitted ${new Date(P.submitted_at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}`)),
          h("button", { class: "btn gold", type: "button", onclick: () => startPractice(chapters, { count: Q.length }) }, "Practise again")),
        h("div", { class: "stats" }, h("div", { class: "stat gold" }, h("b", {}, `${P.score} / ${P.max}`), h("span", {}, "Score (+4 right, −1 wrong single-choice)")),
          h("div", { class: "stat ok" }, h("b", {}, P.n_right), h("span", {}, "Right")), h("div", { class: "stat warn" }, h("b", {}, P.n_wrong), h("span", {}, "Wrong")),
          h("div", { class: "stat" }, h("b", {}, Q.length - P.n_right - P.n_wrong), h("span", {}, "Skipped")), h("div", { class: "stat" }, h("b", {}, `${acc}%`), h("span", {}, "Accuracy"))),
        ...Q.map((q, i) => { const [label, tone] = RES[q.result] || ["", ""];
          return h("div", { class: "card pr-review " + tone }, h("div", { class: "qv-head" }, h("b", {}, `Q${i + 1}`), h("span", { class: "pill " + tone }, label),
              h("span", { class: "small muted" }, [q.chapter, q.topic].filter(Boolean).join(" · ")), q.level ? h("span", { class: "pill lv" + (QLEVELS.indexOf(q.level) + 1) }, q.level) : null),
            body(q), h("div", { class: "ra-facts" }, h("div", {}, h("span", {}, "Your answer"), h("b", { class: "mono" }, A[q.id] || "—")), h("div", {}, h("span", {}, "Correct answer"), h("b", { class: "mono" }, q.answer || "—"))),
            q.solution ? h("details", { open: q.result !== "correct" }, h("summary", {}, "Solution"), q.fmt === "html" ? richNode(q.solution) : h("div", { style: "white-space:pre-wrap" }, q.solution)) : null); }));
      return;
    }
    let cur = Math.max(0, Q.findIndex(q => !A[q.id])), saveT = 0;
    if (cur < 0) cur = 0;
    const save = () => { clearTimeout(saveT); saveT = setTimeout(() => PUT(`/api/my/practice/${id}`, { answers: A }).catch(() => {}), 800); };
    const pal = h("div", { class: "pr-pal" }), card = h("div", { class: "card pr-q" }), count = h("span", { class: "small muted" });
    function draw() {
      const q = Q[cur];
      count.textContent = `${Object.keys(A).filter(k => A[k]).length} of ${Q.length} answered`;
      show(pal, ...Q.map((x, i) => h("button", { type: "button", class: "pr-dot" + (A[x.id] ? " done" : "") + (i === cur ? " cur" : ""), "aria-label": `Question ${i + 1}${A[x.id] ? ", answered" : ""}`, onclick: () => { cur = i; draw(); } }, i + 1)));
      const answer = q.qtype === "single"
        ? h("div", { class: "pr-opts", role: "radiogroup", "aria-label": "Your answer" }, ["A", "B", "C", "D"].map(o => h("button", { type: "button", role: "radio", "aria-checked": String(A[q.id] === o), class: "pr-opt" + (A[q.id] === o ? " on" : ""),
            onclick: () => { A[q.id] = A[q.id] === o ? "" : o; save(); draw(); } }, `(${o})`)))
        : h("label", { class: "f", style: "max-width:220px" }, "Your answer (number)", h("input", { id: "pr-num", inputmode: "decimal", value: A[q.id] || "", autocomplete: "off",
            oninput: e => { A[q.id] = e.target.value.replace(/[^0-9.\-]/g, "").slice(0, 12); save(); count.textContent = `${Object.keys(A).filter(k => A[k]).length} of ${Q.length} answered`; } }));
      show(card, h("div", { class: "qv-head" }, h("b", {}, `Question ${cur + 1} of ${Q.length}`), h("span", { class: "small muted" }, [capS(q.subject), q.chapter].filter(Boolean).join(" · ")),
          q.level ? h("span", { class: "pill lv" + (QLEVELS.indexOf(q.level) + 1) }, q.level) : null),
        body(q), q.image ? h("img", { src: q.image, alt: "", style: "max-width:100%" }) : null, answer,
        h("div", { class: "qv-foot" }, h("button", { class: "btn ghost small", type: "button", disabled: cur === 0, onclick: () => { cur--; draw(); } }, "‹ Previous"),
          h("button", { class: "btn ghost small", type: "button", disabled: cur === Q.length - 1, onclick: () => { cur++; draw(); } }, "Next ›")));
    }
    const submit = h("button", { class: "btn gold", type: "button", onclick: () => {
      const left = Q.filter(q => !A[q.id]).length;
      modal((b, close) => b.append(h("h2", {}, "Submit this practice?"), h("p", {}, left ? `${left} question${left === 1 ? " is" : "s are"} not answered yet.` : "All questions are answered."),
        h("div", { class: "row" }, h("button", { class: "btn gold", type: "button", onclick: async () => { close(); clearTimeout(saveT);
            try { await POST(`/api/my/practice/${id}/submit`, { answers: A }); render(); } catch (e) { toast(e.message); } } }, "Submit"),
          h("button", { class: "btn ghost", type: "button", onclick: close }, "Keep going"))));
    } }, "Submit");
    show(view, h("div", { class: "head" }, h("div", {}, back, h("h1", {}, P.title), h("p", { class: "sub" }, count)), submit), pal, card);
    draw();
  }, ["student"]);

  // ================================================================ my mistakes: every wrong / skipped question till date, by subject → chapter → topic
  route(/^\/mistakes$/, async view => {
    const r = await GET("/api/my/mistakes");
    const cap = x => (x ? x[0].toUpperCase() + x.slice(1).toLowerCase() : "");
    const RES = { wrong: ["Wrong", "bad"], blank: ["Skipped", ""], partial: ["Partly right", "warn"] };
    let pref = {}; try { pref = JSON.parse(localStorage.getItem("tp-mistakes") || "{}"); } catch (e) { pref = {}; }
    const keep = () => { try { localStorage.setItem("tp-mistakes", JSON.stringify({ type: fType.value, sub: fSub.value, ch: fCh.value, tp: fTp.value, test: fTest.value, sort: fSort.value, hide: fHide.checked })); } catch (e) { /* ignore */ } };
    const sel = (id, label, opts, v) => h("select", { id, "aria-label": label }, opts.map(([k, t]) => h("option", { value: k, selected: v === k }, t)));
    const SUBJ_ORDER = ["physics", "chemistry", "mathematics", "maths", "biology", "botany", "zoology"];
    const subjects = [...new Set(r.items.map(i => cap(i.subject)))].sort((a, b) => ((SUBJ_ORDER.indexOf(a.toLowerCase()) + 1 || 99) - (SUBJ_ORDER.indexOf(b.toLowerCase()) + 1 || 99)) || a.localeCompare(b));
    const tests = [...new Map(r.items.slice().reverse().map(i => [String(i.test_id), `${i.code} · ${i.test}`])).entries()];
    const fType = sel("mk-type", "Which questions", [["", "Wrong and skipped"], ["wrong", "Wrong only"], ["blank", "Skipped only"], ["partial", "Partly right only"]], pref.type || "");
    const fSub = sel("mk-sub", "Subject", [["", "All subjects"], ...subjects.map(s => [s, s])], pref.sub || "");
    const fTest = sel("mk-test", "Test", [["", "All tests"], ...tests], pref.test || "");
    const fHide = h("input", { type: "checkbox", id: "mk-hide", checked: pref.hide !== false });
    // chapter and subtopic lists follow the subject (and chapter) chosen
    const fCh = h("select", { id: "mk-ch", "aria-label": "Chapter" }), fTp = h("select", { id: "mk-tp", "aria-label": "Subtopic" });
    const NONE = "__none", val = el => (el.value === NONE ? "" : el.value), any = el => el.disabled || el.value === "";
    const fill = (el, first, vals, want) => { el.replaceChildren(h("option", { value: "" }, first), ...vals.map(v => h("option", { value: v || NONE }, v || "Not tagged")));
      el.value = [...el.options].some(o => o.value === want) ? want : ""; };
    const syncLists = (wantCh, wantTp) => {
      const inSub = r.items.filter(i => !fSub.value || cap(i.subject) === fSub.value);
      fill(fCh, "All chapters", [...new Set(inSub.map(i => i.chapter))].sort((a, b) => (!a - !b) || a.localeCompare(b)), wantCh);
      const inCh = inSub.filter(i => any(fCh) || i.chapter === val(fCh));
      fill(fTp, "All subtopics", [...new Set(inCh.map(i => i.topic))].sort((a, b) => (!a - !b) || a.localeCompare(b)), wantTp);
      fTp.disabled = !fCh.value;
    };
    const fSort = sel("mk-sort", "Sort chapters", [["az", "Chapters A–Z"], ["most", "Most mistakes first"], ["recent", "Latest test first"]], pref.sort || "az");
    const box = h("div", { style: "display:grid;gap:16px" }), tiles = h("div", { class: "stats" });
    const qCache = new Map();

    function popup(list, i) {
      let cur = i, bodyEl, closeFn;
      const keys = e => { if ($("#modal").hidden) { document.removeEventListener("keydown", keys); return; }
        if (e.key === "ArrowRight") step(1); else if (e.key === "ArrowLeft") step(-1); else if (e.key === "Escape") closeFn(); };
      const step = k => { if (cur + k >= 0 && cur + k < list.length) { cur += k; draw(); } };
      async function draw() {
        const m = list[cur], [label, tone] = RES[m.result] || [m.result, ""], k = `${m.test_id}:${m.qno}`;
        const body = h("div", { class: "small muted" }, "Loading…");
        const reveal = h("div", { class: "ra-facts" },
          h("div", {}, h("span", {}, "Your answer"), h("b", { class: "mono" }, m.marked || "—")),
          h("div", {}, h("span", {}, "Correct answer"), h("b", { class: "mono" }, m.key || "—")),
          h("div", {}, h("span", {}, "Marks"), h("b", {}, `${m.marks > 0 ? "+" : ""}${m.marks}`)),
          h("div", {}, h("span", {}, "Got it right"), h("b", {}, `${m.right_pct}% of students`)));
        const solBox = h("div");
        const hidden = fHide.checked;
        const showBtn = h("button", { class: "btn small", type: "button", onclick: () => { showBtn.remove(); reveal.hidden = false; solBox.hidden = false; } }, "Show answer and solution");
        reveal.hidden = hidden; solBox.hidden = hidden;
        show(bodyEl,
          h("div", { class: "qv-head" }, h("b", {}, `${m.code} · Q${m.qno}`), h("span", { class: "pill " + tone }, label), h("span", { class: "small muted" }, `${cur + 1} of ${list.length}`),
            h("button", { class: "btn ghost small shrink", type: "button", "aria-label": "Close", onclick: () => closeFn() }, "✕")),
          h("div", { class: "chips" }, [cap(m.subject), m.chapter, m.topic].filter(Boolean).map(t => h("span", { class: "chip" }, t)), m.level ? h("span", { class: "pill lv" + (QLEVELS.indexOf(m.level) + 1) }, m.level) : null),
          body, hidden ? h("div", { class: "row" }, h("span", { class: "small muted" }, `Your answer: ${m.marked || "skipped"}`), showBtn) : null, reveal, solBox,
          h("div", { class: "qv-foot" },
            h("button", { class: "btn ghost small", type: "button", disabled: cur <= 0, onclick: () => step(-1) }, "‹ Previous"),
            h("button", { class: "btn ghost small", type: "button", disabled: cur >= list.length - 1, onclick: () => step(1) }, "Next ›")));
        bodyEl.parentElement.scrollTop = 0;
        let q = qCache.get(k);
        if (!q) { try { q = await GET(`/api/my/mistakes/${m.test_id}/${m.qno}`); qCache.set(k, q); } catch (e) { body.textContent = e.message; return; } }
        if (list[cur] !== m) return;
        show(body, q.fmt === "html" ? richNode(q.text) : q.text ? h("div", { style: "white-space:pre-wrap" }, q.text) : null,
          q.image ? h("img", { src: q.image, alt: `Question ${m.qno}`, style: "max-width:100%;border-radius:4px" }) : null,
          q.options && q.options.some(Boolean) ? h("div", { class: "opts" }, q.options.map((o, j) => o ? h("div", {}, `(${"ABCD"[j]}) ${o}`) : null)) : null);
        show(solBox, q.solution ? h("details", { open: true }, h("summary", {}, "Solution"), q.fmt === "html" ? richNode(q.solution) : h("div", { style: "white-space:pre-wrap" }, q.solution)) : h("p", { class: "small muted" }, "No solution for this question."));
      }
      closeFn = wideModal((b, close) => { bodyEl = b; closeFn = close; draw(); });
      document.addEventListener("keydown", keys);
    }

    function draw() {
      keep();
      const list = r.items.filter(i => (!fType.value || i.result === fType.value) && (!fSub.value || cap(i.subject) === fSub.value) && (!fTest.value || String(i.test_id) === fTest.value)
        && (any(fCh) || i.chapter === val(fCh)) && (any(fTp) || i.topic === val(fTp)));
      const cnt = k => list.filter(i => i.result === k).length;
      show(tiles,
        h("div", { class: "stat warn" }, h("b", {}, cnt("wrong")), h("span", {}, "Wrong")),
        h("div", { class: "stat" }, h("b", {}, cnt("blank")), h("span", {}, "Skipped")),
        cnt("partial") ? h("div", { class: "stat gold" }, h("b", {}, cnt("partial")), h("span", {}, "Partly right")) : null,
        h("div", { class: "stat" }, h("b", {}, r.tests), h("span", {}, `Test${r.tests === 1 ? "" : "s"} so far`)));
      if (!list.length) { show(box, h("div", { class: "card" }, h("p", { class: "empty" }, r.items.length ? "Nothing matches these choices." : "No mistakes to show yet. They appear here once your results are published."))); return; }
      // order: subject → chapter → topic → newest test first
      const ord = list.slice().sort((a, b) => ((SUBJ_ORDER.indexOf(a.subject.toLowerCase()) + 1 || 99) - (SUBJ_ORDER.indexOf(b.subject.toLowerCase()) + 1 || 99)) || cap(a.subject).localeCompare(cap(b.subject))
        || (!a.chapter - !b.chapter) || a.chapter.localeCompare(b.chapter) || (!a.topic - !b.topic) || a.topic.localeCompare(b.topic) || String(b.date).localeCompare(String(a.date)) || a.qno - b.qno);
      const bySub = new Map();
      for (const m of ord) { const s = cap(m.subject), c = m.chapter || "", t = m.topic || "";
        if (!bySub.has(s)) bySub.set(s, new Map()); const chs = bySub.get(s); if (!chs.has(c)) chs.set(c, new Map()); const tps = chs.get(c); if (!tps.has(t)) tps.set(t, []); tps.get(t).push(m); }
      // chapter order inside each subject
      for (const [s, chs] of bySub) {
        const meta = [...chs].map(([c, tps]) => { const all = [...tps.values()].flat(); return [c, tps, all.length, all.reduce((m, x) => (String(x.date) > m ? String(x.date) : m), "")]; });
        meta.sort((a, b) => (!a[0] - !b[0]) || (fSort.value === "most" ? b[2] - a[2] : fSort.value === "recent" ? b[3].localeCompare(a[3]) : 0) || a[0].localeCompare(b[0]));
        bySub.set(s, new Map(meta.map(([c, tps]) => [c, tps])));
      }
      ord.splice(0, ord.length, ...[...bySub.values()].flatMap(chs => [...chs.values()].flatMap(tps => [...tps.values()].flat())));
      const open = ord.length <= 25;
      const row = m => { const [label, tone] = RES[m.result] || [m.result, ""];
        return h("button", { class: "mk-row", type: "button", onclick: () => popup(ord, ord.indexOf(m)) },
          h("span", { class: "qdot " + tone }, m.qno), h("span", { class: "mk-main" }, h("b", {}, `${m.code}`), h("span", { class: "small muted" }, ` · ${fmtDate(m.date)}`)),
          h("span", { class: "pill " + tone }, label), m.level ? h("span", { class: "mk-hide pill lv" + (QLEVELS.indexOf(m.level) + 1) }, m.level) : h("span", { class: "mk-hide" }),
          h("span", { class: "small muted mk-hide" }, `${m.right_pct}% got it`)); };
      show(box, ...[...bySub].map(([s, chs]) => {
        const n = [...chs.values()].reduce((a, tps) => a + [...tps.values()].reduce((x, l) => x + l.length, 0), 0);
        return h("div", { class: "card" }, h("div", { class: "head" }, h("h2", {}, s), h("span", { class: "pill" }, `${n} question${n === 1 ? "" : "s"}`)),
          ...[...chs].map(([c, tps]) => {
            const all = [...tps.values()].flat(), w = all.filter(m => m.result === "wrong").length, sk = all.filter(m => m.result === "blank").length;
            return h("details", { class: "mk-ch", open },
              h("summary", {}, h("b", {}, c || "Chapter not tagged"), h("span", { class: "small muted" }, ` · ${all.length}` + (w && sk ? ` (${w} wrong, ${sk} skipped)` : ""))),
              ...[...tps].map(([t, l]) => h("div", { class: "mk-topic" }, t ? h("div", { class: "mk-th small" }, t) : null, ...l.map(row))));
          }));
      }),
      r.noQuestion.length ? h("p", { class: "small muted", style: "margin:0" }, `Not listed: ${r.noQuestion.map(x => `${x.count} from ${x.code}`).join(", ")}. Those tests have only an answer key in the portal, so their questions can't be shown.`) : null);
    }
    [fType, fTest, fSort, fHide].forEach(f => (f.onchange = draw));
    fSub.onchange = () => { syncLists("", ""); draw(); };
    fCh.onchange = () => { syncLists(fCh.value, ""); draw(); };
    fTp.onchange = draw;
    syncLists(pref.ch || "", pref.tp || "");
    show(view, h("div", { class: "head" }, h("div", {}, h("h1", {}, "My mistakes"), h("p", { class: "sub" }, "Every question you got wrong or skipped, in all your tests so far. Tap one to try it again and see the solution.")),
        h("a", { class: "btn gold", href: "#/practice" }, "Practise weak chapters")),
      tiles,
      h("div", { class: "card" }, h("div", { class: "row filters" }, fType, fSub, fCh, fTp, fTest, fSort,
        h("label", { class: "imp-check" }, fHide, h("span", {}, "Hide the answer until I tap Show")))),
      box);
    draw();
  }, ["student"]);

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
