/* OMR core: sheet layouts, geometry, reader and scorer. Works in the browser and in Node. */
(function (root) {
  "use strict";

  // ---------------------------------------------------------------- page constants (mm)
  const PAGE_W = 210, PAGE_H = 297, MARKER_SIZE = 7;
  const MARKERS = { tl: [12, 12], tr: [198, 12], bl: [12, 285], br: [198, 285] };
  const BODY_X0 = 17, BODY_X1 = 193, BODY_Y1 = 280, BODY_Y0 = 75;
  const MCQ_BUBBLE_PITCH = 5.6, MCQ_BUBBLE_R = 1.9, MCQ_QNUM_W = 9.0;
  const NUM_PITCH_X = 3.8, NUM_BUBBLE_R = 1.55, NUM_TITLE_H = 3.6, NUM_BOX_H = 4.6;
  const SECTION_HEAD_H = 5.0, SECTION_GAP = 1.0;
  const ROLL_DIGITS = 8, ROLL_X0 = 104, ROLL_Y0 = 35, ROLL_PITCH_X = 4.7, ROLL_PITCH_Y = 3.55, ROLL_R = 1.5;
  const QR_BOX = [161, 27, 28];
  const NUMERIC_COLUMNS = { integer: ["-", "d", "d", "d", "d"], decimal: ["-", "d", "d", "d", ".", "d", "d"] };
  const DEFAULT_MARKS = {
    single: { correct: 4, wrong: -1 }, multi: { correct: 4, wrong: -2, partial: true },
    integer: { correct: 4, wrong: 0 }, decimal: { correct: 4, wrong: 0 },
  };
  const TYPE_SHORT = { single: "Single correct", multi: "One or more", integer: "Integer", decimal: "Decimal" };
  const TYPE_LONG = { single: "single correct", multi: "one or more correct", integer: "numerical, integer", decimal: "numerical, 2 decimals" };

  function section(name, subject, qtype, count, marks, options) {
    return {
      name, subject, qtype, count, options: options || "ABCD",
      marks: marks || Object.assign({}, DEFAULT_MARKS[qtype]),
      columns: NUMERIC_COLUMNS[qtype] ? NUMERIC_COLUMNS[qtype].slice() : null,
    };
  }
  function jeeMainSubject(s) {
    return [section(`${s} - Section A (single correct)`, s, "single", 20, { correct: 4, wrong: -1 }),
            section(`${s} - Section B (numerical, integer)`, s, "integer", 5, { correct: 4, wrong: -1 })];
  }
  function advSubject(s) {
    return [section(`${s} - Sec 1 (single correct)`, s, "single", 4, { correct: 3, wrong: -1 }),
            section(`${s} - Sec 2 (one or more correct)`, s, "multi", 3, { correct: 4, wrong: -2, partial: true }),
            section(`${s} - Sec 3 (numerical, 2 decimals)`, s, "decimal", 6, { correct: 4, wrong: 0 }),
            section(`${s} - Sec 4 (matching, single correct)`, s, "single", 4, { correct: 3, wrong: -1 })];
  }
  const PCM = ["PHYSICS", "CHEMISTRY", "MATHEMATICS"];
  const PRESETS = {
    JM: { id: "JM", title: "JEE MAIN - FULL TEST", sections: PCM.flatMap(jeeMainSubject) },
    JMP: { id: "JMP", title: "JEE MAIN - PHYSICS TEST", sections: jeeMainSubject("PHYSICS") },
    NEET: { id: "NEET", title: "NEET - FULL TEST", sections: ["PHYSICS", "CHEMISTRY", "BOTANY", "ZOOLOGY"].map(s => section(s, s, "single", 45)) },
    NEETP: { id: "NEETP", title: "NEET - PHYSICS TEST", sections: [section("PHYSICS", "PHYSICS", "single", 45)] },
    JA: { id: "JA", title: "JEE ADVANCED - FULL PAPER", sections: PCM.flatMap(advSubject) },
    JAP: { id: "JAP", title: "JEE ADVANCED - PHYSICS TEST", sections: advSubject("PHYSICS") },
    R180: { id: "R180", title: "EAPCET", classic: "R180", rollDigits: 7, options: "1234",
            sections: [Object.assign(section("EAPCET - 180 questions", "EAPCET", "single", 180, { correct: 1, wrong: 0 }), { options: "1234" })] },
    RJM: { id: "RJM", title: "JEE MAIN", classic: "RJM", rollDigits: 7,
           sections: PCM.flatMap(jeeMainSubject) },
    DR30: { id: "DR30", title: "FORMULA DRILL", sections: [section("Formula drill (single correct)", "PHYSICS", "single", 30, { correct: 1, wrong: 0 })] },
  };

  // ---------------------------------------------------------------- geometry
  const shortLabel = s => `${s.subject.slice(0, 4)} · ${TYPE_SHORT[s.qtype]}`;

  function numericBlockSize(pattern, py) {
    const ncols = pattern.filter(c => c !== ".").length, ndots = pattern.filter(c => c === ".").length;
    return [ncols * NUM_PITCH_X + ndots * 1.6 + 2.2, NUM_TITLE_H + NUM_BOX_H + 10 * py + 1.5];
  }
  function numericField(qno, qtype, si, pattern, x0, y0, py) {
    const [w, h] = numericBlockSize(pattern, py);
    const cols = []; let cx = x0 + 1.1 + NUM_PITCH_X / 2;
    const top = y0 + NUM_TITLE_H + NUM_BOX_H + py / 2 + 0.3;
    const r = Math.min(NUM_BUBBLE_R, py / 2 - 0.3);
    for (const c of pattern) {
      if (c === ".") { cx += 1.6; continue; }
      if (c === "-") cols.push([{ x: cx, y: top, r, v: "-" }]);
      else { const col = []; for (let d = 0; d < 10; d++) col.push({ x: cx, y: top + d * py, r, v: String(d) }); cols.push(col); }
      cx += NUM_PITCH_X;
    }
    return { kind: "q", qno, qtype, section: si, columns: cols, pattern, box: [x0, y0, w, h] };
  }
  function mcqField(qno, qtype, si, options, x0, y, colW, rowPitch) {
    const pitch = Math.min(MCQ_BUBBLE_PITCH, (colW - MCQ_QNUM_W - 1.0) / options.length);
    const r = Math.min(MCQ_BUBBLE_R, pitch / 2 - 0.6, rowPitch / 2 - 0.55);
    const bx0 = x0 + MCQ_QNUM_W + r;
    return { kind: "q", qno, qtype, section: si, columns: [[...options].map((o, i) => ({ x: bx0 + i * pitch, y, r, v: o }))],
             label: [x0 + MCQ_QNUM_W - 1.3, y] };
  }
  function rollField() {
    const cols = [];
    for (let c = 0; c < ROLL_DIGITS; c++) {
      const col = []; for (let d = 0; d < 10; d++) col.push({ x: ROLL_X0 + c * ROLL_PITCH_X, y: ROLL_Y0 + d * ROLL_PITCH_Y, r: ROLL_R, v: String(d) });
      cols.push(col);
    }
    return { kind: "roll", qno: 0, qtype: "roll", section: -1, columns: cols };
  }
  function flow(layout, ncols, rowPitch, numPy) {
    const bodyW = BODY_X1 - BODY_X0, gap = 1.6, colW = (bodyW - gap * (ncols - 1)) / ncols;
    for (const s of layout.sections) {
      if ((s.qtype === "single" || s.qtype === "multi") && (colW - MCQ_QNUM_W - 1.0) / s.options.length < 4.3) return null;
      if (s.columns && numericBlockSize(s.columns, numPy)[0] > colW) return null;
    }
    const fields = [], headers = [];
    let c = 0, y = BODY_Y0, qno = 1;
    const colX = ci => BODY_X0 + ci * (colW + gap);
    const nextCol = () => { c += 1; y = BODY_Y0; return c < ncols; };
    for (let si = 0; si < layout.sections.length; si++) {
      const sec = layout.sections[si];
      const isMcq = sec.qtype === "single" || sec.qtype === "multi";
      const itemH = isMcq ? rowPitch : numericBlockSize(sec.columns, numPy)[1] + 1.2;
      let needHeader = true;
      for (let k = 0; k < sec.count; k++) {
        if (needHeader) {
          if (y + SECTION_HEAD_H + itemH > BODY_Y1 && !nextCol()) return null;
          headers.push([colX(c), y, colW, shortLabel(sec) + (k === 0 ? "" : " (contd.)")]);
          y += SECTION_HEAD_H; needHeader = false;
        }
        if (y + itemH > BODY_Y1) {
          if (!nextCol()) return null;
          headers.push([colX(c), y, colW, shortLabel(sec) + " (contd.)"]);
          y += SECTION_HEAD_H;
        }
        if (isMcq) fields.push(mcqField(qno, sec.qtype, si, sec.options, colX(c), y + rowPitch / 2, colW, rowPitch));
        else {
          const [w] = numericBlockSize(sec.columns, numPy);
          fields.push(numericField(qno, sec.qtype, si, sec.columns, colX(c) + (colW - w) / 2, y + 0.4, numPy));
        }
        y += itemH; qno += 1;
      }
      y += SECTION_GAP;
    }
    return { fields, headers };
  }
  // ---------------------------------------------------------------- fixed "classic" sheets
  // Classic coaching-style OMR: 7-digit student ID + 4-digit test ID grids (rows 1..9,0),
  // option numbers inside bubbles or A B C D headers, 4-digit numerical grids.
  const DIGITS_1TO0 = "1234567890";
  function digitGrid(kind, x0, y0, cols, px, py, r) {
    const columns = [];
    for (let c = 0; c < cols; c++) columns.push([...DIGITS_1TO0].map((v, j) => ({ x: x0 + c * px, y: y0 + j * py, r, v })));
    return { kind, qno: 0, qtype: kind, section: -1, columns };
  }
  const CLASSIC = {
    idX: 26, idY: 45.5, idPX: 5.0, idPY: 3.85, idR: 1.5, tidX: 70,
  };
  function classicIds() {
    const c = CLASSIC;
    return [digitGrid("roll", c.idX, c.idY, 7, c.idPX, c.idPY, c.idR), digitGrid("testid", c.tidX, c.idY, 4, c.idPX, c.idPY, c.idR)];
  }
  function buildR180(layout) {
    const fields = classicIds(), boxes = [];
    const x0 = BODY_X0, gap = 2.4, colW = (176 - gap * 4) / 5, top = 88, pitch = 4.8, r = 1.75, bp = 5.5;
    for (let c = 0; c < 5; c++) {
      const cx = x0 + c * (colW + gap), n = c < 4 ? 40 : 20;
      boxes.push([cx, top - 3.5, colW, 40 * pitch + 4.5]);
      for (let j = 0; j < n; j++) {
        const q = c * 40 + j + 1, y = top + j * pitch + pitch / 2;
        const bx0 = cx + 9.6 + r;
        fields.push({ kind: "q", qno: q, qtype: "single", section: 0, label: [cx + 8.4, y],
          columns: [["1", "2", "3", "4"].map((v, i) => ({ x: bx0 + i * bp, y, r, v }))] });
      }
    }
    return { fields, headers: [], boxes, style: "R180" };
  }
  function buildRJM(layout) {
    const fields = classicIds(), boxes = [], labels = [];
    const gap = 2.4, colW = (176 - gap * 2) / 3, top = 88.5;
    const subjects = layout.sections.filter(s => s.qtype === "single").map(s => s.subject);
    for (let s = 0; s < 3; s++) {
      const cx = BODY_X0 + s * (colW + gap), q0 = s * 25;
      boxes.push([cx, top - 2.5, colW, 192.5]);
      labels.push([cx + colW / 2, top + 1.2, subjects[s] || ""]);
      // MCQ: two sub-columns of 10, A B C D header
      const r = 1.7, bp = 5.0, rp = 4.55, mt = top + 7.5;
      for (let h = 0; h < 2; h++) {
        const hx = cx + 1.5 + h * (colW / 2);
        labels.push(["ABCD", hx + 8 + r, mt - 3.0, bp]);
        for (let j = 0; j < 10; j++) {
          const q = q0 + h * 10 + j + 1, y = mt + j * rp + rp / 2;
          fields.push({ kind: "q", qno: q, qtype: "single", section: s * 2, label: [hx + 6.8, y],
            columns: [["A", "B", "C", "D"].map((v, i) => ({ x: hx + 8 + r + i * bp, y, r, v, hide: true }))] });
        }
      }
      // numerical: 5 grids of 4 digit-columns, rows 1..9,0
      const px = 4.15, py = 3.75, nr = 1.5, gy0 = mt + 10 * rp + 5;
      for (let k = 0; k < 5; k++) {
        const gx = cx + 3 + (k % 2) * (colW / 2), gy = gy0 + Math.floor(k / 2) * 45.5;
        const q = q0 + 21 + k;
        const g = digitGrid("q", gx + nr, gy + 4.6, 4, px, py, nr);
        fields.push({ kind: "q", qno: q, qtype: "integer", section: s * 2 + 1, columns: g.columns,
          pattern: ["d", "d", "d", "d"], label: [gx, gy + 1.8], box: [gx - 1.2, gy - 0.6, 4 * px + 1.2, 10 * py + 5.6] });
      }
    }
    return { fields, headers: [], boxes, labels, style: "RJM" };
  }

  const _geomCache = new Map();
  function buildGeometry(layout) {
    if (layout.classic) {
      if (!_geomCache.has(layout.id)) _geomCache.set(layout.id, layout.classic === "R180" ? buildR180(layout) : buildRJM(layout));
      return _geomCache.get(layout.id);
    }
    const key = JSON.stringify(layout.sections) + "|" + (layout.mcqCols || 0);
    if (_geomCache.has(key)) return _geomCache.get(key);
    const tries = [];
    for (const [rp, py] of [[5.0, 3.7], [4.8, 3.6], [4.6, 3.5], [4.4, 3.4], [4.2, 3.3]])
      for (const nc of (layout.mcqCols ? [layout.mcqCols] : [6, 5, 7])) tries.push([nc, rp, py]);
    for (const [nc, rp, py] of tries) {
      const res = flow(layout, nc, rp, py);
      if (res) { res.fields.unshift(rollField()); _geomCache.set(key, res); return res; }
    }
    throw new Error(`"${layout.title}" has too many questions for one OMR page (${totalQ(layout)} questions).`);
  }
  const totalQ = layout => layout.sections.reduce((a, s) => a + s.count, 0);
  function questionIndex(layout) {
    const out = []; let q = 1;
    layout.sections.forEach((s, si) => { for (let i = 0; i < s.count; i++) out.push({ qno: q++, si, sec: s }); });
    return out;
  }
  // custom patterns travel inside the QR code, so any sheet can be read back later without saved settings
  const TCODE = { single: "S", multi: "M", integer: "I", decimal: "D" };
  const TDECODE = { S: "single", M: "multi", I: "integer", D: "decimal" };
  function customCode(sections) {
    return "C~" + sections.map(s => [s.subject.replace(/[^A-Z0-9 ]/gi, "").toUpperCase().slice(0, 14) || "GENERAL",
      TCODE[s.qtype], s.count, s.marks.correct, s.marks.wrong].join("*")).join(",");
  }
  function customLayout(sections, title) {
    const secs = sections.map(s => section(`${s.subject} - ${TYPE_LONG[s.qtype]}`, s.subject, s.qtype, s.count,
      Object.assign({ correct: s.correct, wrong: s.wrong }, s.qtype === "multi" ? { partial: true } : {})));
    return { id: customCode(secs), title: title || "OMR ANSWER SHEET", sections: secs };
  }
  function getLayout(id) {
    if (PRESETS[id]) return PRESETS[id];
    if (!id || !id.startsWith("C~")) return null;
    try {
      const secs = id.slice(2).split(",").map(p => {
        const [subject, t, n, c, w] = p.split("*");
        if (!TDECODE[t] || !(+n > 0)) throw new Error("bad");
        return { subject, qtype: TDECODE[t], count: +n, correct: +c, wrong: +w };
      });
      return customLayout(secs, "CUSTOM TEST");
    } catch (e) { return null; }
  }
  const qrPayload = (lid, test, roll, paper) => `OMR1|${lid}|${test}|1/1|${roll || ""}|${paper || ""}`;
  function parseQr(t) {
    if (!t) return null;
    const p = t.split("|");
    if (p.length !== 6 || p[0] !== "OMR1") return null;
    return { layout: p[1], test: p[2], roll: p[4], paper: p[5] };
  }

  // ---------------------------------------------------------------- image helpers
  // gray = {w, h, d: Uint8Array}
  function otsu(d) {
    const hist = new Float64Array(256);
    for (let i = 0; i < d.length; i++) hist[d[i]]++;
    let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, th = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (!wB) continue;
      const wF = d.length - wB; if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
      if (v > best) { best = v; th = t; }
    }
    return th;
  }
  function downscale(g, f) {
    const w = Math.floor(g.w / f), h = Math.floor(g.h / f), d = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0;
      for (let yy = 0; yy < f; yy++) { const row = (y * f + yy) * g.w + x * f; for (let xx = 0; xx < f; xx++) s += g.d[row + xx]; }
      d[y * w + x] = s / (f * f);
    }
    return { w, h, d };
  }

  function findMarkers(g) {
    const f = Math.max(1, Math.round(Math.min(g.w, g.h) / 700));    // work at ~700 px wide
    const s = downscale(g, f);
    const { w, h, d } = s;
    const th = otsu(d);
    const pxmm = Math.min(w, h) / PAGE_W, side = MARKER_SIZE * pxmm;
    const lab = new Int32Array(w * h), stack = new Int32Array(w * h);
    const cands = [];
    let next = 1;
    for (let i = 0; i < w * h; i++) {
      if (d[i] > th || lab[i]) continue;
      let sp = 0; stack[sp++] = i; lab[i] = next;
      let n = 0, minx = w, maxx = 0, miny = h, maxy = 0, sx = 0, sy = 0;
      while (sp) {
        const p = stack[--sp], px = p % w, py = (p - px) / w;
        n++; sx += px; sy += py;
        if (px < minx) minx = px; if (px > maxx) maxx = px; if (py < miny) miny = py; if (py > maxy) maxy = py;
        if (n > side * side * 4) { /* too big, keep labelling but will be rejected */ }
        const nb = [p - 1, p + 1, p - w, p + w];
        if (px === 0) nb[0] = -1; if (px === w - 1) nb[1] = -1;
        for (const q of nb) if (q >= 0 && q < w * h && !lab[q] && d[q] <= th) { lab[q] = next; stack[sp++] = q; }
      }
      next++;
      const bw = maxx - minx + 1, bh = maxy - miny + 1;
      if (minx <= 1 || miny <= 1 || maxx >= w - 2 || maxy >= h - 2) continue;
      if (!(bw > 0.55 * side && bw < 1.6 * side && bh > 0.55 * side && bh < 1.6 * side)) continue;
      if (bw / bh < 0.7 || bw / bh > 1.43) continue;
      if (n / (bw * bh) < 0.78) continue;
      cands.push([(sx / n + 0.5) * f - 0.5, (sy / n + 0.5) * f - 0.5]);
    }
    const W = g.w, H = g.h;
    const corners = { tl: [0, 0], tr: [W, 0], bl: [0, H], br: [W, H] };
    const pts = {};
    for (const k in corners) {
      const [cx, cy] = corners[k];
      const near = cands.filter(p => Math.abs(p[0] - cx) < 0.3 * W && Math.abs(p[1] - cy) < 0.3 * H);
      if (near.length) pts[k] = near.reduce((a, b) => ((a[0] - cx) ** 2 + (a[1] - cy) ** 2 <= (b[0] - cx) ** 2 + (b[1] - cy) ** 2 ? a : b));
    }
    const found = Object.keys(pts).length;
    if (found < 4) return { error: found === 3 ? "a black corner square is cut off in the scan - re-scan this sheet straight"
                                               : "could not find the 4 black corner squares (sheet cut off, folded or not an OMR page?)" };
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const top = dist(pts.tr, pts.tl), left = dist(pts.bl, pts.tl);
    const expect = (MARKERS.bl[1] - MARKERS.tl[1]) / (MARKERS.tr[0] - MARKERS.tl[0]);
    const ratio = top ? left / top : 0;
    if (!((ratio > 0.85 * expect && ratio < 1.15 * expect) || (ratio > 0.85 / expect && ratio < 1.15 / expect)))
      return { error: "corner squares found but the page shape looks wrong - re-scan" };
    // refine each centre at full resolution
    for (const k of ["tl", "tr", "bl", "br"]) pts[k] = refineCentre(g, pts[k], side * f, th);
    return { pts, landscape: top > left };
  }
  function refineCentre(g, p, side, th) {
    const r = Math.round(side * 0.9), x0 = Math.max(0, Math.round(p[0] - r)), y0 = Math.max(0, Math.round(p[1] - r));
    const x1 = Math.min(g.w - 1, Math.round(p[0] + r)), y1 = Math.min(g.h - 1, Math.round(p[1] + r));
    let n = 0, sx = 0, sy = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (g.d[y * g.w + x] <= th) { n++; sx += x; sy += y; }
    return n ? [sx / n, sy / n] : p;
  }

  // homography mapping page mm -> image px
  function solveHomography(src, dst) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i], [u, v] = dst[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    for (let c = 0; c < 8; c++) {
      let piv = c; for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      [A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]];
      for (let r = 0; r < 8; r++) if (r !== c) {
        const f = A[r][c] / A[c][c];
        for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
        b[r] -= f * b[c];
      }
    }
    const h = b.map((v, i) => v / A[i][i]);
    return (x, y) => { const z = h[6] * x + h[7] * y + 1; return [(h[0] * x + h[1] * y + h[2]) / z, (h[3] * x + h[4] * y + h[5]) / z]; };
  }
  function makeMapper(pts, flip, landscape) {
    let order = ["tl", "tr", "bl", "br"];
    if (landscape) order = ["tr", "br", "tl", "bl"];
    if (flip) order = [order[3], order[2], order[1], order[0]];
    const src = [MARKERS.tl, MARKERS.tr, MARKERS.bl, MARKERS.br];
    return solveHomography(src, order.map(k => pts[k]));
  }
  function sample(g, x, y) {
    if (x < 0 || y < 0 || x >= g.w - 1 || y >= g.h - 1) return 255;
    const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * g.w + x0, d = g.d;
    return (d[i] * (1 - fx) + d[i + 1] * fx) * (1 - fy) + (d[i + g.w] * (1 - fx) + d[i + g.w + 1] * fx) * fy;
  }
  // render a page region (mm) to RGBA for jsQR
  function renderRegion(g, map, x, y, wmm, hmm, ppm) {
    const W = Math.round(wmm * ppm), H = Math.round(hmm * ppm), out = new Uint8ClampedArray(W * H * 4);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const [u, v] = map(x + i / ppm, y + j / ppm), val = sample(g, u, v), o = (j * W + i) * 4;
      out[o] = out[o + 1] = out[o + 2] = val; out[o + 3] = 255;
    }
    return { data: out, width: W, height: H };
  }
  function decodeQr(g, map, jsQR) {
    const [x, y, s] = QR_BOX, m = 6;
    for (const ppm of [6, 9]) {
      const r = renderRegion(g, map, x - m, y - m, s + 2 * m, s + 2 * m, ppm);
      const res = jsQR(r.data, r.width, r.height, { inversionAttempts: "dontInvert" });
      const info = res && parseQr(res.data);
      if (info) return info;
    }
    return null;
  }
  function regionStd(g, map, x, y, wmm, hmm) {
    let n = 0, s = 0, s2 = 0;
    for (let j = 0; j < hmm; j += 0.5) for (let i = 0; i < wmm; i += 0.5) {
      const [u, v] = map(x + i, y + j), val = sample(g, u, v); n++; s += val; s2 += val * val;
    }
    return Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2));
  }

  const FILLED = 0.50, EMPTY = 0.22;
  function darkness(g, map, b, white) {
    const r = b.r * 0.62, step = r / 5;
    let n = 0, s = 0;
    for (let dy = -r; dy <= r + 1e-9; dy += step) for (let dx = -r; dx <= r + 1e-9; dx += step) {
      if (dx * dx + dy * dy > r * r) continue;
      const [u, v] = map(b.x + dx, b.y + dy); s += sample(g, u, v); n++;
    }
    return Math.max(0, 1 - s / n / white);
  }
  // Each sheet calibrates itself: the typical darkness of its own empty bubbles (printed outline and
  // label) is the baseline, and a mark is judged by how far above that baseline it is.
  const ON_REL = 0.40, OFF_REL = 0.18;
  const classify = (d, base = 0) => {
    const x = (d - base) / Math.max(0.2, 1 - base);
    return x >= ON_REL ? "on" : x <= OFF_REL ? "off" : "doubt";
  };
  const groupOf = f => (f.kind !== "q" ? f.kind : f.qtype === "single" || f.qtype === "multi" ? "mcq" : "num");

  // ---------------------------------------------------------------- read one page
  // layouts: function(id) -> layout or null.  jsQR: decoder function.
  function readPage(g, opts) {
    const { jsQR, getLayout, fallbackLayout } = opts;
    const res = { ok: false, error: "", layout: "", test: "", roll: "", paper: "", bubbleRoll: "", answers: {}, issues: [], marks: [] };
    const mk = findMarkers(g);
    if (mk.error) { res.error = mk.error; return res; }
    let map = makeMapper(mk.pts, false, mk.landscape);
    let info = decodeQr(g, map, jsQR);
    if (!info) {
      const flipped = makeMapper(mk.pts, true, mk.landscape);
      info = decodeQr(g, flipped, jsQR);
      if (info) map = flipped;
      else {
        const [x, y, s] = QR_BOX;
        if (regionStd(g, flipped, x, y, s, s) > 1.3 * regionStd(g, map, x, y, s, s)) map = flipped;
      }
    }
    res.map = map;
    // check alignment: corner squares must be dark where expected
    for (const k in MARKERS) {
      const [mx, my] = MARKERS[k];
      let s = 0, n = 0;
      for (let dy = -2; dy <= 2; dy += 0.5) for (let dx = -2; dx <= 2; dx += 0.5) { const [u, v] = map(mx + dx, my + dy); s += sample(g, u, v); n++; }
      if (s / n > 110) { res.error = "sheet could not be lined up (corner squares not where expected) - re-scan"; return res; }
    }
    if (!info) {
      if (!fallbackLayout) { res.error = "QR code unreadable - choose the sheet type and read again"; return res; }
      info = { layout: fallbackLayout, test: "", roll: "", paper: "" };
      res.issues.push(["sheet", "QR code unreadable - read using the chosen sheet type"]);
    }
    const layout = getLayout(info.layout);
    if (!layout) { res.error = `unknown sheet type "${info.layout}"`; return res; }
    const geom = buildGeometry(layout);
    Object.assign(res, { layout: info.layout, test: info.test, roll: info.roll, paper: info.paper });

    // paper white level from the body area
    const vals = [];
    for (let y = BODY_Y0; y < BODY_Y1; y += 2.3) for (let x = BODY_X0; x < BODY_X1; x += 2.3) { const [u, v] = map(x, y); vals.push(sample(g, u, v)); }
    vals.sort((a, b) => a - b);
    const white = vals[Math.floor(vals.length * 0.95)] || 255;

    // pass 1: measure every bubble; pass 2: judge each against its own group's empty level
    const dark = new Map(), groups = {};
    for (const f of geom.fields) for (const col of f.columns) for (const b of col) {
      const d = darkness(g, map, b, white); dark.set(b, d); (groups[groupOf(f)] = groups[groupOf(f)] || []).push(d);
    }
    const base = {};
    for (const k in groups) { const a = groups[k].sort((p, q) => p - q); base[k] = Math.min(0.45, a[Math.floor(a.length * 0.5)]); }
    res.baseline = base;
    const ctx = { dark, base };
    for (const f of geom.fields) readField(g, map, f, white, res, ctx);
    res.ok = true;
    return res;
  }

  function readColumn(g, map, col, white, res, ctx, f) {
    const on = [], doubt = [];
    for (const b of col) {
      const dd = ctx.dark.get(b), st = classify(dd, ctx.base[groupOf(f)]);
      const m = [b.x, b.y, b.r, st]; m.d = dd; res.marks.push(m);
      if (st === "on") on.push(b.v); else if (st === "doubt") doubt.push(b.v);
    }
    return { on, doubt };
  }
  function readField(g, map, f, white, res, ctx) {
    if (f.qtype === "single" || f.qtype === "multi") {
      const { on, doubt } = readColumn(g, map, f.columns[0], white, res, ctx, f);
      const ans = on.join("");
      if (doubt.length) res.issues.push([f.qno, `unclear mark on ${doubt.join(",")}` + (ans ? ` (read ${ans})` : "")]);
      if (f.qtype === "single" && on.length > 1) res.issues.push([f.qno, `more than one bubble marked (${ans})`]);
      res.answers[f.qno] = ans;
      return;
    }
    const chars = []; let bad = false;
    for (const col of f.columns) {
      const { on, doubt } = readColumn(g, map, col, white, res, ctx, f);
      if (on.length > 1 || doubt.length) { bad = true; chars.push("?"); } else chars.push(on[0] || "");
    }
    if (f.kind === "testid") {
      const t = chars.map(c => c || " ").join("").trim();
      res.testBubble = t.includes(" ") || t.includes("?") ? "" : t;
      return;
    }
    if (f.kind === "roll") {
      let roll = chars.map(c => c || " ").join("").trim();
      if (roll.includes(" ")) bad = true;
      res.bubbleRoll = roll.replace(/ /g, "?");
      if (bad) res.issues.push(["roll", `roll number bubbles unclear (read ${res.bubbleRoll || "nothing"})`]);
      return;
    }
    let ci = 0, sign = "", ip = [], dp = [], target = ip;
    for (const p of f.pattern) {
      if (p === ".") { target = dp; continue; }
      const ch = chars[ci++];
      if (p === "-") sign = ch === "-" ? "-" : ch === "?" ? "?" : "";
      else target.push(ch);
    }
    const ipS = ip.map(c => c || " ").join("").trim(), dpS = dp.map(c => c || " ").join("").trimEnd();
    if (ipS.includes(" ") || dpS.includes(" ")) { bad = true; res.issues.push([f.qno, "gap between digits"]); }
    if (!ipS && !dpS) {
      res.answers[f.qno] = sign ? "?" : "";
      if (sign === "-") res.issues.push([f.qno, "minus marked but no digits"]);
      return;
    }
    const raw = `${sign}${ipS || "0"}` + (dpS ? `.${dpS}` : "");
    if (raw.includes("?") || bad) { res.answers[f.qno] = raw.replace(/ /g, "?"); res.issues.push([f.qno, `unclear digit (read ${raw})`]); return; }
    const val = parseFloat(raw);
    res.answers[f.qno] = Number.isInteger(val) ? String(val) : String(+val.toFixed(6));
  }

  // ---------------------------------------------------------------- combine pages into students
  function combine(pages, getLayout) {
    const rows = [], failed = [];
    let seq = 0;
    for (const r of pages) {
      if (!r.ok) { failed.push(r); continue; }
      const issues = r.issues.slice();
      let roll = r.roll;
      const br = r.bubbleRoll;
      if (!roll) {
        roll = br && !br.includes("?") ? br : "";
        if (!roll) { seq++; issues.push(["roll", "roll number missing - check sheet"]); roll = `UNKNOWN-${seq}`; }
      } else if (br && br.replace(/^0+/, "") !== roll.replace(/^0+/, "")) {
        issues.push(["roll", `bubbled roll ${br} differs from printed roll ${roll} (printed used)`]);
      }
      rows.push({ roll, test: r.test, paper: r.paper, layout: r.layout, source: r.source, answers: r.answers, issues, page: r });
    }
    const seen = {};
    for (const r of rows) (seen[r.test + "|" + r.roll] = seen[r.test + "|" + r.roll] || []).push(r);
    for (const k in seen) if (seen[k].length > 1) for (const r of seen[k]) r.issues.push(["roll", "same roll number on more than one sheet"]);
    for (const r of rows) r.status = r.issues.length ? "REVIEW" : "OK";
    rows.sort((a, b) => (a.test + a.roll.padStart(ROLL_DIGITS, "0")).localeCompare(b.test + b.roll.padStart(ROLL_DIGITS, "0")));
    return { rows, failed };
  }

  // ---------------------------------------------------------------- scoring
  function parseKey(text) {
    // lines: q,answer   or   paper,q,answer   (header optional)
    const keys = {};
    for (const line of text.split(/\r?\n/)) {
      const p = line.trim().split(/\s*[,\t;]\s*|\s+/).map(s => s.trim());
      if (p.length < 2 || !p.join("")) continue;
      let paper = "*", q, a;
      if (p.length >= 3) [paper, q, a] = p; else [q, a] = p;
      q = parseInt(String(q).replace(/^q/i, ""), 10);
      if (!Number.isFinite(q)) continue;
      paper = paper || "*";
      (keys[paper] = keys[paper] || {})[q] = String(a || "").toUpperCase().replace(/[,\s]/g, "");
    }
    return keys;
  }
  function numMatch(marked, key) {
    const v = parseFloat(marked);
    if (!Number.isFinite(v) || !/^-?\d*\.?\d+$/.test(marked)) return false;
    if (key.includes(":")) {
      const [lo, hi] = key.split(":").map(parseFloat);
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
      return v >= lo - 1e-9 && v <= hi + 1e-9;
    }
    const k = parseFloat(key);
    if (!Number.isFinite(k)) return null;
    return Math.abs(v - k) < 1e-6;
  }
  function markOne(qtype, marks, marked, key, options) {
    if (!key) return ["nokey", 0];
    if (options === "1234" && /^[A-D]+$/.test(key)) key = key.replace(/[A-D]/g, ch => "ABCD".indexOf(ch) + 1);
    if (options !== "1234" && /^[1-4]+$/.test(key) && (qtype === "single" || qtype === "multi")) key = key.replace(/[1-4]/g, d => "ABCD"[d - 1]);
    if (key === "*") return ["bonus", marks.correct];
    if (key === "X") return ["dropped", 0];
    if (!marked) return ["blank", 0];
    if (marked.includes("?")) return ["wrong", marks.wrong];
    if ((qtype === "single" || qtype === "multi") && !/^[A-F1-9]+$/.test(key)) return ["badkey", 0];
    if (qtype === "single") return marked.length === 1 && key.includes(marked) ? ["correct", marks.correct] : ["wrong", marks.wrong];
    if (qtype === "multi") {
      const m = new Set(marked), k = new Set(key);
      if (m.size === k.size && [...m].every(x => k.has(x))) return ["correct", marks.correct];
      if ([...m].some(x => !k.has(x))) return ["wrong", marks.wrong];
      return marks.partial ? ["partial", m.size] : ["wrong", marks.wrong];
    }
    const ok = numMatch(marked, key);
    if (ok === null) return ["badkey", 0];
    return ok ? ["correct", marks.correct] : ["wrong", marks.wrong];
  }
  function scoreAll(rows, keys, getLayout) {
    const out = [];
    for (const r of rows) {
      const layout = getLayout(r.layout);
      const key = keys[r.paper] || keys["*"] || {};
      const subj = {}, cnt = { correct: 0, partial: 0, wrong: 0, blank: 0 }, detail = [];
      let total = 0;
      for (const { qno, sec } of questionIndex(layout)) {
        const marked = r.answers[qno] || "";
        const [result, sc] = markOne(sec.qtype, sec.marks, marked, key[qno] || "", sec.options);
        total += sc; subj[sec.subject] = (subj[sec.subject] || 0) + sc;
        if (result in cnt) cnt[result]++;
        detail.push({ q: qno, subject: sec.subject, type: sec.qtype, marked, key: key[qno] || "", result, marks: sc });
      }
      out.push({ roll: r.roll, test: r.test, paper: r.paper, status: r.status, total, subjects: subj, ...cnt, detail });
    }
    const byTest = {};
    for (const s of out) (byTest[s.test] = byTest[s.test] || []).push(s);
    for (const t in byTest) byTest[t].sort((a, b) => b.total - a.total).forEach((s, i) => (s.rank = i + 1));
    return out;
  }

  const api = {
    PAGE_W, PAGE_H, MARKERS, MARKER_SIZE, QR_BOX, ROLL_DIGITS, ROLL_X0, ROLL_Y0, ROLL_PITCH_X, ROLL_PITCH_Y,
    NUM_PITCH_X, NUM_TITLE_H, NUM_BOX_H, TYPE_LONG, NUMERIC_COLUMNS, DEFAULT_MARKS,
    PRESETS, section, buildGeometry, customLayout, getLayout, TCODE, questionIndex, totalQ, qrPayload, parseQr, rollField,
    readPage, combine, parseKey, markOne, scoreAll, FILLED, EMPTY,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.OMR = api;
})(typeof window !== "undefined" ? window : globalThis);
