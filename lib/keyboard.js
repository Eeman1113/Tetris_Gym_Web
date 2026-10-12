import { BTN } from "./buttons";

// KeyboardEvent.code is the physical key, so this map works unchanged on
// AZERTY/QWERTZ where event.key would report different letters.
const KEYMAP = {
  ArrowUp: BTN.UP,
  ArrowDown: BTN.DOWN,
  ArrowLeft: BTN.LEFT,
  ArrowRight: BTN.RIGHT,
  KeyW: BTN.UP,
  KeyS: BTN.DOWN,
  KeyA: BTN.LEFT,
  KeyD: BTN.RIGHT,
  // NES Tetris rotates with both A and B, so give each two reachable keys.
  KeyX: BTN.A,
  KeyK: BTN.A,
  Period: BTN.A,
  Space: BTN.A,
  KeyZ: BTN.B,
  KeyJ: BTN.B,
  Comma: BTN.B,
  Enter: BTN.START,
  NumpadEnter: BTN.START,
  ShiftLeft: BTN.SELECT,
  ShiftRight: BTN.SELECT,
};

export function bindKeyboard(pad, onActivity) {
  const onKeyDown = (e) => {
    const btn = KEYMAP[e.code];
    if (btn === undefined) return;
    e.preventDefault(); // arrows and space would otherwise scroll the page
    if (e.repeat) return; // OS auto-repeat carries no new state
    pad.hold(`k:${e.code}`, new Set([btn]));
    if (onActivity) onActivity();
  };

  const onKeyUp = (e) => {
    const btn = KEYMAP[e.code];
    if (btn === undefined) return;
    e.preventDefault();
    pad.hold(`k:${e.code}`, new Set());
  };

  // keyup never arrives if focus leaves mid-press (cmd-tab, OS overlay, and
  // macOS swallows keyup entirely while Meta is held) — the button would stick
  // down forever. Release everything whenever the page stops being in front.
  const releaseAll = () => pad.releaseNamespace("k:");
  const onVisibility = () => {
    if (document.hidden) releaseAll();
  };

  window.addEventListener("keydown", onKeyDown, { passive: false });
  window.addEventListener("keyup", onKeyUp, { passive: false });
  window.addEventListener("blur", releaseAll);
  window.addEventListener("pagehide", releaseAll);
  document.addEventListener("visibilitychange", onVisibility);

  return () => {
    releaseAll();
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", releaseAll);
    window.removeEventListener("pagehide", releaseAll);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
