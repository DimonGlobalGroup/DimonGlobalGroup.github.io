"use strict";
/* presentation.js - presentation layer for 2048 - Refined.
 * SUPERSEDES polish.js. Presentation only: it never touches game state,
 * never calls the engine, adds no input handling and no telemetry.
 * It learns what the (frozen) engine did purely by watching the DOM:
 *   - #score / #best text         -> score bump, gain floater, record glow
 *   - #tiles style/class/children -> slide, merge and spawn sounds
 *   - #ov-end visibility          -> win / game-over modal kind + sounds
 * Everything here is event-driven (one MutationObserver callback per move);
 * there is no per-frame JS. Motion itself is CSS transform/opacity only.
 * No Math.random (own LCG) so seeded/stubbed engine runs stay reproducible.
 * Only storage touched: "hope2048.mute" (sound preference), try/catch. */
(function () {
  try {
    const $ = s => document.querySelector(s);
    const scoreEl = $("#score"), bestEl = $("#best"), tilesEl = $("#tiles"),
      boardEl = $("#board"), endEl = $("#ov-end"), keepBtn = $("#btn-keepgoing");
    if (!scoreEl || !tilesEl || !boardEl) return;
    const reduced = window.matchMedia ? matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
    let seed = 0x2f6e2b1;
    const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const num = el => (el ? parseInt(el.textContent, 10) || 0 : 0);

    /* ---------- score feedback (bump + floating gain + record glow) ---------- */
    const boxOf = el => (el ? el.closest(".scorebox") : null);
    const scoreBox = boxOf(scoreEl), bestBox = boxOf(bestEl);
    // Alternating data-b="1"/"2" swap between two identical keyframe names,
    // which restarts a CSS animation without a forced reflow.
    const flip = e => { e.dataset.b = e.dataset.b === "1" ? "2" : "1"; };
    const floats = [];
    if (scoreBox) for (let i = 0; i < 3; i++) {
      const s = document.createElement("span");
      s.className = "gain"; s.setAttribute("aria-hidden", "true");
      s.style.top = "calc(100% + " + (i * 1.1 - 0.3) + "rem)";
      scoreBox.appendChild(s); floats.push(s);
    }
    let slot = 0;
    function floatGain(n) {
      if (!floats.length || n <= 0) return;
      const s = floats[slot]; slot = (slot + 1) % floats.length;
      s.textContent = "+" + n; flip(s);
    }
    let lastScore = num(scoreEl), lastBest = num(bestEl);
    const scoreMo = new MutationObserver(() => {
      const v = num(scoreEl), b = num(bestEl);
      if (v > lastScore) { if (scoreBox) flip(scoreBox); floatGain(v - lastScore); }
      else if (v < lastScore && bestBox) bestBox.classList.remove("record");
      if (b > lastBest && bestBox) { flip(bestBox); bestBox.classList.add("record"); }
      lastScore = v; lastBest = b;
    });
    const mopts = { childList: true, characterData: true, subtree: true };
    scoreMo.observe(scoreEl, mopts);
    if (bestEl) scoreMo.observe(bestEl, mopts);

    /* ---------- sound (WebAudio, synthesized, gentle, off until first gesture) ---------- */
    let ctx = null, master = null, noise = null, unlocked = false, muted = false, lastSlide = 0;
    try { muted = localStorage.getItem("hope2048.mute") === "1"; } catch (e) { /* ignore */ }
    const vol = () => (reduced.matches ? 0.16 : 0.26);
    function ensure() {
      if (ctx) return ctx;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      const comp = ctx.createDynamicsCompressor();
      master = ctx.createGain(); master.gain.value = muted ? 0 : vol();
      master.connect(comp); comp.connect(ctx.destination);
      noise = ctx.createBuffer(1, (ctx.sampleRate * 0.15) | 0, ctx.sampleRate);
      const ch = noise.getChannelData(0);
      for (let i = 0; i < ch.length; i++) ch[i] = rnd() * 2 - 1;
      return ctx;
    }
    function unlock(e) {
      if (unlocked || (e && e.isTrusted === false)) return;
      unlocked = true;
      for (const n of GESTURES) removeEventListener(n, unlock, true);
      if (ensure() && ctx.resume) ctx.resume();
    }
    const GESTURES = ["pointerdown", "keydown", "touchend", "mousedown"];
    for (const n of GESTURES) addEventListener(n, unlock, { capture: true, passive: true });
    function ready() {
      if (muted || !unlocked || !ensure()) return false;
      if (ctx.state !== "running") { if (ctx.resume) ctx.resume(); return false; }
      return true;
    }
    function tone(f, t, dur, type, v, f2) {
      const o = ctx.createOscillator(), g = ctx.createGain(), p = g.gain;
      o.type = type; o.frequency.setValueAtTime(f, t);
      if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
      p.setValueAtTime(0.0001, t); p.linearRampToValueAtTime(v, t + 0.01);
      p.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.03);
    }
    function whoosh(t) {
      const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      s.buffer = noise; f.type = "bandpass"; f.Q.value = 1.1;
      f.frequency.setValueAtTime(500, t); f.frequency.exponentialRampToValueAtTime(1500, t + 0.1);
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.16, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
      s.connect(f); f.connect(g); g.connect(master); s.start(t); s.stop(t + 0.13);
    }
    const PENT = [0, 2, 4, 7, 9];
    const sfx = {
      slide() {
        if (!ready()) return;
        const n = performance.now(); if (n - lastSlide < 50) return; lastSlide = n;
        whoosh(ctx.currentTime);
      },
      merge(v) {
        if (!ready()) return;
        const t = ctx.currentTime, s = Math.min(14, Math.max(0, Math.round(Math.log2(v)) - 2)),
          f = 220 * Math.pow(2, (PENT[s % 5] + 12 * ((s / 5) | 0)) / 12);
        tone(f, t, 0.24, "sine", 0.55); tone(f * 2, t, 0.16, "triangle", 0.16);
        if (s >= 4) tone(f * 1.5, t + 0.03, 0.22, "sine", 0.2);
      },
      spawn(dt) { if (ready()) tone(740, ctx.currentTime + dt, 0.06, "sine", 0.12, 980); },
      win() {
        if (!ready()) return;
        const t = ctx.currentTime + 0.18, N = [523.25, 659.25, 783.99, 1046.5, 1318.5];
        for (let i = 0; i < N.length; i++) {
          tone(N[i], t + i * 0.09, 0.35, "triangle", 0.3); tone(N[i], t + i * 0.09, 0.3, "sine", 0.2);
        }
        for (const f of [523.25, 783.99, 1046.5, 1318.5]) tone(f, t + 0.55, 1.0, "sine", 0.16);
      },
      over() {
        if (!ready()) return;
        const t = ctx.currentTime + 0.2, N = [329.63, 293.66, 261.63, 220], T = [0, 0.2, 0.4, 0.62];
        for (let i = 0; i < N.length; i++) tone(N[i], t + T[i], 0.45, "triangle", 0.3);
        tone(110, t + 0.62, 1.0, "sine", 0.28);
      },
    };
    document.addEventListener("visibilitychange", () => {
      if (!ctx) return;
      if (document.hidden) { if (ctx.suspend) ctx.suspend(); }
      else if (unlocked && ctx.resume) ctx.resume();
    });
    const mb = $("#btn-mute");
    function paintMute() {
      if (master) master.gain.value = muted ? 0 : vol();
      if (!mb) return;
      mb.setAttribute("aria-pressed", muted ? "true" : "false");
      mb.title = muted ? "Sound off - click to turn on" : "Sound on - click to mute";
    }
    if (mb) mb.addEventListener("click", ev => {
      unlock();
      muted = !muted;
      try { localStorage.setItem("hope2048.mute", muted ? "1" : "0"); } catch (e) { /* ignore */ }
      paintMute();
      if (!muted && ready()) tone(660, ctx.currentTime, 0.1, "sine", 0.3, 880);
      if (ev.detail > 0) mb.blur(); // pointer click: don't leave a focus ring behind
    });
    paintMute();

    /* ---------- tile events -> sounds (one batch per move) ---------- */
    let lw = innerWidth, lh = innerHeight;
    const txOf = s => {
      const i = s.indexOf("transform:"); if (i < 0) return "";
      const j = s.indexOf(";", i);
      return s.slice(i + 10, j < 0 ? s.length : j).replace(/\s+/g, "");
    };
    new MutationObserver(recs => {
      const resized = innerWidth !== lw || innerHeight !== lh; lw = innerWidth; lh = innerHeight;
      if (resized) return; // layout() re-places every tile on resize: not a move
      let slid = false, added = 0, top = 0;
      for (let i = 0; i < recs.length; i++) {
        const r = recs[i];
        if (r.type === "childList") { if (r.target === tilesEl) added += r.addedNodes.length; } // not a tile's text swap
        else if (r.attributeName === "class") {
          if ((r.oldValue || "").indexOf("pop") < 0 && r.target.classList.contains("pop")) {
            const v = parseInt(r.target.textContent, 10) || 0; if (v > top) top = v;
          }
        } else if (!slid && r.oldValue && r.oldValue.indexOf("translate(") >= 0) {
          if (txOf(r.oldValue) !== r.target.style.transform.replace(/\s+/g, "")) slid = true;
        }
      }
      if (added > 1) return; // new game: two spawns at once, silent
      if (slid) sfx.slide();
      if (top) sfx.merge(top);
      if (added === 1) sfx.spawn(top ? 0.07 : 0);
    }).observe(tilesEl, { childList: true, attributes: true, attributeFilter: ["style", "class"],
      attributeOldValue: true, subtree: true });

    /* ---------- win / game-over modal kind ---------- */
    if (endEl) {
      let kind = "";
      const fillStats = () => {
        const set = (id, v) => { const e = $(id); if (e) e.textContent = v; };
        set("#st-score", scoreEl.textContent); set("#st-best", bestEl ? bestEl.textContent : "0");
        let top = 0; const k = tilesEl.children;
        for (let i = 0; i < k.length; i++) { const v = parseInt(k[i].textContent, 10) || 0; if (v > top) top = v; }
        set("#st-top", top);
        endEl.classList.toggle("is-record", num(scoreEl) > 0 && num(scoreEl) >= num(bestEl));
      };
      new MutationObserver(() => {
        if (endEl.classList.contains("hidden")) {
          if (kind) { kind = ""; endEl.removeAttribute("data-kind"); boardEl.classList.remove("is-win", "is-over"); }
          return;
        }
        if (kind) return;
        const win = !!keepBtn && !keepBtn.classList.contains("hidden");
        kind = win ? "win" : "over";
        endEl.dataset.kind = kind; boardEl.classList.add(win ? "is-win" : "is-over");
        fillStats();
        if (win) sfx.win(); else sfx.over();
      }).observe(endEl, { attributes: true, attributeFilter: ["class"] });

      const fx = endEl.querySelector(".fx");
      if (fx) { // one-time confetti set; CSS animates transform/opacity only
        const cols = ["#ffd34d", "#ff7a59", "#e0457b", "#b45cf0", "#3fd0c0", "#86cc4a", "#4aa3ff"];
        for (let i = 0; i < 30; i++) {
          const s = document.createElement("i"), a = rnd() * 6.283, r = 70 + rnd() * 150;
          s.style.cssText = "--c:" + cols[i % cols.length] + ";--dx:" + ((Math.cos(a) * r) | 0) +
            "px;--dy:" + (((Math.sin(a) * r * 0.7) + 60) | 0) + "px;--r:" + ((rnd() * 720 - 360) | 0) +
            "deg;--dl:" + ((i % 6) * 40) + "ms";
          fx.appendChild(s);
        }
      }
    }
  } catch (e) { /* presentation is optional - never break the game */ }
})();
