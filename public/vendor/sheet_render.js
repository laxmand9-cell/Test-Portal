/* Draws an OMR sheet through a small drawing interface, so the same code makes the
   on-screen preview (SVG) and the printable PDF (jsPDF). All units are millimetres. */
(function (root) {
  "use strict";
  const O = root.OMR;
  const NAVY = "#132a55", GOLD = "#c99a2e", GOLD_LIGHT = "#fbf1d8", GREY = "#9a9da5", INK = "#1d1f24", LINE = "#a9adb6";
  const PT = 0.3528; // mm per point

  function svgBackend() {
    const out = [];
    const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
    return {
      rect(x, y, w, h, o) { out.push(`<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}"${o.rx ? ` rx="${o.rx}"` : ""} fill="${o.fill || "none"}"${o.stroke ? ` stroke="${o.stroke}" stroke-width="${o.lw || 0.2}"` : ""}/>`); },
      circle(x, y, r, o) { out.push(`<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${r.toFixed(2)}" fill="${o.fill || "none"}"${o.stroke ? ` stroke="${o.stroke}" stroke-width="${o.lw || 0.2}"` : ""}/>`); },
      line(x1, y1, x2, y2, o) { out.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${o.stroke}" stroke-width="${o.lw || 0.15}"/>`); },
      text(x, y, s, o) {
        const anchor = o.align === "center" ? "middle" : o.align === "right" ? "end" : "start";
        out.push(`<text x="${x.toFixed(2)}" y="${y.toFixed(2)}" font-family="Helvetica, Arial, sans-serif" font-size="${(o.size * PT).toFixed(2)}" font-weight="${o.bold ? 700 : 400}" fill="${o.color}" text-anchor="${anchor}">${esc(s)}</text>`);
      },
      qr(x, y, size, modules) { // modules: array of [r, c] dark cells, n = count
        const n = modules.n, m = size / n; let d = "";
        for (const [r, c] of modules.cells) d += `M${(x + c * m).toFixed(3)} ${(y + r * m).toFixed(3)}h${m.toFixed(3)}v${m.toFixed(3)}h-${m.toFixed(3)}z`;
        out.push(`<path d="${d}" fill="#000"/>`);
      },
      done() { return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${O.PAGE_W} ${O.PAGE_H}" width="${O.PAGE_W}mm" height="${O.PAGE_H}mm"><rect width="100%" height="100%" fill="#fff"/>${out.join("")}</svg>`; },
    };
  }

  function pdfBackend(doc) {
    const rgb = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
    const style = o => { if (o.fill) doc.setFillColor(...rgb(o.fill)); if (o.stroke) { doc.setDrawColor(...rgb(o.stroke)); doc.setLineWidth(o.lw || 0.2); } return o.fill && o.stroke ? "FD" : o.fill ? "F" : "S"; };
    return {
      rect(x, y, w, h, o) { const st = style(o); o.rx ? doc.roundedRect(x, y, w, h, o.rx, o.rx, st) : doc.rect(x, y, w, h, st); },
      circle(x, y, r, o) { doc.circle(x, y, r, style(o)); },
      line(x1, y1, x2, y2, o) { style({ stroke: o.stroke, lw: o.lw || 0.15 }); doc.line(x1, y1, x2, y2); },
      text(x, y, s, o) { doc.setFont("helvetica", o.bold ? "bold" : "normal"); doc.setFontSize(o.size); doc.setTextColor(...rgb(o.color)); doc.text(String(s), x, y, { align: o.align || "left" }); },
      qr(x, y, size, modules) { const m = size / modules.n; doc.setFillColor(0, 0, 0); for (const [r, c] of modules.cells) doc.rect(x + c * m, y + r * m, m + 0.01, m + 0.01, "F"); },
    };
  }

  function qrModules(text) {
    const q = root.qrcode(0, "M"); q.addData(text); q.make();
    const n = q.getModuleCount(), cells = [];
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) cells.push([r, c]);
    // add the 4-module quiet zone
    return { n: n + 8, cells: cells.map(([r, c]) => [r + 4, c + 4]) };
  }

  function bubble(g, b) {
    g.circle(b.x, b.y, b.r, { fill: "#ffffff", stroke: NAVY, lw: 0.19 });
    if (b.hide) return;
    const fs = b.r * 2.2 * 2.83 * 0.75;
    g.text(b.x, b.y + fs * PT * 0.36, b.v, { size: fs, color: GREY, align: "center" });
  }

  function drawClassic(g, layout, test, st, geom) {
    const K = "#111318";
    for (const k in O.MARKERS) { const [mx, my] = O.MARKERS[k], s = O.MARKER_SIZE; g.rect(mx - s / 2, my - s / 2, s, s, { fill: "#000000" }); }
    // heading
    g.text(105, 20.6, test.name || layout.title, { size: 15, bold: true, color: NAVY, align: "center" });
    g.text(193, 20.6, layout.title, { size: 10.5, bold: true, color: K, align: "right" });
    g.rect(17, 23.4, 176, 0.7, { fill: GOLD });
    // ID box
    g.rect(17, 26.5, 76, 57, { stroke: K, lw: 0.25 });
    const roll = st.roll ? String(st.roll).padStart(7, "0") : "";
    const idf = geom.fields.filter(f => f.kind === "roll" || f.kind === "testid");
    for (const f of idf) {
      const x0 = f.columns[0][0].x;
      g.text(x0 - 2.2, 31.2, f.kind === "roll" ? "STUDENT ID" : "TEST ID", { size: 7.5, bold: true, color: K });
      f.columns.forEach((col, c) => {
        g.rect(col[0].x - 2.4, 33, 4.8, 5.2, { stroke: K, lw: 0.2 });
        if (f.kind === "roll" && roll) g.text(col[0].x, 37, roll[c], { size: 9, color: K, align: "center" });
        for (const b of col) g.circle(b.x, b.y, b.r, { fill: "#ffffff", stroke: K, lw: 0.2 });
      });
      f.columns[0].forEach(b => g.text(x0 - 3.6, b.y + 0.9, b.v, { size: 6.8, color: K, align: "right" }));
    }
    // details box
    g.rect(97, 25.6, 96, 33, { stroke: K, lw: 0.25 });
    const det = geom.style === "R180" ? [["Name", st.name], ["Section", ""], ["Branch", ""], ["Invigilator", ""]]
                                      : [["Name", st.name], ["Date", ""], ["Sec & Branch", ""], ["Subjects", ""]];
    det.forEach(([k, v], i) => {
      const y = 32.5 + i * 7.2;
      g.text(99.5, y, k + " :", { size: 8.5, color: K });
      g.line(119, y + 0.6, 158, y + 0.6, { stroke: LINE, lw: 0.15 });
      if (v) g.text(120, y - 0.3, v, { size: 9, color: INK });
    });
    const [qx, qy, qs] = O.QR_BOX;
    g.qr(qx, qy, qs, qrModules(O.qrPayload(layout.id, test.code, st.roll, st.paper)));
    // instructions
    g.text(145, 64.5, "INSTRUCTIONS FOR FILLING THE OMR", { size: 7.8, bold: true, color: K, align: "center" });
    g.line(122, 65.3, 168, 65.3, { stroke: K, lw: 0.2 });
    g.text(145, 68.8, "1. Your Student ID must be correctly marked", { size: 6.8, color: K, align: "center" });
    g.text(145, 72.2, "2. Use only Black or Blue Pen for marking", { size: 6.8, color: K, align: "center" });
    g.text(122, 76.4, "WRONG METHOD", { size: 6.8, bold: true, color: K, align: "center" });
    g.text(168, 76.4, "CORRECT METHOD", { size: 6.8, bold: true, color: K, align: "center" });
    const iy = 80.2, ir = 1.55;
    [114.5, 119.5, 124.5, 129.5].forEach((x, i) => {
      g.circle(x, iy, ir, { fill: "#ffffff", stroke: K, lw: 0.2 });
      if (i === 0) { g.line(x - 0.9, iy - 0.9, x + 0.9, iy + 0.9, { stroke: K, lw: 0.35 }); g.line(x - 0.9, iy + 0.9, x + 0.9, iy - 0.9, { stroke: K, lw: 0.35 }); }
      if (i === 1) g.circle(x, iy, 0.7, { fill: K });
      if (i === 2) for (let d = -1; d <= 1; d++) g.line(x - 1.1, iy + d * 0.6 + 0.5, x + 1.1, iy + d * 0.6 - 0.5, { stroke: K, lw: 0.3 });
      if (i === 3) { g.line(x - 1.1, iy, x - 0.3, iy + 1.0, { stroke: K, lw: 0.35 }); g.line(x - 0.3, iy + 1.0, x + 1.6, iy - 2.0, { stroke: K, lw: 0.35 }); }
    });
    [160.5, 165.5, 170.5, 175.5].forEach((x, i) => g.circle(x, iy, ir, i === 3 ? { fill: K } : { fill: "#ffffff", stroke: K, lw: 0.2 }));
    // answer area
    for (const [x, y, w, h] of geom.boxes) g.rect(x, y, w, h, { stroke: K, lw: 0.25 });
    for (const lb of geom.labels || []) {
      if (lb[0] === "ABCD") [..."ABCD"].forEach((ch, i) => g.text(lb[1] + i * lb[3], lb[2], ch, { size: 8, bold: true, color: K, align: "center" }));
      else g.text(lb[0], lb[1], lb[2], { size: 7.2, bold: true, color: NAVY, align: "center" });
    }
    for (const f of geom.fields) {
      if (f.kind !== "q") continue;
      if (f.qtype === "single") {
        g.text(f.label[0], f.label[1] + 0.95, String(f.qno), { size: 7.6, bold: true, color: K, align: "right" });
        for (const b of f.columns[0]) bubble(g, b);
      } else {
        g.text(f.label[0], f.label[1], String(f.qno), { size: 7.6, bold: true, color: K });
        for (const col of f.columns) for (const b of col) bubble(g, b);
      }
    }
    g.text(105, 289.5, "Machine-read sheet: keep clean and flat. Do not staple.", { size: 6.5, color: GREY, align: "center" });
  }

  function drawSheet(g, layout, test, student) {
    const geom = O.buildGeometry(layout);
    if (layout.classic) return drawClassic(g, layout, test, student || {}, geom);
    const st = student || {};
    // corner squares
    for (const k in O.MARKERS) { const [mx, my] = O.MARKERS[k], s = O.MARKER_SIZE; g.rect(mx - s / 2, my - s / 2, s, s, { fill: "#000000" }); }
    // title band
    g.rect(17, 14.5, 176, 8.5, { fill: NAVY });
    g.rect(17, 23, 176, 1, { fill: GOLD });
    g.text(20, 20.3, layout.title, { size: 11, bold: true, color: "#ffffff" });
    g.text(190, 20.3, test.name || test.code, { size: 8.5, color: "#ffffff", align: "right" });
    // student details
    const rows = [["Name", st.name], ["Roll No.", st.roll], ["Paper code", st.paper], ["Test code", test.code], ["Signature", ""]];
    rows.forEach(([k, v], i) => {
      const y = 30 + i * 5.6;
      g.text(17, y, k, { size: 8, bold: true, color: INK });
      g.line(36, y + 0.8, 96, y + 0.8, { stroke: LINE, lw: 0.15 });
      if (v) g.text(37, y, v, { size: 9, color: INK });
    });
    // how to mark
    g.rect(17, 58, 79, 14, { fill: GOLD_LIGHT, stroke: GOLD, lw: 0.25, rx: 1.5 });
    g.text(19, 61.4, "HOW TO MARK", { size: 7, bold: true, color: NAVY });
    g.text(19, 64.5, "Use a black or blue ball pen. Darken the bubble fully.", { size: 6.5, color: NAVY });
    g.text(19, 67.4, "Correct:", { size: 6.5, color: NAVY });
    g.circle(31.5, 66.8, 1.5, { fill: INK });
    g.text(35, 67.4, "Wrong:  tick, cross, half-fill, dot", { size: 6.5, color: NAVY });
    g.text(19, 70.3, "No whitener. Do not fold or write near the black squares.", { size: 6.5, color: NAVY });
    // roll number grid
    const x0 = O.ROLL_X0 - O.ROLL_PITCH_X / 2 - 1.2, w = O.ROLL_DIGITS * O.ROLL_PITCH_X + 2.4;
    const top = O.ROLL_Y0 - 9.4, bottom = O.ROLL_Y0 + 9.5 * O.ROLL_PITCH_Y + 1.0;
    g.rect(x0, top, w, bottom - top, { stroke: NAVY, lw: 0.21 });
    g.text(x0 + w / 2, O.ROLL_Y0 - 6.6, "ROLL NUMBER", { size: 7, bold: true, color: NAVY, align: "center" });
    const roll = st.roll ? String(st.roll).padStart(O.ROLL_DIGITS, "0") : "";
    for (let c = 0; c < O.ROLL_DIGITS; c++) {
      const bx = O.ROLL_X0 + c * O.ROLL_PITCH_X;
      g.rect(bx - 2.1, O.ROLL_Y0 - 5.6, 4.2, 3.9, { stroke: LINE, lw: 0.15 });
      if (roll) g.text(bx, O.ROLL_Y0 - 2.6, roll[c], { size: 8, color: INK, align: "center" });
    }
    for (const col of O.rollField().columns) for (const b of col) bubble(g, b);
    // QR
    const [qx, qy, qs] = O.QR_BOX;
    g.qr(qx, qy, qs, qrModules(O.qrPayload(layout.id, test.code, st.roll, st.paper)));
    g.text(qx + qs / 2, qy + qs + 2.8, "Do not write on this code", { size: 6, color: GREY, align: "center" });
    g.text(qx + qs / 2, qy + qs + 6.6, "Write roll no. in boxes and", { size: 6.8, bold: true, color: NAVY, align: "center" });
    g.text(qx + qs / 2, qy + qs + 9.6, "darken matching bubbles", { size: 6.8, bold: true, color: NAVY, align: "center" });
    // section headers
    for (const [x, y, hw, text] of geom.headers) {
      g.rect(x, y, hw, 4, { fill: GOLD_LIGHT });
      g.rect(x, y, 1, 4, { fill: GOLD });
      g.text(x + 2, y + 2.9, text.replace("·", "-"), { size: 6.3, bold: true, color: NAVY });
    }
    // questions
    for (const f of geom.fields) {
      if (f.kind !== "q") continue;
      if (f.qtype === "single" || f.qtype === "multi") {
        g.text(f.label[0], f.label[1] + 0.95, String(f.qno), { size: 7.5, bold: true, color: INK, align: "right" });
        for (const b of f.columns[0]) bubble(g, b);
      } else {
        const [bx0, by0, bw, bh] = f.box;
        g.rect(bx0, by0, bw, bh, { stroke: NAVY, lw: 0.18 });
        g.text(bx0 + bw / 2, by0 + 2.8, `Q${f.qno}`, { size: 6.5, bold: true, color: NAVY, align: "center" });
        const by = by0 + O.NUM_TITLE_H;
        let ci = 0;
        for (const p of f.pattern) {
          if (p === ".") { const px = f.columns[ci - 1][0].x + O.NUM_PITCH_X / 2 + 0.8; g.circle(px, by + 3.6, 0.42, { fill: INK }); continue; }
          const col = f.columns[ci];
          g.rect(col[0].x - 1.7, by + 0.3, 3.4, 3.8, { stroke: LINE, lw: 0.12 });
          for (const b of col) bubble(g, b);
          ci++;
        }
      }
    }
    g.text(105, 289.5, "Machine-read sheet: keep clean and flat. Do not staple.", { size: 6.5, color: GREY, align: "center" });
  }

  function sheetSvg(layout, test, student) { const g = svgBackend(); drawSheet(g, layout, test, student); return g.done(); }
  function sheetsPdf(layout, test, students) {
    const doc = new root.jspdf.jsPDF({ unit: "mm", format: "a4", compress: true });
    students.forEach((s, i) => { if (i) doc.addPage(); drawSheet(pdfBackend(doc), layout, test, s); });
    return doc;
  }
  root.OMRSheet = { sheetSvg, sheetsPdf };
})(typeof window !== "undefined" ? window : globalThis);
