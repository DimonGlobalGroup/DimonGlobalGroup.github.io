"use strict";
/* HOPE game shell — shared by every Entry game, our code, from scratch.
 *
 * Two inherited services, so no game hand-rolls either:
 *
 * 1) THE PAUSE-SCREEN MANUAL. renderControlCard() draws the live control
 *    card for the device in the player's hand, from the input adapter's
 *    own knowledge (HopeInput.controlCard). Change controller mid-pause
 *    and the card re-renders with the new pad's real button names.
 *
 * 2) TASTE TELEMETRY — Phase A (GAMES-DECISION.md). Play is recorded
 *    LOCALLY: events POST to this box's own /api/telemetry (same origin)
 *    and land in a JSONL store on the box. Nothing is transmitted
 *    anywhere else — curtain law. Family play is family data on
 *    Robert's hardware.
 *
 *    Event schema (v1) — one JSON object per line:
 *      {v:1, ts:<ISO>, game:<id>, event:"session_start"|"session_end"|
 *       "run_end"|"milestone", session:<id>, ...}
 *      run_end adds: outcome ("win"|"game_over"|"quit"), score,
 *       best_tile, moves, duration_s  — "where runs end".
 *      milestone adds: name (e.g. "tile-2048").
 */
(function (global) {
  const TELEMETRY_URL = "/api/telemetry";

  function send(obj) {
    const line = JSON.stringify(obj);
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(TELEMETRY_URL, line)) return;
    } catch (e) {}
    try {
      fetch(TELEMETRY_URL, { method: "POST", body: line, keepalive: true,
        headers: { "Content-Type": "application/json" } }).catch(() => {});
    } catch (e) {}
  }

  function session(gameId) {
    const id = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    const t0 = Date.now();
    let runStart = null, ended = false;
    const base = () => ({ v: 1, ts: new Date().toISOString(), game: gameId, session: id });
    send(Object.assign(base(), { event: "session_start" }));
    return {
      id,
      runBegin() { runStart = Date.now(); },
      runEnd(data) {
        send(Object.assign(base(), { event: "run_end",
          duration_s: runStart ? Math.round((Date.now() - runStart) / 1000) : 0 },
          data || {}));
        runStart = null;
      },
      milestone(name) { send(Object.assign(base(), { event: "milestone", name })); },
      end() {
        if (ended) return; ended = true;
        send(Object.assign(base(), { event: "session_end",
          duration_s: Math.round((Date.now() - t0) / 1000) }));
      },
    };
  }

  /* rows: [{action:"move", label:"Move tiles"}, ...] — the game's own
   * action names; the bindings come from the adapter, live. */
  function renderControlCard(container, rows) {
    if (!container || !global.HopeInput) return;
    const card = global.HopeInput.controlCard();
    const dev = global.HopeInput.activeDevice();
    container.innerHTML =
      `<div class="cc-head">🎮 ${card.device}${dev.kind === "gamepad" ? " — connected" : ""}</div>` +
      rows.map(r => {
        const b = card.labels[r.action] || "—";
        return `<div class="cc-row"><span class="cc-btn">${b}</span><span class="cc-act">${r.label}</span></div>`;
      }).join("");
  }

  /* Watch for device changes while a card is on screen (e.g. paused) so
   * the manual always describes the device currently in hand. */
  function bindControlCard(container, rows) {
    renderControlCard(container, rows);
    if (global.HopeInput) global.HopeInput.on("devicechange", () => renderControlCard(container, rows));
  }

  global.HopeShell = { telemetry: { session, send }, renderControlCard, bindControlCard };
})(window);
