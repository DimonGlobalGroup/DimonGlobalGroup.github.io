"use strict";
/* 2048 — Refined. Our own from-scratch implementation of the sliding-tile
 * mechanic (mechanics are rebuilt; nothing is copied from any existing
 * game's code, art, or assets). DOM tiles, transform-animated.
 * Input comes ONLY through the shared adapter (HopeInput) — keyboard,
 * touch swipe, TV remote, and any gamepad all arrive as abstract actions.
 * The pause screen is the manual: the shell renders the control card
 * live from the adapter. Play telemetry is Phase A local-only (shell.js). */
const $ = s => document.querySelector(s);
const N = 4, ANIM_MS = 125;
const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

let grid;
let tiles = [], score = 0, best = 0, moves = 0, won = false, over = false,
    paused = false, busy = false, runActive = false, nextId = 1;
best = +(localStorage.getItem("hope2048.best") || 0);

const session = window.HopeShell ? HopeShell.telemetry.session("2048-refined") : null;
const boardEl = $("#board"), tilesEl = $("#tiles"), cellsEl = $("#cells");

/* ---------- layout (resolution-independent: board scales, tiles follow) ---------- */
let cellPx = 100, gapPx = 10;
function layout() {
  const W = boardEl.clientWidth;
  gapPx = Math.max(6, Math.round(W * 0.022));
  cellPx = (W - gapPx * 5) / 4;
  cellsEl.innerHTML = "";
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    const d = document.createElement("div");
    d.className = "cell";
    d.style.width = d.style.height = cellPx + "px";
    d.style.transform = `translate(${gapPx + c * (cellPx + gapPx)}px, ${gapPx + r * (cellPx + gapPx)}px)`;
    cellsEl.appendChild(d);
  }
  for (const t of tiles) place(t, false);
}
function place(t, animate = true) {
  if (!animate) t.el.style.transition = "none";
  t.el.style.width = t.el.style.height = cellPx + "px";
  t.el.style.transform = `translate(${gapPx + t.c * (cellPx + gapPx)}px, ${gapPx + t.r * (cellPx + gapPx)}px)`;
  t.el.style.fontSize = (cellPx * (t.v < 100 ? 0.42 : t.v < 1000 ? 0.34 : 0.27)) + "px";
  if (!animate) { void t.el.offsetWidth; t.el.style.transition = ""; }
}

/* ---------- tiles ---------- */
function makeTile(v, r, c, isNew) {
  const el = document.createElement("div");
  el.className = "tile " + (v > 2048 ? "tsuper" : "t" + v) + (isNew ? " new" : "");
  el.textContent = v;
  tilesEl.appendChild(el);
  const t = { id: nextId++, v, r, c, el, dead: false, pendingV: 0 };
  place(t, false);
  return t;
}
function retile(t) {
  t.el.className = "tile " + (t.v > 2048 ? "tsuper" : "t" + t.v);
  t.el.textContent = t.v;
  place(t, false);
}
function spawn() {
  const empty = [];
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (!grid[r][c]) empty.push([r, c]);
  if (!empty.length) return;
  const [r, c] = empty[Math.floor(Math.random() * empty.length)];
  const t = makeTile(Math.random() < 0.9 ? 2 : 4, r, c, true);
  grid[r][c] = t; tiles.push(t);
}
function maxTile() { return tiles.reduce((m, t) => Math.max(m, t.v), 0); }
function runData(outcome) {
  return { outcome, score, best_tile: maxTile(), moves };
}

/* ---------- game flow ---------- */
function newGame() {
  if (runActive && moves > 0 && session) session.runEnd(runData("quit"));
  tilesEl.innerHTML = ""; tiles = []; nextId = 1;
  grid = Array.from({ length: N }, () => Array(N).fill(null));
  score = 0; moves = 0; won = false; over = false; paused = false; busy = false;
  spawn(); spawn();
  runActive = true;
  if (session) session.runBegin();
  $("#ov-pause").classList.add("hidden"); $("#ov-end").classList.add("hidden");
  updateScore();
}
function updateScore() {
  $("#score").textContent = score;
  if (score > best) { best = score; localStorage.setItem("hope2048.best", best); }
  $("#best").textContent = best;
}

function move(dir) {
  if (busy || paused || over) return;
  const d = DIRS[dir]; if (!d) return;
  const [dx, dy] = d;
  const xs = [0, 1, 2, 3], ys = [0, 1, 2, 3];
  if (dx === 1) xs.reverse(); if (dy === 1) ys.reverse();
  const g = grid.map(row => row.slice());
  const mergedInto = new Set(), merges = [];
  let changed = false, made2048 = false;
  for (const y of ys) for (const x of xs) {
    const t = g[y][x]; if (!t || t.dead) continue;
    let nx = x, ny = y;
    while (true) {
      const tx = nx + dx, ty = ny + dy;
      if (tx < 0 || tx >= N || ty < 0 || ty >= N) break;
      const occ = g[ty][tx];
      if (!occ) { nx = tx; ny = ty; continue; }
      if (occ.v === t.v && !mergedInto.has(occ.id) && !mergedInto.has(t.id)) {
        g[y][x] = null;
        t.r = ty; t.c = tx; t.dead = true;
        occ.pendingV = occ.v * 2;
        mergedInto.add(occ.id);
        merges.push(occ);
        score += occ.pendingV;
        if (occ.pendingV === 2048) made2048 = true;
        changed = true;
      }
      break;
    }
    if (!t.dead && (nx !== x || ny !== y)) {
      g[y][x] = null; g[ny][nx] = t; t.r = ny; t.c = nx; changed = true;
    }
  }
  if (!changed) return;
  busy = true; moves++;
  grid = g;
  for (const t of tiles) place(t); // dead tiles also slide into their merge target
  updateScore();
  setTimeout(() => {
    for (const occ of merges) { occ.v = occ.pendingV; occ.pendingV = 0; retile(occ); occ.el.classList.add("pop"); }
    tiles = tiles.filter(t => { if (t.dead) { t.el.remove(); return false; } return true; });
    spawn();
    busy = false;
    if (made2048 && !won) {
      won = true;
      if (session) { session.milestone("tile-2048"); session.runEnd(runData("win")); }
      showEnd(true);
    } else if (!movesLeft()) {
      over = true; runActive = false;
      if (session) session.runEnd(runData("game_over"));
      showEnd(false);
    }
  }, ANIM_MS + 15);
}
function movesLeft() {
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    const t = grid[r][c];
    if (!t) return true;
    if (c + 1 < N && grid[r][c + 1] && grid[r][c + 1].v === t.v) return true;
    if (r + 1 < N && grid[r + 1][c] && grid[r + 1][c].v === t.v) return true;
  }
  return false;
}

/* ---------- overlays: pause = the manual ---------- */
const CARD_ROWS = [
  { action: "move", label: "Move tiles" },
  { action: "confirm", label: "Choose (in menus)" },
  { action: "pause", label: "Pause / this manual" },
  { action: "back", label: "Resume / close" },
];
function togglePause(force) {
  if (over) return;
  paused = force !== undefined ? force : !paused;
  $("#ov-pause").classList.toggle("hidden", !paused);
  if (paused) {
    if (window.HopeShell) HopeShell.renderControlCard($("#control-card"), CARD_ROWS);
    $("#btn-resume").focus();
  }
}
function showEnd(isWin) {
  $("#end-title").textContent = isWin ? "🎉 You made 2048!" : "No moves left";
  $("#end-sub").textContent = isWin
    ? `Score ${score} · ${moves} moves. Keep going for a bigger tile, or start fresh.`
    : `Final score ${score} · best tile ${maxTile()} · ${moves} moves.`;
  $("#btn-keepgoing").classList.toggle("hidden", !isWin);
  $("#ov-end").classList.remove("hidden");
  (isWin ? $("#btn-keepgoing") : $("#btn-again")).focus();
}

/* ---------- input: ONLY the shared adapter ---------- */
HopeInput.on("move", ({ dir }) => move(dir));
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
$("#btn-keepgoing").addEventListener("click", () => $("#ov-end").classList.add("hidden"));

/* ---------- boot ---------- */
window.addEventListener("resize", layout);
window.addEventListener("pagehide", () => { if (session) session.end(); });
$("#best").textContent = best;
layout();
newGame();

/* Read-only state handle — the headless proofs (and any future bot check
 * from the brain-builds-games gate) drive the game through it. */
window.GAME2048 = {
  state() {
    return { score, best, won, over, paused, moves,
      tiles: tiles.map(t => ({ v: t.v, r: t.r, c: t.c })),
      tileSum: tiles.reduce((s, t) => s + t.v, 0) };
  },
  move, newGame, togglePause,
};
