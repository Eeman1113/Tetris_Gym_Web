/**
 * The driver: one call per emulated frame, reads RAM, writes the pad.
 *
 * It owns the whole lifecycle — walk the Tetris Gym menus from power-on into a
 * level 29 game, play, type "AI" on the high-score screen, and go round again,
 * forever. Every screen it acts on is identified from RAM (see the confirmed
 * map at the top of lib/tetris.js), never from a frame count, so a mistimed tap
 * cannot strand it: whatever screen it finds itself on, it works out what to
 * press next from the bytes in front of it.
 *
 * The expensive part — the placement search — runs exactly once per piece, on
 * the frame the piece appears. Every other frame does a handful of array reads.
 */

import { BTN } from "./buttons";
import {
  COLS, ROWS, PIECE_NAME, DEFAULT_WEIGHTS,
  readBoard, chooseMove, greedyAction, gravityFrames, rotationIndex,
} from "./tetris";

// RAM, all confirmed empirically. See lib/tetris.js for how.
const A_X = 0x40;
const A_Y = 0x41;
const A_ORIENT = 0x42;
const A_LEVEL = 0x44;
const A_PLAYSTATE = 0x48;
const A_LINES_LO = 0x50;
const A_LINES_HI = 0x51;
const A_SCORE = 0x0c; // 0x0C..0x0F, BCD, least significant byte first
const A_NEXT = 0xbf;
const A_MODE = 0xc0;
const A_SPRITE0_X = 0x203;
const A_NAME = 0x700; // one byte per character slot, 0 = blank, 1 = 'A', ...
const A_MENU_INDEX = 0x600;

const MODE_MODE_MENU = 2;
const MODE_LEVEL_SELECT = 3;
const MODE_GAME = 4;

const PS_FALLING = 1;
const PS_TOPOUT = 10;
const PS_NAME_ENTRY = 0;

const LEVEL_CELL_X = 176; // sprite-0 X of the separate "29" cell
const MENU_TETRIS = 0; // first item of the Tetris Gym mode menu
const MENU_LENGTH = 36;

const GLOW_FRAMES = 7; // ~115ms, long enough for a one-frame tap to be seen

// The name field is eight slots wide; the letter wheel runs blank, A..Z, 0..9
// and a few symbols, so 1 = 'A' and 9 = 'I'. Everything after "AI" stays blank.
const NAME = [1, 9, 0, 0, 0, 0, 0, 0];
const NAME_X0 = 32; // sprite-0 X of slot 0; each slot is 8px further right
const WHEEL = 40; // length of the letter wheel, which wraps

const bcd2 = (b) => (b >> 4) * 10 + (b & 15);

// If nothing in the progress signature below changes for this long the bot is
// wedged on a screen it does not understand, and nudging START at it clearly is
// not working. Ten seconds is far longer than any Tetris Gym transition, and
// far longer than the slowest row of free fall the game has (48 frames).
const STUCK_FRAMES = 600;

export function createAutoplay(opts = {}) {
  const weights = opts.weights || DEFAULT_WEIGHTS;
  const twoPly = opts.twoPly !== false;
  const onStuck = opts.onStuck;

  const board = new Uint8Array(ROWS * COLS);
  let mask = 0; // bitfield of BTN values currently pressed
  let hold = 0; // frames left to hold `mask` before the next decision
  let prevState = -1;

  // current plan — recomputed once per piece, then re-derived into buttons on
  // every frame from the live RAM rather than replayed from a schedule.
  let target = null;
  let planned = false;
  let lastShift = 0; // 0 none, 1 left, 2 right — pressed on the previous frame
  let lastRot = 0; // 0 none, 1 A, 2 B

  let games = 0;
  let deaths = [];
  // How many frames ago each button was last pressed. At killscreen speed a tap
  // is one frame long, far too short for a display to show, so the UI reads
  // this decaying trail instead of the instantaneous mask.
  const glow = new Uint8Array(8);
  const status = {
    state: "booting",
    games: 0,
    level: 0,
    lines: 0,
    score: 0,
    piece: null,
    next: null,
    targetX: null,
    targetRot: null,
    targetOrient: null,
    gravity: 0,
    pending: 0,
    buttons: 0,
    glow: 0,
    searchMs: 0,
    piecesPlaced: 0,
  };

  let pendingRelease = 0;
  let stuckSig = -1;
  let stuckFor = 0;

  /** Press `btn` for 4 frames, then release for 6 — one unambiguous menu tap. */
  const menuTap = (btn) => {
    hold = 3;
    pendingRelease = 6;
    return 1 << btn;
  };

  const clearPlan = () => {
    target = null;
    planned = false;
    lastShift = 0;
    lastRot = 0;
  };

  /**
   * One emulated frame. `ctx` is { mem, down, up } from createNes.
   */
  function beforeFrame(ctx) {
    const mem = ctx.mem;
    let next = 0;

    // Progress, not liveness: a frame counter would tick forever and never
    // notice anything wrong, so this is the set of things that have to move if
    // the console is actually getting somewhere — the screen, the play state,
    // the menu cursor, the falling piece's row, and the line count. The piece
    // row is what keeps this honest once Tetris Gym's level byte wraps past
    // 255 and gravity drops back to 48 frames a row.
    const sig =
      mem[A_MODE] * 0x100000000 +
      mem[A_PLAYSTATE] * 0x1000000 +
      mem[A_MENU_INDEX] * 0x10000 +
      mem[A_SPRITE0_X] * 0x100 +
      mem[A_Y] +
      status.piecesPlaced * 0x10000000000 +
      mem[A_LINES_LO] * 0x100000000000;
    if (sig === stuckSig) stuckFor++;
    else { stuckSig = sig; stuckFor = 0; }
    if (stuckFor > STUCK_FRAMES) {
      stuckFor = 0;
      hold = 0;
      pendingRelease = 0;
      clearPlan();
      status.state = "recovering";
      // Releasing the pad first matters: the reset vector reads the controller.
      apply(ctx, 0);
      onStuck?.();
      return 0;
    }

    if (hold > 0) {
      hold--;
      next = mask;
    } else if (pendingRelease > 0) {
      pendingRelease--;
      next = 0;
    } else {
      next = decide(mem);
    }

    apply(ctx, next);
    return next;
  }

  function apply(ctx, next) {
    for (let b = 0; b < 8; b++) {
      const bit = 1 << b;
      const want = (next & bit) !== 0;
      const have = (mask & bit) !== 0;
      if (want && !have) ctx.down(b);
      else if (!want && have) ctx.up(b);
    }
    mask = next;
    status.buttons = next;
    let lit = 0;
    for (let b = 0; b < 8; b++) {
      if (next & (1 << b)) glow[b] = GLOW_FRAMES;
      else if (glow[b]) glow[b]--;
      if (glow[b]) lit |= 1 << b;
    }
    status.glow = lit;
  }

  function decide(mem) {
    const mode = mem[A_MODE];

    if (mode === MODE_MODE_MENU) {
      clearPlan();
      status.state = "mode menu";
      const idx = mem[A_MENU_INDEX];
      // UP decrements, DOWN increments, both wrap at 36 — take the short way.
      if (idx !== MENU_TETRIS) return menuTap(idx <= MENU_LENGTH / 2 ? BTN.UP : BTN.DOWN);
      return menuTap(BTN.START);
    }

    if (mode === MODE_LEVEL_SELECT) {
      clearPlan();
      status.state = "level select";
      // RIGHT clamps at the "29" cell, so this always terminates.
      if (mem[A_SPRITE0_X] !== LEVEL_CELL_X) return menuTap(BTN.RIGHT);
      return menuTap(BTN.START);
    }

    if (mode !== MODE_GAME) {
      // Nothing else is expected; a START gets every Tetris Gym screen moving.
      clearPlan();
      status.state = `screen ${mode}`;
      return menuTap(BTN.START);
    }

    const ps = mem[A_PLAYSTATE];

    if (ps === PS_NAME_ENTRY) {
      clearPlan();
      status.state = "entering name";
      return nameEntry(mem);
    }

    if (ps === PS_TOPOUT) {
      if (prevState !== PS_TOPOUT) {
        games++;
        status.games = games;
        deaths.push({ level: mem[A_LEVEL], lines: readLines(mem), score: readScore(mem) });
      }
      prevState = ps;
      clearPlan();
      status.state = "topped out";
      return menuTap(BTN.START);
    }

    prevState = ps;
    status.state = "playing";
    status.level = mem[A_LEVEL];
    status.lines = readLines(mem);
    status.score = readScore(mem);

    if (ps !== PS_FALLING) {
      // Locked / clearing / ARE: hold nothing, so the next piece's very first
      // press is guaranteed to read as fresh.
      clearPlan();
      lastShift = 0;
      lastRot = 0;
      return 0;
    }

    return play(mem);
  }

  /**
   * Type "AI" on the high-score screen.
   *
   * UP and DOWN turn the letter wheel under the cursor, LEFT and RIGHT move
   * the cursor (and wrap), START commits and drops back to the level-select
   * screen. START is only ever pressed once every slot already reads what it
   * should — which matters, because on the first frame of this screen sprite 0
   * still holds the falling piece's X from the frame before, and a bot that
   * trusted it would commit a blank name before the cursor had even appeared.
   */
  function nameEntry(mem) {
    for (let i = 0; i < NAME.length; i++) {
      if (mem[A_NAME + i] !== NAME[i]) {
        const pos = (mem[A_SPRITE0_X] - NAME_X0) >> 3;
        // Cursor nowhere sensible yet: walk left until it is.
        if (pos < 0 || pos >= NAME.length) return menuTap(BTN.LEFT);
        const want = NAME[pos];
        const got = mem[A_NAME + pos];
        // RIGHT wraps, so cycling the cursor always reaches the wrong slot.
        if (got === want) return menuTap(BTN.RIGHT);
        // The wheel wraps too; turn it whichever way is shorter.
        return menuTap(((want - got + WHEEL) % WHEEL) <= WHEEL / 2 ? BTN.UP : BTN.DOWN);
      }
    }
    return menuTap(BTN.START);
  }

  function play(mem) {
    const o = mem[A_ORIENT];
    const x = mem[A_X];
    const y = mem[A_Y];

    status.piece = PIECE_NAME[o] ?? null;
    status.next = PIECE_NAME[mem[A_NEXT]] ?? null;

    // A new piece: $0400 holds only locked cells until a piece locks, so this
    // is the one moment the search has a clean board — and the whole frame
    // budget, because nothing else happens on a spawn frame.
    if (!planned) {
      planned = true;
      status.piecesPlaced++;
      readBoard(mem, board);
      const t0 = now();
      target = chooseMove(board, o, x, mem[A_NEXT], mem[A_LEVEL], weights, twoPly);
      status.searchMs = now() - t0;
      status.gravity = gravityFrames(mem[A_LEVEL]);
      status.targetX = target ? target.x : null;
      status.targetRot = target ? rotationIndex(target.o) : null;
      status.targetOrient = target ? target.o : null;
    }

    if (!target) {
      lastShift = 0;
      lastRot = 0;
      return 0;
    }

    // The plan is a policy, not a schedule: ask it again every frame from where
    // the piece actually is. That is immune to a stalled frame, to the long
    // hold at the start of a game, and to the emulator running several
    // emulated frames inside one animation frame — and when the stack is so
    // high that nothing is reachable any more it still rotates and nudges as
    // far as it can rather than sitting on its hands.
    const act = greedyAction(
      board, o, x, y,
      target.targetO, target.targetX, target.rotDir, target.policy,
      lastShift, lastRot,
    );
    const sh = act & 3;
    const rt = act >> 2;
    lastShift = sh;
    lastRot = rt;

    let want = 0;
    if (sh === 1) want |= 1 << BTN.LEFT;
    else if (sh === 2) want |= 1 << BTN.RIGHT;
    if (rt === 1) want |= 1 << BTN.A;
    else if (rt === 2) want |= 1 << BTN.B;

    status.pending = (x !== target.targetX ? 1 : 0) + (o !== target.targetO ? 1 : 0);
    return want;
  }

  const readLines = (mem) => bcd2(mem[A_LINES_HI]) * 100 + bcd2(mem[A_LINES_LO]);
  // Four BCD bytes, eight digits. The game's own SCORE box only has room for
  // six and simply drops the top two, so past a million the HUD reads higher
  // than the screen does — the HUD is the one telling the truth.
  const readScore = (mem) =>
    bcd2(mem[A_SCORE + 3]) * 1000000 +
    bcd2(mem[A_SCORE + 2]) * 10000 +
    bcd2(mem[A_SCORE + 1]) * 100 +
    bcd2(mem[A_SCORE]);

  return {
    beforeFrame,
    status,
    get deaths() { return deaths; },
    /** Forget any in-flight plan, e.g. after an external console reset. */
    reset() {
      clearPlan();
      prevState = -1;
      stuckSig = -1;
      stuckFor = 0;
    },
  };
}

const now =
  typeof performance !== "undefined" && performance.now
    ? () => performance.now()
    : () => Number(process.hrtime.bigint() / 1000n) / 1000;
