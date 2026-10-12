import { BTN } from "./buttons";

const DZ_ON = 0.5; // stick must pass this to register a direction...
const DZ_OFF = 0.35; // ...and fall back under this to clear it (hysteresis)

// Hat-switch logical values 0-7, clockwise from north.
const HAT = [
  [BTN.UP],
  [BTN.UP, BTN.RIGHT],
  [BTN.RIGHT],
  [BTN.DOWN, BTN.RIGHT],
  [BTN.DOWN],
  [BTN.DOWN, BTN.LEFT],
  [BTN.LEFT],
  [BTN.UP, BTN.LEFT],
];

// W3C "standard" layout. Xbox and DualSense both report this over Bluetooth
// and USB in Chrome, Edge and Safari (including iOS), which is why no code
// here branches on gamepad.id — the same pad reports different ids per OS and
// per connection type, so id sniffing is actively wrong.
//
// South is B and east is A, preserving the real NES pad's left-is-B layout.
// The top row doubles them up so all four face buttons rotate.
const STANDARD = {
  0: BTN.B, // A / cross
  1: BTN.A, // B / circle
  2: BTN.B, // X / square
  3: BTN.A, // Y / triangle
  4: BTN.B, // LB / L1
  5: BTN.A, // RB / R1
  8: BTN.SELECT, // Back / View / Share / Create
  9: BTN.START, // Start / Menu / Options
  12: BTN.UP,
  13: BTN.DOWN,
  14: BTN.LEFT,
  15: BTN.RIGHT,
};

const isPressed = (pad, i) => {
  const b = pad.buttons[i];
  return !!b && (b.pressed || b.value > 0.5);
};

/**
 * Decode an HID hat/POV axis: a 4-bit rotational value, logical 0-7 clockwise
 * from north, logical 8 = nothing pressed. Browsers spread that linearly over
 * [-1..1], so the null state lands out of range at ~+1.286 and each direction
 * sits exactly on a 1/7 grid point. The grid check matters: an idle analog
 * trigger rests at -1.0 and would otherwise decode as a permanent Up.
 */
function decodeHat(v) {
  if (!Number.isFinite(v) || Math.abs(v) > 1.02) return null;
  const i = Math.round(((v + 1) / 2) * 7);
  if (i < 0 || i > 7) return null;
  if (Math.abs(v - ((i / 7) * 2 - 1)) > 0.06) return null;
  return HAT[i];
}

export function bindGamepads(pad, { onPresence, onActivity }) {
  const sticks = new Map(); // gamepad index -> directions held last frame
  const rest = new Map(); // gamepad index -> axis values at first sight
  let frame = 0;
  let stopped = false;
  let present = false;

  const readStick = (gp, out) => {
    const prev = sticks.get(gp.index) || new Set();
    const x = gp.axes[0] || 0;
    const y = gp.axes[1] || 0;
    const now = new Set();
    const past = (v, wasOn) => Math.abs(v) > (wasOn ? DZ_OFF : DZ_ON);
    if (past(x, prev.has(BTN.LEFT) || prev.has(BTN.RIGHT))) {
      now.add(x < 0 ? BTN.LEFT : BTN.RIGHT);
    }
    if (past(y, prev.has(BTN.UP) || prev.has(BTN.DOWN))) {
      now.add(y < 0 ? BTN.UP : BTN.DOWN);
    }
    sticks.set(gp.index, now);
    for (const b of now) out.add(b);
  };

  // mapping === "" means raw HID order, which is device specific. We only have
  // to recover the d-pad and Start/Select: every face button rotates anyway, so
  // a scrambled face cluster at worst swaps rotation direction.
  const readNonStandard = (gp, out) => {
    const n = gp.buttons.length;
    for (let i = 0; i < Math.min(4, n); i++) {
      if (isPressed(gp, i)) out.add(i % 2 === 0 ? BTN.B : BTN.A);
    }
    if (n > 6) {
      if (isPressed(gp, 4)) out.add(BTN.B);
      if (isPressed(gp, 5)) out.add(BTN.A);
    }
    if (n > 9) {
      if (isPressed(gp, 8)) out.add(BTN.SELECT);
      if (isPressed(gp, 9)) out.add(BTN.START);
    } else if (n >= 2) {
      if (isPressed(gp, n - 2)) out.add(BTN.SELECT);
      if (isPressed(gp, n - 1)) out.add(BTN.START);
    }
    if (n >= 16) {
      if (isPressed(gp, 12)) out.add(BTN.UP);
      if (isPressed(gp, 13)) out.add(BTN.DOWN);
      if (isPressed(gp, 14)) out.add(BTN.LEFT);
      if (isPressed(gp, 15)) out.add(BTN.RIGHT);
    }
    const hasDir =
      out.has(BTN.UP) || out.has(BTN.DOWN) || out.has(BTN.LEFT) || out.has(BTN.RIGHT);
    if (!hasDir) {
      const idle = rest.get(gp.index);
      for (const i of [9, 4, 5, 6, 7, 8, 10]) {
        if (i >= gp.axes.length) continue;
        if (idle && Math.abs(gp.axes[i] - idle[i]) < 0.02) continue;
        const dirs = decodeHat(gp.axes[i]);
        if (dirs) {
          for (const d of dirs) out.add(d);
          break;
        }
      }
    }
  };

  const poll = () => {
    if (stopped) return;
    frame = requestAnimationFrame(poll);

    // getGamepads() returns a fresh snapshot; the objects from the connect
    // event are frozen copies and would read as permanently idle.
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const out = new Set();
    let live = 0;

    for (const gp of pads) {
      if (!gp || !gp.connected) continue;
      live++;
      if (!rest.has(gp.index)) rest.set(gp.index, Array.from(gp.axes));
      if (gp.mapping === "standard") {
        for (const i in STANDARD) if (isPressed(gp, i)) out.add(STANDARD[i]);
      } else {
        readNonStandard(gp, out);
      }
      readStick(gp, out);
    }

    if (out.size) onActivity?.();
    pad.hold("gp", out);

    const any = live > 0;
    if (any !== present) {
      present = any;
      onPresence?.(any);
    }
  };

  const onDisconnect = (e) => {
    sticks.delete(e.gamepad.index);
    rest.delete(e.gamepad.index);
  };

  // Polled unconditionally: browsers withhold pads until the user presses a
  // button, so "no gamepadconnected yet" never means "no gamepad".
  window.addEventListener("gamepaddisconnected", onDisconnect);
  frame = requestAnimationFrame(poll);

  return () => {
    stopped = true;
    cancelAnimationFrame(frame);
    window.removeEventListener("gamepaddisconnected", onDisconnect);
    pad.hold("gp", new Set());
    sticks.clear();
    rest.clear();
  };
}
