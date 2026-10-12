import { BTN } from "./buttons";

/**
 * Refcounted NES pad state.
 *
 * Every input source (each key, each gamepad, each touch pointer) holds a
 * token. A button is down while at least one token holds it, so releasing one
 * finger — or one of two keys bound to the same button — never cancels another
 * source that is still pressing it. This is the single place button edges are
 * emitted, which keeps the emulator's view of the pad consistent no matter how
 * many sources are live at once.
 */
export function createPad({ down, up }) {
  const held = new Map(); // token -> Set<button>
  let live = new Set(); // buttons currently reported as pressed

  const resolve = () => {
    const next = new Set();
    for (const buttons of held.values()) for (const b of buttons) next.add(b);

    // Left+Right (or Up+Down) at once drives NES Tetris' DAS counter into
    // nonsense, and no physical d-pad can produce it. Drop both.
    if (next.has(BTN.LEFT) && next.has(BTN.RIGHT)) {
      next.delete(BTN.LEFT);
      next.delete(BTN.RIGHT);
    }
    if (next.has(BTN.UP) && next.has(BTN.DOWN)) {
      next.delete(BTN.UP);
      next.delete(BTN.DOWN);
    }

    for (const b of live) if (!next.has(b)) up(b);
    for (const b of next) if (!live.has(b)) down(b);
    live = next;
  };

  return {
    /** Set exactly which buttons `token` is holding. Empty set releases it. */
    hold(token, buttons) {
      const prev = held.get(token);
      if (buttons.size === 0) {
        if (!prev) return;
        held.delete(token);
      } else {
        if (prev && prev.size === buttons.size && [...buttons].every((b) => prev.has(b))) {
          return;
        }
        held.set(token, buttons);
      }
      resolve();
    },
    /** Release every token in a namespace, e.g. all keyboard keys on blur. */
    releaseNamespace(prefix) {
      let changed = false;
      for (const token of held.keys()) {
        if (token.startsWith(prefix)) {
          held.delete(token);
          changed = true;
        }
      }
      if (changed) resolve();
    },
    releaseAll() {
      if (held.size === 0) return;
      held.clear();
      resolve();
    },
  };
}
