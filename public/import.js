/* Import a paper made outside the portal: the question paper PDF (and optionally the answer key /
   solutions PDF) is read in the browser. Each question and solution is cut out as a picture exactly as
   printed, the answer key table is read, and everything is shown for checking before it is saved. */
(function () {
  "use strict";
  const X = window.TPX, O = window.OMR;
  const { h, show, toast, POST } = X;
  const SCALE = 2; // render at 144 dpi: sharp on screen and on paper, small files
  const cap = s => (s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : "");
  const BREAK = /^(?:part\b.{0,40}|section\b.{0,40}|(?:physics|chemistry|mathematics|maths|biology|botany|zoology)(?:\s*[:\-–].{0,30})?)$/i;
  const QSTART = /^(?:q\.?\s*)?(\d{1,3})\s*[.)]/i;
  const STOP = /rough\s*work|end\s+of\s+(the\s+)?(paper|test|question)|all\s+the\s+best|^[◆♦*•·\-–—_=☺\s]{3,}$/i;
  const isBreak = L => { const c = L.text.replace(/\s+/g, ""); return BREAK.test(L.text) || /^(part[a-z0-9:\-–]{0,40}|section[\-–]?[a-z0-9(]{0,30}.{0,20}|physics|chemistry|mathematics|maths|biology|botany|zoology)$/i.test(c) || STOP.test(L.text); };

  // ------------------------------------------------------------------ reading a PDF
  async function openPdf(file) { return pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise; }

  async function readText(pdf) {
    const pages = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n), vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const items = tc.items.filter(it => it.str && it.str.trim()).map(it => {
        const t = it.transform, hgt = Math.max(4, Math.hypot(t[2], t[3]) || it.height || 10);
        return { s: it.str.trim(), x: t[4], y: vp.height - t[5], w: it.width || 0, h: hgt };
      });
      // group into lines by baseline
      items.sort((a, b) => a.y - b.y || a.x - b.x);
      const lines = [];
      for (const it of items) {
        const L = lines.find(l => Math.abs(l.y - it.y) < Math.max(2.5, it.h * 0.3));
        if (L) { L.items.push(it); L.h = Math.max(L.h, it.h); } else lines.push({ y: it.y, h: it.h, items: [it] });
      }
      for (const L of lines) { L.items.sort((a, b) => a.x - b.x); L.text = L.items.map(i => i.s).join(" ").replace(/\s+/g, " ").trim(); }
      lines.sort((a, b) => a.y - b.y);
      const xs = items.map(i => i.x), xe = items.map(i => i.x + i.w);
      pages.push({ n, W: vp.width, H: vp.height, lines, minX: xs.length ? Math.min(...xs) : 30, maxX: xe.length ? Math.max(...xe) : vp.width - 30 });
      page.cleanup();
    }
    // header / footer lines repeated on most pages are not part of any question
    const key = L => L.text.replace(/\d+/g, "#").toLowerCase();
    const seen = new Map();
    for (const p of pages) for (const L of p.lines) { const k = key(L) + "@" + Math.round(L.y / 6); seen.set(k, (seen.get(k) || 0) + 1); }
    const need = Math.max(2, Math.ceil(pages.length * 0.5));
    for (const p of pages) {
      let top = p.H * 0.03, bottom = p.H * 0.975;
      if (pages.length > 2) for (const L of p.lines) {
        if ((seen.get(key(L) + "@" + Math.round(L.y / 6)) || 0) < need) continue;
        if (L.y < p.H * 0.2) top = Math.max(top, L.y + 3); else if (L.y > p.H * 0.8) bottom = Math.min(bottom, L.y - L.h - 3);
      }
      p.top = top; p.bottom = bottom;
    }
    return pages;
  }

  // question starts: "12." / "Q12." at the start of a line (or of a column)
  function findStarts(pages, total) {
    const cands = [];
    for (const p of pages) {
      const raw = [];
      for (const L of p.lines) {
        if (L.y < p.top || L.y > p.bottom + L.h) continue;
        L.items.forEach((it, k) => {
          // a number can come in pieces ("2", "7", "."): join the pieces that touch
          let tok = it.s, end = it.x + it.w;
          for (let j = k + 1; j < L.items.length && tok.length < 8 && L.items[j].x - end < 2.5; j++) { tok += L.items[j].s; end = L.items[j].x + L.items[j].w; }
          const m = QSTART.exec(tok); if (!m) return;
          const prev = L.items[k - 1];
          if (prev && prev.x + prev.w > it.x - 12) return; // text right before it on the same line: not a question number
          raw.push({ num: +m[1], page: p, line: L, x: it.x, y: L.y - it.h * 0.8 - 1 });
        });
      }
      const right = raw.filter(c => c.x > p.W * 0.45);
      p.split = right.length && raw.some(c => c.x < p.W * 0.3) ? Math.min(...right.map(c => c.x)) - 6 : 0;
      for (const c of raw) { c.col = p.split && c.x >= p.split ? 1 : 0; cands.push(c); }
    }
    cands.sort((a, b) => a.page.n - b.page.n || a.col - b.col || a.y - b.y);
    // the longest run 1, 2, 3 … in reading order; on a tie the later run wins (instructions are numbered too)
    let best = [];
    cands.forEach((c, i) => {
      if (c.num !== 1) return;
      const run = [c];
      for (let j = i + 1; j < cands.length && run.length < total; j++) if (cands[j].num === run.length + 1) run.push(cands[j]);
      if (run.length >= best.length) best = run;
    });
    return best;
  }

  // the stretch of page(s) a question occupies: from its number to the next question (or a section heading)
  function regions(pages, starts) {
    const flow = []; // reading order of columns
    for (const p of pages) { flow.push({ p, col: 0 }); if (p.split) flow.push({ p, col: 1 }); }
    const fi = (p, col) => flow.findIndex(f => f.p === p && f.col === col);
    const colX = (p, col) => (!p.split ? [Math.max(0, p.minX - 8), Math.min(p.W, p.maxX + 8)] : col === 0 ? [Math.max(0, p.minX - 8), p.split] : [p.split, Math.min(p.W, p.maxX + 8)]);
    return starts.map((s, k) => {
      const next = starts[k + 1], segs = [];
      let i = fi(s.page, s.col), y0 = s.y;
      const last = next ? fi(next.page, next.col) : Math.min(i + 1, flow.length - 1);
      for (; i <= last && segs.length < 4; i++) {
        const { p, col } = flow[i], [x0, x1] = colX(p, col);
        let y1 = next && next.page === p && next.col === col ? next.y : p.bottom;
        if (i > fi(s.page, s.col)) { // spill over to the next column / page only if it starts with plain text
          const first = p.lines.find(L => L.y > p.top + 2 && (!p.split || (col ? L.items[0].x >= p.split : L.items[0].x < p.split)));
          if (!first || isBreak(first) || (!next && STOP.test(first.text))) break;
        }
        const brk = p.lines.find(L => L.y > y0 + 4 && L.y < y1 && isBreak(L) && (!p.split || (col ? L.items[0].x >= p.split : L.items[0].x < p.split)));
        if (brk) y1 = brk.y - brk.h - 2;
        if (y1 > y0 + 4) segs.push({ p, x0, x1, y0, y1 });
        if (brk || (next && next.page === p && next.col === col)) break;
        y0 = (flow[i + 1] || {}).p ? flow[i + 1].p.top : 0;
      }
      return segs;
    });
  }

  // move each cut up from the question number to the nearest blank pixel row, so tall maths on the first
  // line stays with its question and nothing of the question before is cut off
  async function refine(starts, render) {
    for (const s of starts) {
      const p = s.page, cv = await render(p.n);
      const inCol = L => !p.split || (s.col ? L.items[0].x >= p.split - 2 : L.items[0].x < p.split);
      // never above the bottom of the text line before it (its descenders)
      // (a fraction or power on the question's own first line sits a little higher: that is not "the line before")
      // only lines that start near the left edge (question text, options) count, not pieces of a tall formula
      const prev = p.lines.filter(L => L.y < s.line.y - 4 && inCol(L) && (L.items[0].x < s.x + 45 || isBreak(L))).pop();
      const floorY = Math.max(prev ? prev.y : p.top, s.y - 30);
      const x0 = Math.floor((p.split && s.col ? p.split : Math.max(0, p.minX - 8)) * SCALE), x1 = Math.ceil((p.split && !s.col ? p.split : Math.min(p.W, p.maxX + 8)) * SCALE);
      const yb = Math.floor(s.y * SCALE), ya = Math.max(0, Math.floor(floorY * SCALE));
      if (yb - ya < 2) { s.y = Math.min(s.y, Math.max(floorY, s.y - 1)); continue; }
      const d = cv.getContext("2d", { willReadFrequently: true }).getImageData(x0, ya, x1 - x0, yb - ya).data, w = x1 - x0;
      const ink = r => { let n = 0; for (let x = 0; x < w; x++) { const i = (r * w + x) * 4; if (d[i] + d[i + 1] + d[i + 2] < 600) n++; } return n; };
      // cut in the widest blank gap (the space between the two questions); with no gap, at the faintest row
      let best = -1, bestLen = 0, run = 0, least = yb - ya - 1, leastInk = Infinity;
      for (let r = yb - ya - 1; r >= 0; r--) {
        const n = ink(r);
        if (n === 0) { run++; if (run > bestLen) { bestLen = run; best = r + Math.floor(run / 2); } } else { run = 0; if (n < leastInk) { leastInk = n; least = r; } }
      }
      s.y = (ya + (best >= 0 ? best : least)) / SCALE;
    }
  }
  // decorations repeated on most pages (a logo in the footer or header) are not text: they sit next to the repeated
  // footer / header text. Look a little beyond that text for pixel rows that look the same on most pages.
  async function graphicMargins(pages, render) {
    if (pages.length < 3) return;
    const WIN = 40 * SCALE, BINS = 64, rowsOf = async (p, from, dir) => {
      const cv = await render(p.n), w = cv.width, c = cv.getContext("2d", { willReadFrequently: true }), out = [];
      const y0 = Math.max(0, Math.min(cv.height - 1, Math.round(from * SCALE)));
      const ya = dir < 0 ? Math.max(0, y0 - WIN) : y0, n = dir < 0 ? y0 - ya : Math.min(WIN, cv.height - y0);
      if (n <= 0) return out;
      const d = c.getImageData(0, ya, w, n).data;
      for (let k = 0; k < n; k++) { const r = dir < 0 ? n - 1 - k : k; let bits = "";
        for (let b = 0; b < BINS; b++) { let on = 0; for (let x = Math.floor(b * w / BINS); x < Math.floor((b + 1) * w / BINS); x++) { const i = (r * w + x) * 4; if (d[i] + d[i + 1] + d[i + 2] < 690) { on = 1; break; } } bits += on; }
        out.push(bits); }
      return out;
    };
    const near = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && ++d > 2) return false; return true; };
    for (const [edge, dir] of [["bottom", -1], ["top", 1]]) {
      const sig = []; for (const p of pages) sig.push({ p, rows: await rowsOf(p, p[edge], dir) });
      const need = Math.max(2, Math.ceil(pages.length * 0.6)), n = Math.min(...sig.map(g => g.rows.length));
      let reach = -1;
      for (let k = 0; k < n; k++) {
        const vals = sig.map(g => g.rows[k]);
        const blank = vals.filter(v => !v.includes("1")).length >= need;
        // only sparse rows (a logo, a short line) count: a full line of text looks alike on every page
        const same = vals.some(v => v.includes("1") && v.split("1").length - 1 <= BINS * 0.4 && vals.filter(o => near(v, o)).length >= need);
        if (same) reach = k;
        else if (reach >= 0 || !blank || k > 10 * SCALE) break; // the decoration touches the header / footer text
      }
      if (reach >= 0) for (const g of sig) g.p[edge] += dir * (reach / SCALE + 4);
    }
  }

  // ------------------------------------------------------------------ cutting pictures
  function pageRenderer(pdf) {
    const cache = new Map();
    return n => {
      if (!cache.has(n)) cache.set(n, (async () => {
        const page = await pdf.getPage(n), vp = page.getViewport({ scale: SCALE });
        const cv = document.createElement("canvas"); cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
        const c = cv.getContext("2d", { willReadFrequently: true }); c.fillStyle = "#fff"; c.fillRect(0, 0, cv.width, cv.height);
        await page.render({ canvasContext: c, viewport: vp }).promise; page.cleanup(); return cv;
      })());
      return cache.get(n);
    };
  }
  // blank rows / columns: nearly all pixels white
  function inkRows(ctx, w, hgt) {
    const d = ctx.getImageData(0, 0, w, hgt).data, rows = new Uint8Array(hgt), cols = new Uint8Array(w);
    for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; if (d[i] + d[i + 1] + d[i + 2] < 600) { rows[y] = 1; cols[x] = 1; } }
    return { rows, cols };
  }
  async function cut(render, segs) {
    const parts = [];
    for (const s of segs) {
      const pc = await render(s.p.n);
      const sx = Math.floor(s.x0 * SCALE), sy = Math.floor(s.y0 * SCALE), sw = Math.ceil((s.x1 - s.x0) * SCALE), sh = Math.ceil((s.y1 - s.y0) * SCALE);
      if (sw < 10 || sh < 6) continue;
      const cv = document.createElement("canvas"); cv.width = sw; cv.height = sh;
      const c = cv.getContext("2d", { willReadFrequently: true }); c.drawImage(pc, sx, sy, sw, sh, 0, 0, sw, sh);
      const { rows } = inkRows(c, sw, sh);
      let a = 0, b = sh - 1; while (a < sh && !rows[a]) a++; while (b > a && !rows[b]) b--;
      if (a >= b) continue;
      parts.push({ cv, a: Math.max(0, a - 6), b: Math.min(sh - 1, b + 6), w: sw });
    }
    if (!parts.length) return null;
    // stack the pieces, closing big empty gaps
    const pieces = [];
    for (const p of parts) {
      const c = p.cv.getContext("2d", { willReadFrequently: true }), { rows } = inkRows(c, p.w, p.cv.height);
      let y = p.a, gap = 0, from = p.a;
      for (; y <= p.b; y++) {
        if (rows[y]) { if (gap > 36) { pieces.push([p, from, y - gap + 14]); from = y - 14; } gap = 0; } else gap++;
      }
      pieces.push([p, from, p.b]);
    }
    const W = Math.max(...parts.map(p => p.w)), H = pieces.reduce((s, [, a, b]) => s + (b - a + 1), 0);
    const out = document.createElement("canvas"); out.width = W; out.height = H;
    const oc = out.getContext("2d", { willReadFrequently: true }); oc.fillStyle = "#fff"; oc.fillRect(0, 0, W, H);
    let y = 0; for (const [p, a, b] of pieces) { oc.drawImage(p.cv, 0, a, p.w, b - a + 1, 0, y, p.w, b - a + 1); y += b - a + 1; }
    // trim white margins left and right
    const { cols } = inkRows(oc, W, H);
    let l = 0, r = W - 1; while (l < W && !cols[l]) l++; while (r > l && !cols[r]) r--;
    l = Math.max(0, l - 8); r = Math.min(W - 1, r + 8);
    const fin = document.createElement("canvas"); fin.width = r - l + 1; fin.height = H;
    fin.getContext("2d").drawImage(out, l, 0, fin.width, H, 0, 0, fin.width, H);
    return fin;
  }
  function toData(cv) {
    return new Promise(res => cv.toBlob(b => {
      const done = blob => { const r = new FileReader(); r.onload = () => res({ data: r.result, w: Math.round(cv.width / SCALE * 1.33), kb: Math.round(blob.size / 1024) }); r.readAsDataURL(blob); };
      if (b && b.type === "image/webp") done(b); else cv.toBlob(j => done(j), "image/jpeg", 0.85);
    }, "image/webp", 0.82));
  }

  // ------------------------------------------------------------------ answer key
  const VAL = /^(?:[-−]?\d+(?:\.\d+)?|[A-Da-d](?:\s*,?\s*[A-Da-d]){0,3}|\([A-Da-d1-4]\))$/;
  function readKey(pages) {
    const key = {};
    for (const p of pages) {
      p.lines.forEach((L, li) => {
        const lab = L.items.findIndex(it => /^(q\.?\s*no\.?|que\.?(\s*no\.?)?|q\.?)$/i.test(it.s));
        if (lab < 0) return;
        const nums = L.items.slice(lab + 1).filter(it => /^\d{1,3}$/.test(it.s));
        if (nums.length < 2) return;
        // the answers: the next line(s) below whose values sit under the question numbers
        for (const M of p.lines.slice(li + 1, li + 4)) {
          if (M.y - L.y > 45) break;
          const vals = M.items.filter(it => VAL.test(it.s));
          if (!vals.length) continue;
          let hit = 0;
          for (const nIt of nums) {
            const cx = nIt.x + nIt.w / 2;
            const v = vals.reduce((b, it) => { const d = Math.abs(it.x + it.w / 2 - cx); return !b || d < b.d ? { it, d } : b; }, null);
            if (v && v.d < 22) { key[+nIt.s] = v.it.s; hit++; }
          }
          if (hit) break;
        }
      });
    }
    // fallback: "12. (3)" / "12 - B" style lists
    if (Object.keys(key).length < 3) {
      const text = pages.map(p => p.lines.map(L => L.text).join("\n")).join("\n");
      const re = /(?:^|\s)(\d{1,3})\s*[.):\-]\s*\(?([A-Da-d](?:\s*,\s*[A-Da-d]){0,3}|[-−]?\d+(?:\.\d+)?)\)?(?=\s|$)/g;
      let m; while ((m = re.exec(text))) if (!key[+m[1]]) key[+m[1]] = m[2];
    }
    return key;
  }
  // answers in the form the portal's answer key uses for this sheet
  function normAnswer(v, sec) {
    if (v == null || v === "") return "";
    let s = String(v).trim().replace(/[()\s]/g, "").replace(/−/g, "-").toUpperCase();
    if (sec.qtype === "single" || sec.qtype === "multi") {
      const parts = s.split(/,|/).filter(Boolean);
      let letters = parts.map(c => (/[1-4]/.test(c) ? "ABCD"[+c - 1] : c)).filter(c => /[A-D]/.test(c));
      letters = [...new Set(letters)].sort();
      if (!letters.length) return "";
      if (sec.qtype === "single") letters = letters.slice(0, 1);
      return sec.options === "1234" ? letters.map(c => "ABCD".indexOf(c) + 1).join("") : letters.join("");
    }
    return /^-?\d*\.?\d+$/.test(s) ? s : "";
  }

  // ------------------------------------------------------------------ the page
  function page(view, t, layout, back) {
    const idx = O.questionIndex(layout), N = idx.length;
    const qp = h("input", { type: "file", accept: "application/pdf", id: "imp-qp" });
    const kp = h("input", { type: "file", accept: "application/pdf", id: "imp-key" });
    const status = h("p", { class: "small muted", style: "margin:0" });
    const go = h("button", { class: "btn gold", type: "button" }, "Read the papers");
    const out = h("div", { style: "display:grid;gap:16px" });
    go.onclick = async () => {
      if (!qp.files[0] && !kp.files[0]) { toast("Choose the question paper PDF, the answer key PDF, or both."); return; }
      go.disabled = true; out.replaceChildren();
      try { await run(); } catch (e) { status.textContent = ""; toast(e.message || String(e)); }
      go.disabled = false;
    };
    async function run() {
      const items = idx.map(({ qno, sec }) => ({ qno, sec, img: null, sol: null, answer: "" }));
      let qFound = 0, sFound = 0, kFound = 0;
      if (qp.files[0]) {
        status.textContent = "Reading the question paper…";
        const pdf = await openPdf(qp.files[0]), pages = await readText(pdf);
        const starts = findStarts(pages, N); qFound = starts.length;
        const render = pageRenderer(pdf); await graphicMargins(pages, render); await refine(starts, render);
        const segs = regions(pages, starts);
        for (let k = 0; k < starts.length && k < N; k++) {
          status.textContent = `Cutting question ${k + 1} of ${starts.length}…`;
          const cv = await cut(render, segs[k]); if (cv) items[k].img = await toData(cv);
        }
      }
      if (kp.files[0]) {
        status.textContent = "Reading the answer key…";
        const pdf = await openPdf(kp.files[0]), pages = await readText(pdf);
        const key = readKey(pages);
        for (const it of items) { const a = normAnswer(key[it.qno], it.sec); if (a) { it.answer = a; kFound++; } }
        const starts = findStarts(pages, N);
        if (starts.length >= Math.min(5, N)) {
          const render = pageRenderer(pdf); await graphicMargins(pages, render); await refine(starts, render);
          const segs = regions(pages, starts);
          for (let k = 0; k < starts.length && k < N; k++) {
            status.textContent = `Cutting solution ${k + 1} of ${starts.length}…`;
            const cv = await cut(render, segs[k]); if (cv) { items[k].sol = await toData(cv); sFound++; }
          }
        }
      }
      status.textContent = "";
      preview(items, { qFound, sFound, kFound });
    }

    function picInput(onPick) {
      const f = h("input", { type: "file", accept: "image/*", hidden: true, onchange: async () => {
        const file = f.files[0]; if (!file) return;
        const img = new Image(); img.src = URL.createObjectURL(file); await img.decode();
        const scale = Math.min(1, 1400 / img.naturalWidth), cv = document.createElement("canvas");
        cv.width = Math.round(img.naturalWidth * scale); cv.height = Math.round(img.naturalHeight * scale);
        const c = cv.getContext("2d"); c.fillStyle = "#fff"; c.fillRect(0, 0, cv.width, cv.height); c.drawImage(img, 0, 0, cv.width, cv.height);
        onPick(await toData(cv)); f.value = "";
      } });
      return f;
    }

    function preview(items, stats) {
      const label = h("input", { id: "imp-label", value: t.code, maxlength: 60 });
      const inBank = h("input", { type: "checkbox", id: "imp-bank", checked: true });
      const missingQ = items.filter(i => !i.img).length, missingA = items.filter(i => !i.answer).length;
      const rows = items.map(it => {
        const ans = h("input", { class: "mono", value: it.answer, maxlength: 12, "aria-label": `Answer for question ${it.qno}`, style: "max-width:110px" });
        ans.oninput = () => { it.answer = normAnswer(ans.value, it.sec) || ans.value.trim().toUpperCase(); row.classList.toggle("imp-warn", !it.img || !ans.value.trim()); };
        const pic = h("div", { class: "imp-pic" }), solBox = h("div", { class: "imp-pic" });
        const drawPic = () => show(pic, it.img ? h("img", { src: it.img.data, alt: `Question ${it.qno}`, style: `width:${it.img.w}px` }) : h("p", { class: "err small" }, "Question not found in the PDF. Add a picture of it with Replace picture."));
        const drawSol = () => show(solBox, it.sol ? h("img", { src: it.sol.data, alt: `Solution ${it.qno}`, style: `width:${it.sol.w}px` }) : h("p", { class: "small muted" }, "No solution."));
        const qIn = picInput(d => { it.img = d; drawPic(); ans.oninput(); }), sIn = picInput(d => { it.sol = d; drawSol(); });
        drawPic(); drawSol();
        const row = h("div", { class: "imp-row" + (!it.img || !it.answer ? " imp-warn" : "") },
          h("div", { class: "imp-head" }, h("b", {}, `Q${it.qno}`), h("span", { class: "small muted" }, `${cap(it.sec.subject)} · ${it.sec.name}`),
            h("span", { style: "flex:1" }), h("label", { class: "small" }, "Answer ", ans)),
          pic,
          h("details", {}, h("summary", { class: "small" }, it.sol ? "Solution" : "Solution (none)"), solBox),
          h("div", { class: "row" }, qIn, sIn,
            h("button", { class: "link small", type: "button", onclick: () => qIn.click() }, "Replace picture"),
            h("button", { class: "link small", type: "button", onclick: () => sIn.click() }, it.sol ? "Replace solution" : "Add solution picture"),
            it.img ? h("button", { class: "link small", type: "button", onclick: () => { it.img = null; drawPic(); ans.oninput(); } }, "Remove picture") : null));
        return row;
      });
      const saves = [0, 1].map(() => h("button", { class: "btn gold", type: "button", onclick: () => doSave() }, "Save to the test"));
      const doSave = async () => {
        const send = items.filter(i => i.img || i.answer);
        if (!send.length) { toast("Nothing to save."); return; }
        saves.forEach(b => { b.disabled = true; b.textContent = "Saving…"; });
        try {
          const r = await POST(`/api/tests/${t.id}/import`, { label: label.value.trim(), bank: inBank.checked,
            items: send.map(i => ({ qno: i.qno, img: i.img && i.img.data, w: i.img && i.img.w, sol: i.sol && i.sol.data, sw: i.sol && i.sol.w, answer: i.answer })) });
          toast(`Saved ${r.questions} questions and ${r.answers} answers`);
          location.hash = `#/tests/${t.id}/questions`;
        } catch (e) { toast(e.message); saves.forEach(b => { b.disabled = false; b.textContent = "Save to the test"; }); }
      };
      show(out,
        h("div", { class: "card" }, h("h2", {}, "Check before saving"),
          h("div", { class: "stats" },
            h("div", { class: "stat " + (missingQ ? "warn" : "ok") }, h("b", {}, `${N - missingQ} / ${N}`), h("span", {}, "Questions cut out")),
            h("div", { class: "stat " + (missingA ? "warn" : "ok") }, h("b", {}, `${N - missingA} / ${N}`), h("span", {}, "Answers read")),
            h("div", { class: "stat" }, h("b", {}, `${items.filter(i => i.sol).length}`), h("span", {}, "Solutions cut out"))),
          h("p", { class: "small", style: "margin:0" }, "Look through each question below. Rows with a problem are marked in orange. You can type a missing answer, or replace a picture with a screenshot."),
          h("div", { class: "row" }, h("label", { class: "f" }, "Source name (shown on each question)", label),
            h("label", { class: "imp-check" }, inBank, h("span", {}, "Also show these questions in the question bank"))),
          h("div", { class: "row" }, saves[0])),
        h("div", { class: "card imp-list" }, rows),
        h("div", { class: "row" }, saves[1]));
    }

    show(view, h("div", { class: "head" }, h("div", {}, back, h("h1", {}, "Import a paper"), h("p", { class: "sub" }, `${t.code} · ${t.name} · ${layout.title} · ${N} questions`))),
      h("div", { class: "card" },
        h("p", { style: "margin:0" }, "Use the question paper and answer key PDFs made in Word (or any PDF with text, not a scan). Each question is cut out as a picture exactly as printed, the answer key is read, and solutions in the key PDF are cut out too. Nothing is saved until you check and press Save."),
        h("div", { class: "row" }, h("label", { class: "f" }, "Question paper (PDF)", qp), h("label", { class: "f" }, "Answer key / solutions (PDF, optional)", kp)),
        h("div", { class: "row" }, go, status)),
      out);
  }

  window.TPImport = { page, _test: { readText, findStarts, regions, readKey, normAnswer } };
})();
