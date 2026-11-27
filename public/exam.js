/* Online test screen, laid out and behaving like the NTA computer-based test (JEE Main / NEET):
   instructions page, timer, section tabs, question palette with the five NTA statuses,
   Save & Next / Clear / Save & Mark for Review / Mark for Review & Next / Back / Next / Submit,
   on-screen keypad for numerical answers, autosave every few seconds, auto-submit at time zero. */
(function () {
  "use strict";
  const X = window.TPX;
  const { h, GET, POST, PUT, richNode, toast } = X;
  const LETTERS = ["A", "B", "C", "D"];
  const pad = n => String(n).padStart(2, "0");
  const clock = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`; };
  const TYPE_NOTE = { single: "Only one option is correct.", multi: "One or more options may be correct.", integer: "Enter an integer using the keypad.", decimal: "Enter a numerical value using the keypad." };

  // ------------------------------------------------------------------ instructions
  function instructions(view, t, onStart) {
    const ok = h("input", { type: "checkbox", id: "nta-agree" });
    const go = h("button", { class: "nta-btn green", type: "button", disabled: true }, "PROCEED");
    ok.onchange = () => (go.disabled = !ok.checked);
    go.onclick = () => { go.disabled = true; go.textContent = "Starting…"; onStart().catch(e => { toast(e.message); go.disabled = false; go.textContent = "PROCEED"; }); };
    const sym = (cls, n, text) => h("li", {}, h("span", { class: "pq " + cls }, n), " ", text);
    X.show(view, h("div", { class: "nta nta-inst" },
      h("header", { class: "nta-top" }, h("div", { class: "nta-logo" }, "TP"), h("div", { class: "nta-title" }, h("b", {}, t.name), h("span", {}, `${t.code} · ${t.questions} questions · ${t.duration} minutes`))),
      h("div", { class: "nta-inst-body" },
        h("h2", {}, "General Instructions"), h("p", {}, "Please read the instructions carefully."),
        h("ol", {},
          h("li", {}, `The total duration of the test is ${t.duration} minutes.`),
          h("li", {}, "The clock is set at the server. The countdown timer at the top right of the screen shows the time left. When the timer reaches zero, the test ends by itself and your saved answers are submitted. You do not need to submit."),
          h("li", {}, "The Question Palette on the right shows the status of each question using these symbols:",
            h("ul", { class: "nta-legend-list" },
              sym("nv", 1, "You have not visited the question yet."),
              sym("na", 2, "You have not answered the question."),
              sym("an", 3, "You have answered the question."),
              sym("mr", 4, "You have NOT answered the question, but have marked it for review."),
              sym("am", 5, "The question is answered and marked for review. It WILL be evaluated."))),
          h("li", {}, "Marked for Review means you want to look at the question again."),
          h("li", {}, "Click a question number in the palette to go to it directly. Doing so does NOT save your answer to the current question."),
          h("li", {}, "Click Save & Next to save your answer and go to the next question. An answer is saved only when you click Save & Next or Save & Mark for Review."),
          h("li", {}, "Mark for Review & Next marks the question for review and goes to the next question."),
          h("li", {}, "To change your answer, select another option and save it again. To remove a saved answer, click Clear Response."),
          h("li", {}, "For numerical questions, enter the answer using the on-screen keypad."),
          h("li", {}, "Sections are shown as tabs at the top. Click a section's name to see its questions."),
          h("li", {}, "If your internet connection drops, do not close the page. Your answers are saved every few seconds, and you can log in again to continue. The clock keeps running.")),
        h("label", { class: "nta-agree" }, ok, " I have read and understood the instructions. I agree that I will not use any unfair means during this test."),
        h("div", { class: "nta-inst-foot" }, h("a", { class: "nta-btn", href: "#/my" }, "‹ Back"), go))));
  }

  // ------------------------------------------------------------------ exam
  async function exam(view, id) {
    const P = await POST(`/api/my/cbt/${id}/start`);
    const offset = Date.now() - P.now; // device clock vs server clock
    const S = Object.assign({ ans: {}, mark: {}, seen: {}, time: {}, cur: 0 }, P.state || {});
    for (const k of ["ans", "mark", "seen", "time"]) S[k] = S[k] || {};
    const Q = P.questions, secs = P.sections;
    let cur = Math.min(S.cur || 0, Q.length - 1), sel = "", finished = false, dirty = false, saving = false, lastTick = Date.now();
    const secOf = i => secs[Q[i].si];
    const opt = (si, k) => (secs[si].options === "1234" ? String(k + 1) : LETTERS[k]);
    const status = q => { const a = S.ans[q] != null && S.ans[q] !== "", m = !!S.mark[q];
      return a && m ? "am" : m ? "mr" : a ? "an" : S.seen[q] ? "na" : "nv"; };

    document.body.classList.add("exam-mode");
    const leave = () => { document.body.classList.remove("exam-mode"); window.removeEventListener("hashchange", leave); clearInterval(timerId); clearInterval(saveId); window.removeEventListener("beforeunload", warn); };
    window.addEventListener("hashchange", leave);
    const warn = e => { if (!finished) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", warn);

    // header
    const timeEl = h("b", { class: "nta-time" }, "--:--:--");
    const subjEl = h("span", {});
    const top = h("header", { class: "nta-top" }, h("div", { class: "nta-logo" }, "TP"),
      h("div", { class: "nta-info" },
        h("div", {}, h("span", { class: "k" }, "Candidate Name : "), h("b", {}, P.candidate.name)),
        h("div", {}, h("span", { class: "k" }, "Exam Name : "), h("b", {}, P.test.name)),
        h("div", {}, h("span", { class: "k" }, "Subject Name : "), subjEl)),
      h("div", { class: "nta-timebox" }, h("span", {}, "Remaining Time :"), timeEl));
    const tabs = h("nav", { class: "nta-tabs", "aria-label": "Sections" });
    const qhead = h("div", { class: "nta-qhead" }), qtype = h("div", { class: "nta-qtype" }), qbody = h("div", { class: "nta-qtext" }), answerBox = h("div", { class: "nta-answer" });
    const main = h("main", { class: "nta-main" }, qhead, h("div", { class: "nta-qscroll" }, qbody, answerBox));
    const counts = h("div", { class: "nta-legend" }), palTitle = h("div", { class: "nta-paltitle" }), pal = h("div", { class: "nta-palette" });
    const aside = h("aside", { class: "nta-side" }, h("div", { class: "nta-cand" }, h("div", { class: "nta-avatar", "aria-hidden": "true" }), h("div", {}, h("b", {}, P.candidate.name), h("div", { class: "small" }, `Roll ${P.candidate.roll || ""}`))),
      counts, palTitle, pal);
    const palToggle = h("button", { class: "nta-btn nta-paltoggle", type: "button", onclick: () => aside.classList.toggle("open") }, "Question Palette");
    const net = h("span", { class: "nta-net", hidden: true }, "Connection lost — answers are kept here and will be saved when you are back online.");
    const b = (cls, text, fn) => h("button", { class: "nta-btn " + cls, type: "button", onclick: fn }, text);
    const foot = h("footer", { class: "nta-foot" },
      h("div", { class: "row1" }, b("green", "SAVE & NEXT", saveNext), b("", "CLEAR", clearResp), b("orange", "SAVE & MARK FOR REVIEW", saveMark), b("blue", "MARK FOR REVIEW & NEXT", markNext)),
      h("div", { class: "row2" }, b("", "<< BACK", () => go(cur - 1)), b("", "NEXT >>", () => go(cur + 1)), palToggle, net, h("span", { style: "flex:1" }), b("green", "SUBMIT", confirmSubmit)));
    const root = h("div", { class: "nta nta-exam", oncontextmenu: e => e.preventDefault(), oncopy: e => e.preventDefault() }, top, tabs, h("div", { class: "nta-body" }, main, aside), foot);
    X.show(view, root);
    try { if (document.fullscreenEnabled && !document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {}); } catch (e) { /* not allowed */ }

    // ---- drawing
    function drawTabs() {
      tabs.replaceChildren(...secs.map((s, si) => h("button", { type: "button", class: si === Q[cur].si ? "on" : "", onclick: () => go(Q.findIndex(q => q.si === si)) }, s.name)));
    }
    function drawPalette() {
      const c = { nv: 0, na: 0, an: 0, mr: 0, am: 0 };
      Q.forEach(q => c[status(q.qno)]++);
      const L = (cls, n, label) => h("div", { class: "lg" }, h("span", { class: "pq " + cls }, n), h("span", {}, label));
      counts.replaceChildren(L("an", c.an, "Answered"), L("na", c.na, "Not Answered"), L("nv", c.nv, "Not Visited"), L("mr", c.mr, "Marked for Review"),
        h("div", { class: "lg wide" }, h("span", { class: "pq am" }, c.am), h("span", {}, "Answered & Marked for Review (will be considered for evaluation)")));
      const si = Q[cur].si;
      palTitle.textContent = secs[si].name;
      pal.replaceChildren(...Q.map((q, i) => q.si !== si ? null : h("button", { type: "button", class: "pq " + status(q.qno) + (i === cur ? " cur" : ""), "aria-label": `Question ${q.qno}`,
        onclick: () => { go(i); aside.classList.remove("open"); } }, q.qno)).filter(Boolean));
    }
    function drawQuestion() {
      const q = Q[cur], s = secOf(cur);
      subjEl.textContent = s.subject.charAt(0) + s.subject.slice(1).toLowerCase();
      qhead.replaceChildren(h("b", {}, `Question ${q.qno}:`), h("span", { class: "nta-marks" }, `+${s.marks.correct}${s.marks.wrong ? `, −${Math.abs(s.marks.wrong)}` : ""}`));
      qtype.textContent = TYPE_NOTE[s.qtype];
      X.show(qbody, q.fmt === "html" ? richNode(q.text) : h("div", { style: "white-space:pre-wrap" }, q.text || ""), q.image ? h("img", { src: q.image, alt: "", class: "nta-img" }) : null);
      [...qbody.querySelectorAll("img")].forEach(i => i.setAttribute("draggable", "false"));
      sel = S.ans[q.qno] || "";
      drawAnswer();
      main.querySelector(".nta-qscroll").scrollTop = 0;
    }
    function drawAnswer() {
      const q = Q[cur], s = secOf(cur), si = q.si;
      if (s.qtype === "single" || s.qtype === "multi") {
        const multi = s.qtype === "multi";
        answerBox.replaceChildren(qtype, ...LETTERS.map((L, k) => {
          const on = sel.includes(L);
          const inp = h("input", { type: multi ? "checkbox" : "radio", name: "nta-opt", checked: on, onchange: () => {
            if (multi) { const set = new Set(sel); inp.checked ? set.add(L) : set.delete(L); sel = [...set].sort().join(""); } else sel = L;
          } });
          const text = q.options && q.options[k] ? q.options[k] : "";
          return h("label", { class: "nta-opt" + (on ? " on" : "") }, inp, h("span", { class: "nta-optk" }, `(${opt(si, k)})`), text ? h("span", {}, text) : null);
        }));
        answerBox.querySelectorAll("input").forEach(i => i.addEventListener("change", () => answerBox.querySelectorAll(".nta-opt").forEach(l => l.classList.toggle("on", l.querySelector("input").checked))));
      } else {
        const field = h("input", { class: "nta-num", value: sel, inputmode: "decimal", "aria-label": "Your answer", autocomplete: "off" });
        const put = v => { sel = v.slice(0, 12); field.value = sel; };
        field.oninput = () => put(field.value.replace(s.qtype === "integer" ? /[^0-9-]/g : /[^0-9.-]/g, ""));
        const key = (label, fn, cls = "") => h("button", { type: "button", class: "nk " + cls, onclick: fn }, label);
        const keys = ["7", "8", "9", "4", "5", "6", "1", "2", "3", "0", ".", "-"].map(k => key(k, () => {
          if (k === "." && (s.qtype === "integer" || sel.includes("."))) return;
          if (k === "-" ) { put(sel.startsWith("-") ? sel.slice(1) : "-" + sel); return; }
          put(sel + k);
        }, k === "." && s.qtype === "integer" ? "off" : ""));
        answerBox.replaceChildren(qtype, field, h("div", { class: "nta-keypad" },
          h("div", { class: "nk-row" }, key("Backspace", () => put(sel.slice(0, -1)), "wide")), h("div", { class: "nk-grid" }, keys),
          h("div", { class: "nk-row" }, key("Clear All", () => put(""), "wide"))));
      }
    }
    function drawAll() { drawTabs(); drawPalette(); drawQuestion(); }

    // ---- actions (NTA rules: an answer counts only after Save & Next / Save & Mark for Review)
    function touch() { dirty = true; S.cur = cur; }
    function go(i) {
      if (i < 0 || i >= Q.length) return;
      cur = i; S.seen[Q[cur].qno] = true; touch(); drawAll();
    }
    function saveNext() { const q = Q[cur].qno; if (sel) S.ans[q] = sel; else delete S.ans[q]; S.mark[q] = false; touch(); next(); }
    function saveMark() { const q = Q[cur].qno; if (!sel) { toast("Choose an answer first, or use Mark for Review & Next."); return; } S.ans[q] = sel; S.mark[q] = true; touch(); next(); }
    function markNext() { S.mark[Q[cur].qno] = true; touch(); next(); }
    function clearResp() { sel = ""; delete S.ans[Q[cur].qno]; touch(); drawAnswer(); drawPalette(); }
    function next() { if (cur < Q.length - 1) go(cur + 1); else { drawPalette(); drawAnswer(); } }

    // ---- saving, timer
    async function save(force) {
      if (finished || saving || (!dirty && !force)) return;
      saving = true; const was = dirty; dirty = false;
      try { const r = await PUT(`/api/my/cbt/${id}/save`, { state: S }); net.hidden = true; if (r.submitted) done(true); }
      catch (e) { dirty = dirty || was; net.hidden = false; }
      finally { saving = false; }
    }
    const saveId = setInterval(() => save(false), 5000);
    const tick = () => {
      const now = Date.now(), left = P.ends_at - (now - offset);
      S.time[Q[cur].qno] = (S.time[Q[cur].qno] || 0) + (now - lastTick) / 1000; lastTick = now;
      timeEl.textContent = clock(left);
      timeEl.classList.toggle("low", left < 5 * 60000);
      if (left <= 0 && !finished) submit(true);
    };
    const timerId = setInterval(tick, 1000);
    timeEl.textContent = clock(P.ends_at - (Date.now() - offset));

    function summaryTable() {
      const rows = secs.map((s, si) => { const c = { nv: 0, na: 0, an: 0, mr: 0, am: 0 }; Q.filter(q => q.si === si).forEach(q => c[status(q.qno)]++);
        return h("tr", {}, h("td", {}, s.name), h("td", {}, s.count), h("td", {}, c.an), h("td", {}, c.na), h("td", {}, c.mr), h("td", {}, c.am), h("td", {}, c.nv)); });
      return h("div", { class: "tablebox" }, h("table", { class: "nta-sum" }, h("thead", {}, h("tr", {}, ["Section", "No. of Questions", "Answered", "Not Answered", "Marked for Review", "Answered & Marked for Review", "Not Visited"].map(x => h("th", {}, x)))), h("tbody", {}, rows)));
    }
    function confirmSubmit() {
      const box = h("div", { class: "nta-modal" }, h("div", { class: "nta-modal-card" }, h("h2", {}, "Exam Summary"), summaryTable(),
        h("p", {}, "Are you sure you want to submit for final marking? No changes will be allowed after submission."),
        h("div", { class: "nta-modal-foot" }, b("green", "YES", () => { box.remove(); submit(false); }), b("", "NO", () => box.remove()))));
      root.append(box);
    }
    async function submit(auto) {
      if (finished) return; finished = true;
      clearInterval(timerId); clearInterval(saveId);
      if (auto) toast("Time is up. Your test is being submitted.");
      for (let i = 0; i < 5; i++) {
        try { await POST(`/api/my/cbt/${id}/submit`, { state: S }); return done(false); }
        catch (e) { net.hidden = false; await new Promise(r => setTimeout(r, 2000 * (i + 1))); }
      }
      done(false, true);
    }
    function done(byServer, failed) {
      finished = true; clearInterval(timerId); clearInterval(saveId);
      try { if (document.fullscreenElement) document.exitFullscreen(); } catch (e) { /* ignore */ }
      X.show(view, h("div", { class: "nta nta-inst" },
        h("header", { class: "nta-top" }, h("div", { class: "nta-logo" }, "TP"), h("div", { class: "nta-title" }, h("b", {}, P.test.name), h("span", {}, P.candidate.name))),
        h("div", { class: "nta-inst-body" },
          h("h2", {}, failed ? "Could not reach the server" : "Your test has been submitted"),
          h("p", {}, failed ? "Your answers were saved up to the last few seconds. When the time is over they are submitted automatically. You can close this page."
            : byServer ? "The time was over, so your saved answers were submitted." : "Thank you. Your answers are recorded. Results will appear in My results once your institute publishes them."),
          summaryTable(),
          h("div", { class: "nta-inst-foot" }, h("a", { class: "nta-btn green", href: "#/my" }, "Go to My results")))));
      document.body.classList.remove("exam-mode");
    }

    S.seen[Q[cur].qno] = true;
    drawAll();
  }

  window.TPExam = { instructions, exam };
})();
