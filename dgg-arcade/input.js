"use strict";
/* HOPE input adapter — universal plug-and-play, our code, from scratch.
 *
 * Doctrine (GAMES-DECISION.md): any controller — wired USB or Bluetooth —
 * plugged into the box just works with every game. No per-game programming,
 * no manual mapping required from the player, ever. Games declare only
 * ABSTRACT actions; this adapter translates every source into them:
 *
 *   actions:  move(dir) · confirm · back · pause · action1 · action2
 *   sources:  gamepad (standard mapping → per-family quirks → generic
 *             fallback) · keyboard · TV-remote keys · touch (swipe + taps)
 *
 * Hot-plug: a pad appearing/disappearing updates the #pad-status indicator
 * and fires "devicechange"; losing a pad mid-session falls back to
 * keyboard/touch without breaking anything.
 *
 * Manual remapping: a data hook exists (localStorage overrides, applied
 * automatically) for people who WANT it — it is never required, and v1
 * ships no remap UI (the settings corner is a later nicety).
 *
 * The pause-screen manual (shell.js) renders its control card from THIS
 * module's knowledge of the active device, so the labels always name the
 * buttons on the device actually in the player's hand.
 */
(function (global) {
  const DEADZONE = 0.45;        // left-stick threshold for a move
  const REPEAT_FIRST_MS = 280;  // hold-to-repeat: first repeat delay
  const REPEAT_MS = 165;        // hold-to-repeat: subsequent interval

  /* Button-name families — the names printed on the player's own pad.
   * Standard-mapping indices are the same for all of them; only the
   * NAMES differ (and Nintendo prints A/B in swapped positions — the
   * labels follow the pad's own printing, which is the point). */
  const FAMILIES = {
    xbox:        { confirm: "A", back: "B", action1: "X", action2: "Y", pause: "Menu",    move: "Left stick / D-pad" },
    playstation: { confirm: "✕", back: "○", action1: "□", action2: "△", pause: "Options", move: "Left stick / D-pad" },
    nintendo:    { confirm: "A", back: "B", action1: "Y", action2: "X", pause: "+",       move: "Left stick / D-pad" },
    generic:     { confirm: "Button 1", back: "Button 2", action1: "Button 3", action2: "Button 4", pause: "Start", move: "Stick / D-pad" },
  };
  const STD_BUTTONS = { confirm: 0, back: 1, action1: 2, action2: 3, pause: 9 };

  /* Quirks table — starts SMALL and grows only from pads actually tested
   * on the box (the Idaho plug test feeds it). v1 entries resolve the
   * naming family from the pad's id string; the descriptor shape also
   * carries optional index overrides (buttons / dpad / moveAxes /
   * hatAxis) so a genuinely non-standard layout is a data row, not code. */
  const QUIRKS = [
    /* Order matters (R1-1 proof find): the PlayStation pattern's broad
     * "wireless controller" alternative also matches the Xbox Wireless
     * Controller's real id string, so the xbox/nintendo patterns must
     * resolve first. Sony pads carry sony/dualsense/054c tokens and
     * still land on playstation below. */
    { match: /xbox|microsoft|045e/i,                                           family: "xbox" },
    { match: /nintendo|pro controller|joy-con|057e/i,                          family: "nintendo" },
    { match: /dualsense|dualshock|wireless controller|sony|playstation|054c/i, family: "playstation" },
  ];

  function resolveLayout(id) {
    const lay = {
      family: "generic", names: FAMILIES.generic,
      buttons: Object.assign({}, STD_BUTTONS),
      dpad: [12, 13, 14, 15],           // up, down, left, right
      moveAxes: [0, 1],                 // left stick
      hatAxis: 9,                       // POV hat fallback (cheap pads)
    };
    for (const q of QUIRKS) {
      if (q.match.test(id || "")) {
        lay.family = q.family;
        lay.names = FAMILIES[q.family] || FAMILIES.generic;
        if (q.buttons) Object.assign(lay.buttons, q.buttons);
        if (q.dpad) lay.dpad = q.dpad.slice();
        if (q.moveAxes) lay.moveAxes = q.moveAxes.slice();
        if (q.hatAxis !== undefined) lay.hatAxis = q.hatAxis;
        break;
      }
    }
    if ((id || "").toLowerCase().includes("standard gamepad") || lay.family === "generic") {
      // Standard-mapping pads that matched no family keep standard indices;
      // naming defaults to the Xbox-style set the standard mapping is
      // modeled on, unless a quirk already named the family.
      if (lay.family === "generic" && /standard/i.test(id || "")) {
        lay.family = "xbox"; lay.names = FAMILIES.xbox;
      }
    }
    return lay;
  }

  /* ---- optional user remap (never required) ---- */
  const REMAP_KEY = "hope.input.remap.v1";
  function loadRemap() {
    try { return JSON.parse(global.localStorage.getItem(REMAP_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function applyRemap(lay) {
    const r = loadRemap();
    if (r && r.pad) for (const a of Object.keys(r.pad)) if (a in lay.buttons) lay.buttons[a] = r.pad[a];
    return lay;
  }

  /* ---- state ---- */
  const handlers = { move: [], confirm: [], back: [], pause: [], action1: [], action2: [], devicechange: [] };
  let active = { kind: "keyboard", name: "Keyboard", family: null, layout: null };
  let padState = new Map();   // index -> {layout, prevBtns:[], dir, nextRepeat}
  let indicator = null;
  let polling = false;

  function emit(action, payload) {
    for (const h of handlers[action] || []) { try { h(payload || {}); } catch (e) {} }
  }
  function setActive(kind, name, family, layout) {
    const changed = active.kind !== kind || active.name !== name;
    active = { kind, name, family, layout };
    if (changed) emit("devicechange", { device: activeDevice() });
    updateIndicator();
  }
  function activeDevice() {
    return { kind: active.kind, name: active.name, family: active.family };
  }

  /* ---- controller-ready indicator ---- */
  function ensureIndicator() {
    if (indicator) return indicator;
    indicator = document.getElementById("pad-status");
    if (!indicator) {
      indicator = document.createElement("div");
      indicator.id = "pad-status";
      document.body.appendChild(indicator);
      const st = document.createElement("style");
      st.textContent = "#pad-status{position:fixed;right:.7rem;bottom:.7rem;z-index:40;" +
        "background:rgba(21,26,36,.92);color:#9aa7ba;border:1px solid #1c2331;border-radius:2rem;" +
        "padding:.3rem .8rem;font-size:.8rem;font-family:system-ui,sans-serif;pointer-events:none;" +
        "opacity:0;transition:opacity .25s}#pad-status.on{opacity:1}#pad-status b{color:#7ee787}";
      document.head.appendChild(st);
    }
    return indicator;
  }
  function shortName(id) {
    return (id || "Controller").replace(/\s*\((?:standard gamepad|vendor|product).*$/i, "").trim().slice(0, 42) || "Controller";
  }
  function updateIndicator() {
    const el = ensureIndicator();
    if (active.kind === "gamepad") {
      el.innerHTML = "🎮 <b>" + shortName(active.name) + "</b> ready";
      el.classList.add("on");
    } else {
      el.classList.remove("on");
    }
  }

  /* ---- gamepad polling ---- */
  function hatDir(v) {
    // POV hat: discrete values around the unit circle, -1 = up.
    if (typeof v !== "number" || v < -1.2 || v > 1.2) return null;
    const stops = [[-1, "up"], [-0.714, "up-right"], [-0.428, "right"], [-0.143, "down-right"],
                   [0.143, "down"], [0.428, "down-left"], [0.714, "left"], [1, "up-left"]];
    for (const [val, dir] of stops) if (Math.abs(v - val) < 0.13) return dir;
    return null;
  }
  function pollPads(now) {
    const pads = (navigator.getGamepads ? navigator.getGamepads() : []) || [];
    let anyPad = false;
    for (const pad of pads) {
      if (!pad || !pad.connected) continue;
      anyPad = true;
      let st = padState.get(pad.index);
      if (!st) {
        st = { layout: applyRemap(resolveLayout(pad.id)), prevBtns: [], dir: null, nextRepeat: 0 };
        padState.set(pad.index, st);
        setActive("gamepad", pad.id, st.layout.family, st.layout);
      }
      const lay = st.layout;
      const pressed = i => !!(pad.buttons[i] && (pad.buttons[i].pressed || pad.buttons[i].value > 0.4));
      // discrete buttons → abstract actions (edge-triggered)
      for (const action of Object.keys(lay.buttons)) {
        const i = lay.buttons[action];
        const is = pressed(i), was = !!st.prevBtns[i];
        if (is && !was) {
          setActive("gamepad", pad.id, lay.family, lay);
          emit(action, { source: "gamepad", device: pad.id });
        }
        st.prevBtns[i] = is;
      }
      // direction: dpad buttons, else left stick, else hat axis
      let dir = null;
      if (pressed(lay.dpad[0])) dir = "up"; else if (pressed(lay.dpad[1])) dir = "down";
      else if (pressed(lay.dpad[2])) dir = "left"; else if (pressed(lay.dpad[3])) dir = "right";
      if (!dir) {
        const ax = pad.axes[lay.moveAxes[0]] || 0, ay = pad.axes[lay.moveAxes[1]] || 0;
        if (Math.abs(ax) > DEADZONE || Math.abs(ay) > DEADZONE) {
          dir = Math.abs(ax) > Math.abs(ay) ? (ax > 0 ? "right" : "left") : (ay > 0 ? "down" : "up");
        }
      }
      if (!dir && lay.hatAxis != null && pad.axes.length > lay.hatAxis) {
        const h = hatDir(pad.axes[lay.hatAxis]);
        // Hat diagonals resolve to their vertical component (4-way actions).
        if (h) dir = h.includes("-") ? h.split("-")[0] : h;
      }
      if (dir) {
        if (st.dir !== dir) {
          st.dir = dir; st.nextRepeat = now + REPEAT_FIRST_MS;
          setActive("gamepad", pad.id, lay.family, lay);
          emit("move", { dir, source: "gamepad", device: pad.id });
        } else if (now >= st.nextRepeat) {
          st.nextRepeat = now + REPEAT_MS;
          emit("move", { dir, source: "gamepad", device: pad.id });
        }
      } else st.dir = null;
    }
    // pad vanished → fall back without breaking the session
    for (const idx of [...padState.keys()]) {
      if (!pads[idx] || !pads[idx].connected) {
        padState.delete(idx);
        if (active.kind === "gamepad" && !anyPad) setActive("keyboard", "Keyboard", null, null);
      }
    }
  }
  function startPolling() {
    if (polling) return; polling = true;
    const loop = t => { try { pollPads(t || performance.now()); } catch (e) {} requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    /* rAF throttles to zero in occluded/headless contexts; a slow interval
     * keeps pads alive there too. pollPads is edge-detected, so the two
     * schedulers can never double-fire an action. */
    setInterval(() => { try { pollPads(performance.now()); } catch (e) {} }, 50);
  }
  global.addEventListener("gamepadconnected", e => {
    const lay = applyRemap(resolveLayout(e.gamepad.id));
    setActive("gamepad", e.gamepad.id, lay.family, lay);
  });
  global.addEventListener("gamepaddisconnected", e => {
    padState.delete(e.gamepad.index);
    if (active.kind === "gamepad") setActive("keyboard", "Keyboard", null, null);
  });

  /* ---- keyboard + TV remote ---- */
  const KEYMAP = {
    ArrowUp: ["move", "up"], KeyW: ["move", "up"],
    ArrowDown: ["move", "down"], KeyS: ["move", "down"],
    ArrowLeft: ["move", "left"], KeyA: ["move", "left"],
    ArrowRight: ["move", "right"], KeyD: ["move", "right"],
    Enter: ["confirm"], NumpadEnter: ["confirm"],
    Escape: ["back"], Backspace: ["back"], BrowserBack: ["back"], GoBack: ["back"],
    KeyP: ["pause"], MediaPlayPause: ["pause"], Pause: ["pause"],
    Space: ["action1"], KeyX: ["action2"], ShiftLeft: ["action2"],
  };
  const REMOTE_KEYS = new Set(["BrowserBack", "GoBack", "MediaPlayPause"]);
  document.addEventListener("keydown", e => {
    const m = KEYMAP[e.code];
    if (!m) return;
    const kind = REMOTE_KEYS.has(e.code) ? "remote" : "keyboard";
    if (active.kind !== kind) setActive(kind, kind === "remote" ? "TV remote" : "Keyboard", null, null);
    if (m[0] === "move") emit("move", { dir: m[1], source: kind });
    else emit(m[0], { source: kind });
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code)) e.preventDefault();
  });

  /* ---- touch ---- */
  function bindSwipe(el, opts) {
    opts = opts || {};
    let sx = 0, sy = 0, tracking = false;
    el.addEventListener("pointerdown", e => { tracking = true; sx = e.clientX; sy = e.clientY; });
    el.addEventListener("pointerup", e => {
      if (!tracking) return; tracking = false;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < (opts.threshold || 24)) return;
      if (active.kind !== "touch") setActive("touch", "Touch screen", null, null);
      const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up");
      emit("move", { dir, source: "touch" });
    });
    el.addEventListener("pointercancel", () => { tracking = false; });
  }

  /* ---- the control card (pause-screen manual data) ---- */
  const KEY_LABELS = { move: "Arrow keys / WASD", confirm: "Enter", back: "Esc", pause: "P", action1: "Space", action2: "X" };
  const REMOTE_LABELS = { move: "Arrow keys", confirm: "OK / Enter", back: "Back button", pause: "Play/Pause key", action1: "OK / Enter", action2: "—" };
  const TOUCH_LABELS = { move: "Swipe", confirm: "Tap the button", back: "‹ Back link", pause: "⏸ Pause button", action1: "Tap", action2: "Tap" };
  function controlCard() {
    if (active.kind === "gamepad") {
      const names = (active.layout && active.layout.names) ||
        FAMILIES[(active.layout && active.layout.family) || "generic"] || FAMILIES.generic;
      return { device: shortName(active.name), kind: "gamepad", labels: Object.assign({}, names) };
    }
    if (active.kind === "remote") return { device: "TV remote", kind: "remote", labels: Object.assign({}, REMOTE_LABELS) };
    if (active.kind === "touch") return { device: "Touch screen", kind: "touch", labels: Object.assign({}, TOUCH_LABELS) };
    return { device: "Keyboard", kind: "keyboard", labels: Object.assign({}, KEY_LABELS) };
  }

  /* ---- public API ---- */
  const HopeInput = {
    on(action, fn) { (handlers[action] = handlers[action] || []).push(fn); startPolling(); return HopeInput; },
    press(action, payload) { emit(action, Object.assign({ source: "ui" }, payload || {})); },
    bindSwipe,
    activeDevice,
    controlCard,
    setRemap(remap) {
      try { global.localStorage.setItem(REMAP_KEY, JSON.stringify(remap || {})); } catch (e) {}
      padState.clear();   // layouts re-resolve on next poll
    },
    clearRemap() { try { global.localStorage.removeItem(REMAP_KEY); } catch (e) {} padState.clear(); },
    debug: { resolveLayout, QUIRKS, FAMILIES, STD_BUTTONS, hatDir },
  };
  global.HopeInput = HopeInput;
  document.addEventListener("DOMContentLoaded", ensureIndicator);
})(window);
