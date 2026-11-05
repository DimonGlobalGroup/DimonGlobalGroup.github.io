"use strict";
/* Falling Blocks — REBUILD (2026-11-04). Our own from-scratch
 * implementation of the falling-blocks mechanic class: the mechanics
 * are rebuilt; nothing is copied from any existing game's code, art,
 * music, names, or level expression.
 *
 * Why this rebuild exists: the previous build's collapse step removed
 * full rows one at a time (splice + unshift per row, descending),
 * which deletes the WRONG row on multi-line clears — clearing rows
 * 18+19 deleted rows 19 and 17 and kept the full row 18 (Laboratory
 * Arena 3 bench finding; A3 twin fidelity record). This rebuild
 * adopts the fix candidate PROP-A3-8fa654fe7cc8 through the game's
 * gauntlet: the collapse removes ALL full rows at once and inserts
 * the same count of empty rows at the top, so settled cells are
 * conserved exactly. Every other mechanic is pinned to the previous
 * build's behavior (same matrices, spawns, kick table, 7-bag,
 * gravity curve, lock delay, scoring) and is proven so by the
 * gauntlet's parallel run on the twin corpora.
 *
 * Structure: a pure, DOM-free engine core (loadable in Node for the
 * benches) plus the DOM game built on it. Rendering is pooled DOM
 * blocks, transform-positioned — crisp at any DPI, 60 fps motion,
 * tuned for Pi-class hardware, no per-frame allocation in the hot
 * path. Input arrives ONLY through the shared adapter (HopeInput) —
 * keyboard, touch swipe, TV remote, and any gamepad all arrive as
 * abstract actions. The pause screen is the manual: the shell
 * renders the control card live from the adapter. Play telemetry is
 * Phase A local-only (shell.js).
 *
 * Mechanics (ours, standard for the class): 10x20 well, seven piece
 * classes, 7-bag randomizer, gravity + lock delay (500 ms, move/
 * rotate resets capped at 15), line clears scored 100/300/500/800 x
 * level (a single lock can complete at most 4 rows in legal play;
 * beyond that the Arena 3 extension law applies — each extra row
 * pays the table's final per-line step, +300), level up every 10
 * lines, soft drop +1/cell, hard drop +2/cell. */

/* ================= pure engine core (no DOM) ================= */
const COLS = 10, ROWS = 20;
const LOCK_MS = 500, MAX_LOCK_RESETS = 15, CLEAR_MS = 140;
const CLEAR_POINTS = [0, 100, 300, 500, 800];

/* Points for one lock clearing n rows (level multiplier is the
 * caller's). n <= 4 is the game's own table, untouched. n >= 5 is
 * unreachable in legal play (a lock adds 4 cells and full rows clear
 * immediately, so at most 4 rows can complete per lock); the
 * extension matches Arena 3's law so pre-filled wells used by the
 * benches score sanely instead of reading off the table. */
function clearPoints(n) {
  if (n <= 4) return CLEAR_POINTS[n];
  return CLEAR_POINTS[4] + 300 * (n - 4);
}

/* Piece matrices — block shapes of the class, defined by us.
 * Rotations are computed from the base matrix (clockwise
 * quarter-turns). */
const BASE = {
  I: [[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]],
  O: [[1,1],[1,1]],
  T: [[0,1,0],[1,1,1],[0,0,0]],
  S: [[0,1,1],[1,1,0],[0,0,0]],
  Z: [[1,1,0],[0,1,1],[0,0,0]],
  J: [[1,0,0],[1,1,1],[0,0,0]],
  L: [[0,0,1],[1,1,1],[0,0,0]],
};
const SPAWN = { I: {x:3, y:-1}, O: {x:4, y:0}, T: {x:3, y:0}, S: {x:3, y:0},
                Z: {x:3, y:0}, J: {x:3, y:0}, L: {x:3, y:0} };
const TYPES = Object.keys(BASE);
function rotationsOf(m) {
  const out = [m];
  for (let k = 1; k < 4; k++) {
    const p = out[k - 1];
    out.push(p[0].map((_, i) => p.map(row => row[i]).reverse()));
  }
  return out;
}
const ROTS = {}; for (const t of TYPES) ROTS[t] = rotationsOf(BASE[t]);
function cellsOf(type, rot) {
  const m = ROTS[type][rot & 3], out = [];
  for (let y = 0; y < m.length; y++) for (let x = 0; x < m[y].length; x++)
    if (m[y][x]) out.push([x, y]);
  return out;
}
/* Kick offsets tried in order on a rotation that doesn't fit plain. */
const KICKS = [[0,0],[-1,0],[1,0],[-2,0],[2,0],[0,-1],[-1,-1],[1,-1]];

function emptyWell() {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(null));
}
function collidesIn(well, type, rot, ox, oy) {
  for (const [cx, cy] of cellsOf(type, rot)) {
    const wx = ox + cx, wy = oy + cy;
    if (wx < 0 || wx >= COLS || wy >= ROWS) return true;
    if (wy >= 0 && well[wy][wx]) return true;
  }
  return false;
}
function dropDistanceIn(well, type, rot, x, y) {
  let d = 0;
  while (!collidesIn(well, type, rot, x, y + d + 1)) d++;
  return d;
}
/* Write a piece's cells into a copy of the well. Cells above row 0
 * mark the lock as a lock-out and are not written. */
function placePiece(well, type, rot, x, y) {
  const next = well.map(r => r.slice());
  let lockedOut = false;
  for (const [cx, cy] of cellsOf(type, rot)) {
    const wx = x + cx, wy = y + cy;
    if (wy < 0) { lockedOut = true; continue; }
    next[wy][wx] = type;
  }
  return { lockedOut, well: next };
}
function fullRowsOf(well) {
  const full = [];
  for (let y = 0; y < ROWS; y++) if (well[y].every(c => c)) full.push(y);
  return full;
}
/* THE COLLAPSE — the adopted fix. All full rows are removed at
 * once; the same count of empty rows is inserted at the top. Every
 * settled cell keeps its identity and its column, and shifts down
 * by exactly the number of cleared rows beneath it. Cells are
 * conserved: filled(after) = filled(before) - 10 * cleared. */
function collapseRows(well, full) {
  if (!full.length) return well;
  const drop = new Set(full);
  const kept = well.filter((_, y) => !drop.has(y));
  while (kept.length < ROWS) kept.unshift(Array(COLS).fill(null));
  return kept;
}
/* One full lock, composed exactly as the game performs it:
 * place, then (unless locked out) find full rows and collapse. */
function applyLock(well, type, rot, x, y) {
  const placed = placePiece(well, type, rot, x, y);
  if (placed.lockedOut) return { lockedOut: true, cleared: 0, well: placed.well };
  const full = fullRowsOf(placed.well);
  return { lockedOut: false, cleared: full.length,
           well: collapseRows(placed.well, full) };
}
function gravityForLevel(level) {
  return Math.max(60, Math.round(800 * Math.pow(0.82, level - 1)));
}

const FB_CORE = { COLS, ROWS, LOCK_MS, MAX_LOCK_RESETS, CLEAR_MS,
  CLEAR_POINTS, clearPoints, BASE, SPAWN, TYPES, ROTS, cellsOf, KICKS,
  emptyWell, collidesIn, dropDistanceIn, placePiece, fullRowsOf,
  collapseRows, applyLock, gravityForLevel };
if (typeof module !== "undefined" && module.exports) module.exports = FB_CORE;

/* ================= DOM game ================= */
if (typeof document !== "undefined") {
const $ = s => document.querySelector(s);

/* ---------- state ---------- */
let well = emptyWell();
let active = null, queue = [], bag = [];
let score = 0, best = 0, lines = 0, level = 1, pieces = 0;
let over = false, paused = false, busy = false, runActive = false;
let dropAcc = 0, lastTs = null, groundedSince = null, lockResets = 0;
let softUntil = 0, gravityOverride = null, clearedOnce = false;
let clearingRows = new Set();
best = +(localStorage.getItem("hopefalling.best") || 0);

const session = window.HopeShell ? HopeShell.telemetry.session("falling-blocks") : null;
const boardEl = $("#board"), cellsEl = $("#cells"), blocksEl = $("#blocks");

/* ---------- layout ---------- */
let cellPx = 24;
function layout() {
  const W = boardEl.clientWidth || 240;
  cellPx = W / COLS;
  cellsEl.innerHTML = "";
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const d = document.createElement("div");
    d.className = "cell";
    d.style.width = d.style.height = cellPx + "px";
    d.style.transform = `translate(${c * cellPx}px, ${r * cellPx}px)`;
    cellsEl.appendChild(d);
  }
  renderWell(); renderActive(); renderNext();
}

/* ---------- rendering (pooled DOM blocks) ---------- */
const wellEls = new Map();   // "x,y" -> settled block element
function key(x, y) { return x + "," + y; }
function makeBlock(cls) {
  const el = document.createElement("div");
  el.className = "blk " + cls;
  el.style.width = el.style.height = cellPx + "px";
  blocksEl.appendChild(el);
  return el;
}
function renderWell() {
  const seen = new Set();
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    const t = well[y][x]; if (!t) continue;
    const k = key(x, y); seen.add(k);
    let el = wellEls.get(k);
    if (!el) { el = makeBlock("p" + t); wellEls.set(k, el); }
    el.className = "blk p" + t + (clearingRows.has(y) ? " clearing" : "");
    el.style.width = el.style.height = cellPx + "px";
    el.style.transform = `translate(${x * cellPx}px, ${y * cellPx}px)`;
  }
  for (const [k, el] of [...wellEls]) if (!seen.has(k)) { el.remove(); wellEls.delete(k); }
}
let activeEls = [], ghostEls = [];
function dropDistance() {
  if (!active) return 0;
  return dropDistanceIn(well, active.type, active.rot, active.x, active.y);
}
function renderActive() {
  for (const el of activeEls) el.remove(); activeEls = [];
  for (const el of ghostEls) el.remove(); ghostEls = [];
  if (!active) return;
  const cells = cellsOf(active.type, active.rot);
  const gd = dropDistance();
  if (gd > 0) for (const [cx, cy] of cells) {
    const gy = active.y + gd + cy; if (gy < 0) continue;
    const el = makeBlock("p" + active.type + " ghost");
    el.style.transform = `translate(${(active.x + cx) * cellPx}px, ${gy * cellPx}px)`;
    ghostEls.push(el);
  }
  for (const [cx, cy] of cells) {
    const wy = active.y + cy; if (wy < 0) continue;
    const el = makeBlock("p" + active.type);
    el.style.transform = `translate(${(active.x + cx) * cellPx}px, ${wy * cellPx}px)`;
    activeEls.push(el);
  }
}
function renderNext() {
  const box = $("#next-box"); box.innerHTML = "";
  const t = queue[0]; if (!t) return;
  const cells = cellsOf(t, 0);
  const xs = cells.map(c => c[0]), ys = cells.map(c => c[1]);
  const w = Math.max(...xs) - Math.min(...xs) + 1, h = Math.max(...ys) - Math.min(...ys) + 1;
  const s = Math.min(96 / 4, 22);   // mini block px
  const ox = (104 - w * s) / 2 - Math.min(...xs) * s, oy = (104 - h * s) / 2 - Math.min(...ys) * s;
  for (const [cx, cy] of cells) {
    const el = document.createElement("div");
    el.className = "nblk p" + t;
    el.style.width = el.style.height = s + "px";
    el.style.left = (ox + cx * s) + "px"; el.style.top = (oy + cy * s) + "px";
    box.appendChild(el);
  }
}
function updateHud() {
  $("#score").textContent = score;
  if (score > best) { best = score; localStorage.setItem("hopefalling.best", best); }
  $("#best").textContent = best;
  $("#lines").textContent = lines;
  $("#level").textContent = level;
}

/* ---------- engine ---------- */
function collides(type, rot, ox, oy) { return collidesIn(well, type, rot, ox, oy); }
function refillQueue() {
  while (queue.length < 4) {
    if (!bag.length) {
      bag = TYPES.slice();
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [bag[i], bag[j]] = [bag[j], bag[i]];
      }
    }
    queue.push(bag.pop());
  }
}
function spawn() {
  refillQueue();
  const type = queue.shift(); refillQueue();
  const s = SPAWN[type];
  active = { type, rot: 0, x: s.x, y: s.y };
  dropAcc = 0; groundedSince = null; lockResets = 0;
  renderActive(); renderNext();
  if (collides(type, 0, s.x, s.y)) gameOver();
}
function gravityMs() {
  if (gravityOverride != null) return gravityOverride;
  return gravityForLevel(level);
}
function noteSuccessfulShift() {
  if (groundedSince != null && lockResets < MAX_LOCK_RESETS) {
    groundedSince = performance.now(); lockResets++;
  }
}
function tryMove(dx, dy) {
  if (!active || over || paused || busy) return false;
  if (collides(active.type, active.rot, active.x + dx, active.y + dy)) return false;
  active.x += dx; active.y += dy;
  noteSuccessfulShift();
  renderActive();
  return true;
}
function rotate() {
  if (!active || over || paused || busy) return false;
  const nr = (active.rot + 1) & 3;
  for (const [kx, ky] of KICKS) {
    if (!collides(active.type, nr, active.x + kx, active.y + ky)) {
      active.rot = nr; active.x += kx; active.y += ky;
      noteSuccessfulShift();
      renderActive();
      return true;
    }
  }
  return false;
}
function softStep() {
  if (!active || over || paused || busy) return;
  softUntil = performance.now() + 400; dropAcc = 0;
  if (tryMove(0, 1)) { score += 1; updateHud(); }
}
function hardDrop() {
  if (!active || over || paused || busy) return;
  const d = dropDistance();
  active.y += d; score += d * 2;
  updateHud();
  lockPiece();
}
function lockPiece() {
  if (!active) return;
  const placed = placePiece(well, active.type, active.rot, active.x, active.y);
  well = placed.well;
  pieces++;
  active = null; renderActive();
  if (placed.lockedOut) { renderWell(); gameOver(); return; }
  const full = fullRowsOf(well);
  if (!full.length) { renderWell(); spawn(); return; }
  /* clear: flash, then collapse — all full rows removed at once */
  busy = true; clearingRows = new Set(full);
  score += clearPoints(full.length) * level;
  lines += full.length;
  level = Math.floor(lines / 10) + 1;
  if (session) {
    if (!clearedOnce) { clearedOnce = true; session.milestone("first-line"); }
    if (full.length === 4) session.milestone("quad-line");
  }
  updateHud(); renderWell();
  setTimeout(() => {
    well = collapseRows(well, full);
    clearingRows = new Set(); busy = false;
    renderWell();
    spawn();
  }, CLEAR_MS);
}
function gameOver() {
  over = true; runActive = false;
  if (session) session.runEnd({ outcome: "game_over", score, lines, level, moves: pieces });
  $("#end-sub").textContent =
    `Final score ${score} · ${lines} lines · level ${level} · ${pieces} pieces placed.`;
  $("#ov-end").classList.remove("hidden");
  $("#btn-again").focus();
}
function newGame() {
  if (runActive && pieces > 0 && session)
    session.runEnd({ outcome: "quit", score, lines, level, moves: pieces });
  well = emptyWell();
  for (const el of wellEls.values()) el.remove(); wellEls.clear();
  queue = []; bag = []; active = null;
  score = 0; lines = 0; level = 1; pieces = 0;
  over = false; paused = false; busy = false; clearedOnce = false;
  clearingRows = new Set();
  dropAcc = 0; groundedSince = null; lockResets = 0;
  $("#ov-pause").classList.add("hidden"); $("#ov-end").classList.add("hidden");
  runActive = true;
  if (session) session.runBegin();
  updateHud(); renderWell();
  spawn();
}

/* gravity + lock delay, driven by timestamps so rAF and the interval
 * backstop can share it safely (the adapter's headless lesson). */
function step(ts) {
  if (lastTs == null) lastTs = ts;
  const dt = Math.min(250, ts - lastTs); lastTs = ts;
  if (!active || paused || over || busy) return;
  const interval = (ts < softUntil) ? 40 : gravityMs();
  dropAcc += dt;
  while (dropAcc >= interval) {
    dropAcc -= interval;
    if (!tryMove(0, 1)) { dropAcc = 0; break; }
  }
  if (!collides(active.type, active.rot, active.x, active.y + 1)) {
    groundedSince = null;
  } else {
    if (groundedSince == null) groundedSince = ts;
    else if (ts - groundedSince >= LOCK_MS) { lockPiece(); }
  }
}
(function loop(ts) { step(ts || performance.now()); requestAnimationFrame(loop); })();
setInterval(() => step(performance.now()), 50);

/* ---------- overlays: pause = the manual ---------- */
const CARD_ROWS = [
  { action: "move", label: "Move piece · ↓ soft drop" },
  { action: "confirm", label: "Choose (in menus)" },
  { action: "action1", label: "Rotate" },
  { action: "action2", label: "Hard drop" },
  { action: "pause", label: "Pause / this manual" },
  { action: "back", label: "Resume / close" },
];
function togglePause(force) {
  if (over) return;
  paused = force !== undefined ? force : !paused;
  lastTs = null;   // don't let the pause duration hit the gravity clock
  $("#ov-pause").classList.toggle("hidden", !paused);
  if (paused) {
    if (window.HopeShell) HopeShell.renderControlCard($("#control-card"), CARD_ROWS);
    $("#btn-resume").focus();
  }
}

/* ---------- input: ONLY the shared adapter ---------- */
function inputMove(dir) {
  if (dir === "left") tryMove(-1, 0);
  else if (dir === "right") tryMove(1, 0);
  else if (dir === "down") softStep();
  /* "up" carries no action in this game */
}
HopeInput.on("move", ({ dir }) => inputMove(dir));
HopeInput.on("action1", () => rotate());
HopeInput.on("action2", () => hardDrop());
HopeInput.on("pause", () => {
  if (!$("#ov-end").classList.contains("hidden")) return;
  togglePause();
});
HopeInput.on("back", () => { if (paused) togglePause(false); });
HopeInput.on("confirm", () => {
  const a = document.activeElement;
  const overlayOpen = !$("#ov-pause").classList.contains("hidden") || !$("#ov-end").classList.contains("hidden");
  if (overlayOpen && a && (a.tagName === "BUTTON" || a.tagName === "A")) a.click();
});
HopeInput.bindSwipe($("#board"));
if (window.HopeShell) HopeShell.bindControlCard($("#control-card"), CARD_ROWS);

/* ---------- buttons ---------- */
$("#btn-pause").addEventListener("click", () => togglePause());
$("#btn-new").addEventListener("click", () => newGame());
$("#btn-resume").addEventListener("click", () => togglePause(false));
$("#btn-restart").addEventListener("click", () => newGame());
$("#btn-again").addEventListener("click", () => newGame());

/* ---------- boot ---------- */
window.addEventListener("resize", layout);
window.addEventListener("pagehide", () => { if (session) session.end(); });
$("#best").textContent = best;
layout();
newGame();

/* Read-only state handle — the headless proofs (and any future bot
 * check from the brain-builds-games gate) drive the game through
 * it. The debug core handle exposes the pure engine so benches can
 * run the game's own collapse law without a DOM. */
window.GAMEFB = {
  state() {
    return { score, best, lines, level, pieces, over, paused,
      well: well.map(r => r.map(c => c || ".").join("")),
      active: active ? { type: active.type, rot: active.rot, x: active.x, y: active.y,
        cells: cellsOf(active.type, active.rot).map(([cx, cy]) => [active.x + cx, active.y + cy]) } : null,
      next: queue[0] || null };
  },
  newGame, togglePause, rotate, hardDrop, inputMove,
  debug: {
    setQueue(types) { queue = types.slice(); renderNext(); },
    setWell(rows) {
      well = rows.map(r => r.split("").map(ch => (ch === "." ? null : ch)));
      clearingRows = new Set(); renderWell(); renderActive();
    },
    setGravity(ms) { gravityOverride = ms; },
    core: FB_CORE,
  },
};
}
