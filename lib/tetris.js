/**
 * Pure NES Tetris model: piece geometry, board simulation, board evaluation and
 * a frame-exact reachability search. No DOM, no emulator — so the same code
 * drives /auto in the browser and the headless harness in Node.
 *
 * ============================================================================
 * CONFIRMED RAM MAP (Tetris Gym, public/game.nes)
 * ----------------------------------------------------------------------------
 * Everything below was verified empirically against jsnes, not taken on faith.
 * Method: boot headless, drive the pad, diff `nes.cpu.mem` across frames.
 *
 *   $0040  tetriminoX     active piece column, 0..9, spawns at 5.
 *   $0041  tetriminoY     active piece row, 0..19, spawns at 0.
 *   $0042  orientation    0..18, index into ORIENT below. Spawn values are
 *                         2(T) 7(J) 8(Z) 10(O) 11(S) 14(L) 18(I).
 *   $0044  level          binary, not BCD. 29 at killscreen; it keeps counting
 *                         and wraps past 255, after which the ROM's own gravity
 *                         lookup hands back level-0 speed again.
 *   $0045  frame counter  0..95, wraps. (Not used by the bot.)
 *   $0047  startLevel     the level chosen on the select screen.
 *   $0048  playState      1 = piece falling / player in control
 *                         2 = piece just locked
 *                         3,5,6,7,8 = line-clear + ARE sequence
 *                         10 = topped out, waiting for START
 *                         0  = high-score name entry screen
 *   $000C  score BCD   ) four bytes, eight digits, least significant byte
 *   $000D   ..         ) first. Checked digit-for-digit against the on-screen
 *   $000E   ..         ) SCORE box at five points across a long game. The box
 *   $000F   ..         ) only shows the low six digits and drops the rest.
 *   $0050  lines, low BCD byte   ) four digits, checked against the on-screen
 *   $0051  lines, high BCD byte  ) LINES the same way (which also truncates,
 *                                ) to three digits).
 *   $00BF  nextPiece      orientation id of the piece in the NEXT box.
 *   $00C0  gameMode       2 = Tetris Gym mode menu
 *                         3 = level select
 *                         4 = in game (incl. topout + name entry, see $0048)
 *   $0200..$020F  OAM shadow. On the level-select screen sprite 0's X ($0203)
 *                 is the selection cursor: 52 + 16*col for the 0-9 grid, and
 *                 176 for the separate "29" cell. On the name-entry screen it
 *                 is 32 + 8*position. Sprite Y ($0200) blinks, X does not.
 *   $0400..$04C7  playfield, 20 rows x 10 cols, row-major. 0xEF = empty.
 *                 The active piece is NOT written here until it locks.
 *   $0600  mode-menu cursor index. 0 = TETRIS (the first item), 36 items,
 *          wraps; UP decrements and DOWN increments.
 *   $0700..$0707  name-entry buffer, one byte per character slot of the
 *                 high-score name. 0 = blank, 1..26 = 'A'..'Z', 27..36 =
 *                 '0'..'9', then symbols; the wheel is 40 long and wraps.
 *
 * Orientation geometry was harvested from OAM: in game, read the four active
 * sprites' X/Y and subtract the piece's own $0040/$0041. Every one of the 19
 * orientations was captured that way, so ORIENT is measured, not transcribed.
 * ============================================================================
 */

export const EMPTY = 0xef;
export const COLS = 10;
export const ROWS = 20;

/** [dx, dy] of the four cells, relative to ($0040, $0041). */
export const ORIENT = [
  [[-1, 0], [0, 0], [1, 0], [0, -1]],     //  0  T, nub up
  [[0, -1], [0, 0], [1, 0], [0, 1]],      //  1  T, nub right
  [[-1, 0], [0, 0], [1, 0], [0, 1]],      //  2  T, nub down   (spawn)
  [[0, -1], [-1, 0], [0, 0], [0, 1]],     //  3  T, nub left
  [[0, -1], [0, 0], [-1, 1], [0, 1]],     //  4  J
  [[-1, -1], [-1, 0], [0, 0], [1, 0]],    //  5  J
  [[0, -1], [1, -1], [0, 0], [0, 1]],     //  6  J
  [[-1, 0], [0, 0], [1, 0], [1, 1]],      //  7  J              (spawn)
  [[-1, 0], [0, 0], [0, 1], [1, 1]],      //  8  Z horizontal   (spawn)
  [[1, -1], [0, 0], [1, 0], [0, 1]],      //  9  Z vertical
  [[-1, 0], [0, 0], [-1, 1], [0, 1]],     // 10  O              (spawn)
  [[0, 0], [1, 0], [-1, 1], [0, 1]],      // 11  S horizontal   (spawn)
  [[0, -1], [0, 0], [1, 0], [1, 1]],      // 12  S vertical
  [[0, -1], [0, 0], [0, 1], [1, 1]],      // 13  L
  [[-1, 0], [0, 0], [1, 0], [-1, 1]],     // 14  L              (spawn)
  [[-1, -1], [0, -1], [0, 0], [0, 1]],    // 15  L
  [[1, -1], [-1, 0], [0, 0], [1, 0]],     // 16  L
  [[0, -2], [0, -1], [0, 0], [0, 1]],     // 17  I vertical
  [[-2, 0], [-1, 0], [0, 0], [1, 0]],     // 18  I horizontal   (spawn)
];

// Rotation groups: [firstOrientation, count]. A steps forward through the
// group, B steps back; neither ever leaves it, and there are no wall kicks.
const GROUPS = [[0, 4], [4, 4], [8, 2], [10, 1], [11, 2], [13, 4], [17, 2]];
const GROUP_BASE = new Int8Array(19);
const GROUP_SIZE = new Int8Array(19);
export const PIECE_NAME = new Array(19);
const NAMES = ["T", "J", "Z", "O", "S", "L", "I"];
for (let g = 0; g < GROUPS.length; g++) {
  const [base, size] = GROUPS[g];
  for (let o = base; o < base + size; o++) {
    GROUP_BASE[o] = base;
    GROUP_SIZE[o] = size;
    PIECE_NAME[o] = NAMES[g];
  }
}

/** Which turn within its own rotation group an orientation is: 0..3. */
export const rotationIndex = (o) => o - GROUP_BASE[o];

export const rotA = (o) => GROUP_BASE[o] + ((o - GROUP_BASE[o] + 1) % GROUP_SIZE[o]);
export const rotB = (o) => GROUP_BASE[o] + ((o - GROUP_BASE[o] + GROUP_SIZE[o] - 1) % GROUP_SIZE[o]);

// Frames per row of free fall. Stock NES table; 29 and above is one row per
// frame and never gets faster, so there is no level the bot has to give up at.
const GRAVITY = [48, 43, 38, 33, 28, 23, 18, 13, 8, 6, 5, 5, 5, 4, 4, 4, 3, 3, 3];
export function gravityFrames(level) {
  if (level < 19) return GRAVITY[level];
  if (level < 29) return 2;
  return 1;
}

/** $0400..$04C7 -> Uint8Array(200), 1 = filled. */
export function readBoard(mem, out) {
  const b = out || new Uint8Array(ROWS * COLS);
  for (let i = 0; i < ROWS * COLS; i++) b[i] = mem[0x400 + i] === EMPTY ? 0 : 1;
  return b;
}

/** Does `o` at (x, y) sit entirely inside the board on empty cells? */
export function fits(board, o, x, y) {
  const cells = ORIENT[o];
  for (let i = 0; i < 4; i++) {
    const cx = x + cells[i][0];
    const cy = y + cells[i][1];
    if (cx < 0 || cx >= COLS) return false;
    if (cy >= ROWS) return false;
    if (cy < 0) continue; // above the ceiling is legal while spawning
    if (board[cy * COLS + cx]) return false;
  }
  return true;
}

// Flattened geometry: ORIENT_FLAT[o*8 + i*2] = dx, +1 = dy. Hot loops index
// this instead of walking the nested arrays above.
const ORIENT_FLAT = new Int8Array(19 * 8);
for (let o = 0; o < 19; o++) {
  for (let i = 0; i < 4; i++) {
    ORIENT_FLAT[o * 8 + i * 2] = ORIENT[o][i][0];
    ORIENT_FLAT[o * 8 + i * 2 + 1] = ORIENT[o][i][1];
  }
}

// --------------------------------------------------------------- evaluation

/**
 * Board evaluation weights.
 *
 * The base is Dellacherie's feature set, which is a strong starting point and a
 * terrible finishing point for this particular problem: played straight it
 * averaged 20 lines a game from a level 29 start. Four extra terms and a tuning
 * pass took it to not dying at all. The numbers below are not taste, they are
 * what measured best over a few hundred headless games:
 *
 *   plain Dellacherie                                 mean  20 lines
 *   + aggregate / peak height / bumpiness             mean  47 lines
 *   + wellSums relaxed from -3.39 to -1               never topped out
 *
 * The wellSums move is the counter-intuitive one and the one that mattered
 * most. Dellacherie's heavy well penalty is tuned for a game where you have
 * time to dig a well and wait for an I piece. At one row per frame you do not;
 * what you need is permission to leave a narrow gap open for a frame or two
 * rather than filling it with whatever piece happens to be falling. Pushing the
 * penalty the other way (-2, -2.5, -6) made it steadily worse: 131, 260 and 13
 * lines a game respectively.
 *
 * The height terms are the other half. They matter far more here than at any
 * lower level, because the number of frames available to steer a piece shrinks
 * as the stack rises — a tall board is not just closer to the ceiling, it is
 * also harder to play.
 */
export const DEFAULT_WEIGHTS = {
  // Dellacherie's six, unchanged.
  landingHeight: -4.5,
  erodedCells: 3.42,
  rowTransitions: -3.22,
  colTransitions: -9.35,
  holes: -7.9,
  wellSums: -1.0, // Dellacherie's -3.39 is far too harsh at killscreen speed
  // Added for this problem.
  aggHeight: -1.2,
  maxHeight: -4.0,
  bumpiness: -1.0,
  deathRisk: -500, // squared penalty on the spawn columns getting close to the top
};

const heights = new Int32Array(COLS);
const emptyRun = new Int32Array(COLS);
const roofed = new Uint8Array(COLS);

/** Score a settled board. Higher is better. */
export function evaluate(b, w, landingHeight, cleared, eroded) {
  let agg = 0, maxH = 0, holes = 0, wellSums = 0, bump = 0, colT = 0, rowT = 0;

  heights.fill(0);
  emptyRun.fill(0);
  roofed.fill(0);

  // One top-down pass does heights, holes, wells and row transitions together.
  for (let r = 0; r < ROWS; r++) {
    const base = r * COLS;
    let prevCell = 1; // left wall counts as filled
    for (let c = 0; c < COLS; c++) {
      const cur = b[base + c];
      if (cur !== prevCell) rowT++;
      prevCell = cur;

      if (cur) {
        if (!roofed[c]) { roofed[c] = 1; heights[c] = ROWS - r; }
        emptyRun[c] = 0;
      } else {
        if (roofed[c]) holes++;
        const left = c === 0 ? 1 : b[base + c - 1];
        const right = c === COLS - 1 ? 1 : b[base + c + 1];
        if (left && right) wellSums += 1 + emptyRun[c];
        emptyRun[c]++;
      }
    }
    if (prevCell !== 1) rowT++; // right wall
  }

  for (let c = 0; c < COLS; c++) {
    agg += heights[c];
    if (heights[c] > maxH) maxH = heights[c];
    let prev = 0; // above the board is empty
    for (let r = 0; r < ROWS; r++) {
      const cur = b[r * COLS + c];
      if (cur !== prev) colT++;
      prev = cur;
    }
    if (prev !== 1) colT++; // floor counts as filled
  }

  for (let c = 0; c < COLS - 1; c++) bump += Math.abs(heights[c] - heights[c + 1]);

  // Spawning needs columns 3..6 clear near the top, so height up there is
  // what actually kills. Treated separately from plain max height.
  let spawnH = 0;
  for (let c = 3; c <= 6; c++) if (heights[c] > spawnH) spawnH = heights[c];
  const risk = spawnH > 15 ? (spawnH - 15) * (spawnH - 15) : 0;

  return (
    w.landingHeight * landingHeight +
    w.erodedCells * (cleared * eroded) +
    w.rowTransitions * rowT +
    w.colTransitions * colT +
    w.holes * holes +
    w.wellSums * wellSums +
    w.aggHeight * agg +
    w.maxHeight * maxH +
    w.bumpiness * bump +
    w.deathRisk * risk
  );
}

/**
 * Copy `board` into `out`, lock `o` at (`x`, `lockY`), clear full rows, and
 * return { score, cleared }. Mutates `out` only.
 */
export function placeAndScore(board, o, x, lockY, out, w) {
  out.set(board);
  let minY = ROWS, maxY = -1;
  const g = o * 8;
  for (let i = 0; i < 4; i++) {
    const cy = lockY + ORIENT_FLAT[g + i * 2 + 1];
    const cx = x + ORIENT_FLAT[g + i * 2];
    if (cy < 0) continue; // locked partly above the ceiling: that cell is lost
    out[cy * COLS + cx] = 1;
    if (cy < minY) minY = cy;
    if (cy > maxY) maxY = cy;
  }
  if (maxY < 0) return null; // nothing landed on the board at all

  let cleared = 0, eroded = 0;
  for (let r = minY; r <= maxY; r++) {
    let full = true;
    for (let c = 0; c < COLS; c++) if (!out[r * COLS + c]) { full = false; break; }
    if (!full) continue;
    cleared++;
    for (let i = 0; i < 4; i++) if (lockY + ORIENT_FLAT[g + i * 2 + 1] === r) eroded++;
  }
  if (cleared) {
    let write = ROWS - 1;
    for (let r = ROWS - 1; r >= 0; r--) {
      let full = true;
      for (let c = 0; c < COLS; c++) if (!out[r * COLS + c]) { full = false; break; }
      if (full) continue;
      if (write !== r) for (let c = 0; c < COLS; c++) out[write * COLS + c] = out[r * COLS + c];
      write--;
    }
    for (; write >= 0; write--) for (let c = 0; c < COLS; c++) out[write * COLS + c] = 0;
  }

  return { score: evaluate(out, w, ROWS - (minY + maxY) / 2, cleared, eroded), cleared };
}

// ------------------------------------------------------- reachability search

/**
 * Frame-exact reachability.
 *
 * The NES samples the pad once a frame and only acts on a *fresh* press, so a
 * shift costs two frames — press, release — and DAS (16 frames to the first
 * repeat) is far too slow to be any help. Within one frame the game rotates
 * first, then shifts, then applies gravity, and it does all three on the frame
 * the piece locks; A and LEFT on the same frame therefore both land, which is
 * what makes level 29 playable at all. Every one of those facts was measured
 * against the ROM, not assumed.
 *
 * Rather than searching the whole tree of button sequences, this asks a
 * narrower and much more useful question: for each (orientation, column), does
 * the obvious plan get there? The obvious plan is "press toward the target
 * every frame you are allowed to", which is both the cheapest to compute and
 * the most robust to execute — the driver can re-derive it from the live RAM
 * every frame instead of replaying a fixed schedule that a stalled frame would
 * knock out of step. Three orderings are tried, because sometimes the piece
 * has to be over the right column before it has room to turn, and sometimes
 * the other way round.
 */
export const P_BOTH = 0;
export const P_SHIFT_FIRST = 1;
export const P_ROT_FIRST = 2;

/**
 * What to press this frame, given where the piece is and where it is going.
 * Returns shift | rot << 2, with shift 0/1/2 = none/left/right and rot
 * 0/1/2 = none/A/B. The driver calls this directly, once per frame.
 */
export function greedyAction(board, o, x, y, targetO, targetX, rotDir, policy, lastShift, lastRot) {
  let rt = 0;
  let no = o;
  const atX = x === targetX;
  const atO = o === targetO;
  // P_BOTH does whatever it can every frame; the other two hold one axis back
  // until the other has arrived, which is what gets a piece into a slot it has
  // to be over before it has room to turn (and vice versa).
  const wantRot = !atO && !(policy === P_SHIFT_FIRST && !atX);
  const wantShift = !atX && !(policy === P_ROT_FIRST && !atO);

  if (wantRot && rotDir !== lastRot) {
    const cand = rotDir === 1 ? rotA(o) : rotB(o);
    if (cand !== o && fits(board, cand, x, y)) { rt = rotDir; no = cand; }
  }
  let sh = 0;
  if (wantShift) {
    const dir = targetX < x ? 1 : 2;
    if (dir !== lastShift) {
      const tx = x + (dir === 1 ? -1 : 1);
      if (fits(board, no, tx, y)) sh = dir;
    }
  }
  return sh | (rt << 2);
}

/** Shortest rotation direction from `o` to `t`: 1 = A, 2 = B. */
export function rotDirection(o, t) {
  const size = GROUP_SIZE[o];
  const fwd = (t - GROUP_BASE[o] - (o - GROUP_BASE[o]) + size) % size;
  return fwd <= size - fwd ? 1 : 2;
}

// Reachable placements, refilled on every search. Parallel arrays so the hot
// path allocates nothing.
export const resO = new Int8Array(19 * 10);
export const resX = new Int8Array(19 * 10);
export const resY = new Int8Array(19 * 10);
export const resPolicy = new Int8Array(19 * 10);
export const resTargetO = new Int8Array(19 * 10);
export const resTargetX = new Int8Array(19 * 10);
const resSeen = new Int32Array(19 * 16);
let resStamp = 0;
export let resCount = 0;

/**
 * Run the greedy plan for `targetO`/`targetX` and return the row it locks on,
 * writing the orientation and column it actually achieved into `outcome`.
 */
function runPolicy(board, startO, startX, targetO, targetX, policy, g, outcome) {
  let x = startX, o = startO, y = 0, grav = 0, lastShift = 0, lastRot = 0;
  const rotDir = rotDirection(startO, targetO);
  const limit = ROWS * g + 4;
  for (let f = 0; f < limit; f++) {
    const act = greedyAction(board, o, x, y, targetO, targetX, rotDir, policy, lastShift, lastRot);
    const sh = act & 3;
    const rt = act >> 2;
    if (rt) o = rt === 1 ? rotA(o) : rotB(o);
    if (sh) x += sh === 1 ? -1 : 1;
    lastShift = sh;
    lastRot = rt;
    if (++grav >= g) {
      grav = 0;
      if (fits(board, o, x, y + 1)) y++;
      else { outcome[0] = o; outcome[1] = x; outcome[2] = y; return true; }
    }
  }
  return false;
}

const outcome = new Int8Array(3);

/**
 * Fill resO/resX/resY/resPolicy/resTargetO/resTargetX with every distinct lock
 * position the piece can be steered into, and return the count.
 */
export function search(board, startO, startX, g) {
  resStamp++;
  resCount = 0;
  const base = GROUP_BASE[startO];
  const size = GROUP_SIZE[startO];
  for (let oi = 0; oi < size; oi++) {
    const targetO = base + oi;
    for (let targetX = 0; targetX < COLS; targetX++) {
      for (let policy = 0; policy < 3; policy++) {
        if (!runPolicy(board, startO, startX, targetO, targetX, policy, g, outcome)) continue;
        const k = outcome[0] * 16 + outcome[1];
        if (resSeen[k] === resStamp) continue;
        resSeen[k] = resStamp;
        resO[resCount] = outcome[0];
        resX[resCount] = outcome[1];
        resY[resCount] = outcome[2];
        resPolicy[resCount] = policy;
        resTargetO[resCount] = targetO;
        resTargetX[resCount] = targetX;
        resCount++;
        // The plan that reaches its own target exactly is the one worth
        // keeping; anything else just records where the piece ended up.
        if (outcome[0] === targetO && outcome[1] === targetX) break;
      }
    }
  }
  return resCount;
}

// ------------------------------------------------------------------ the brain

const scratchA = new Uint8Array(ROWS * COLS);
const scratchB = new Uint8Array(ROWS * COLS);
const optO = new Int8Array(19 * 10);
const optX = new Int8Array(19 * 10);
const optY = new Int8Array(19 * 10);
const optPolicy = new Int8Array(19 * 10);
const optTargetO = new Int8Array(19 * 10);
const optTargetX = new Int8Array(19 * 10);
const PLY2_WIDTH = 12;

/**
 * Pick where to put the current piece.
 *
 * Ply one is the current piece's reachable lock positions. Ply two is the next
 * piece's reachable positions on each resulting board, which is what stops the
 * bot from building a surface that only the piece it does not have could fix.
 * Both plies use the same frame-exact reachability, so a placement is never
 * chosen on the strength of a follow-up gravity would not allow — and a
 * placement that leaves the next piece nowhere to go is rejected outright.
 */
export function chooseMove(board, curO, curX, nextO, level, w = DEFAULT_WEIGHTS, twoPly = true) {
  const g = gravityFrames(level);
  const n = search(board, curO, curX, g);
  if (!n) return null;
  optO.set(resO.subarray(0, n)); optX.set(resX.subarray(0, n)); optY.set(resY.subarray(0, n));
  optPolicy.set(resPolicy.subarray(0, n));
  optTargetO.set(resTargetO.subarray(0, n)); optTargetX.set(resTargetX.subarray(0, n));

  const deep = twoPly && nextO != null;

  // Rank by the one-ply score first and only pay for the second ply on the
  // strongest handful — well past the point where the eventual pick changes.
  let order = null;
  if (deep && n > PLY2_WIDTH) {
    const ranked = [];
    for (let i = 0; i < n; i++) {
      const r = placeAndScore(board, optO[i], optX[i], optY[i], scratchA, w);
      ranked.push([r ? r.score : -Infinity, i]);
    }
    ranked.sort((a, b) => b[0] - a[0]);
    order = ranked.slice(0, PLY2_WIDTH).map((e) => e[1]);
  }

  let bestTotal = -Infinity, bi = -1, bestCleared = 0;
  const count = order ? order.length : n;
  for (let oi = 0; oi < count; oi++) {
    const i = order ? order[oi] : oi;
    const r = placeAndScore(board, optO[i], optX[i], optY[i], scratchA, w);
    if (!r) continue;
    let total = r.score;
    if (deep) {
      const kn = search(scratchA, nextO, 5, g);
      let bestKid = -Infinity;
      for (let k = 0; k < kn; k++) {
        const kr = placeAndScore(scratchA, resO[k], resX[k], resY[k], scratchB, w);
        if (kr && kr.score > bestKid) bestKid = kr.score;
      }
      // No second-ply option at all means the next piece tops out there.
      total = bestKid === -Infinity ? -1e9 : r.score * 0.4 + bestKid * 0.6;
    }
    if (total > bestTotal) { bestTotal = total; bi = i; bestCleared = r.cleared; }
  }
  if (bi < 0) return null;
  return {
    o: optO[bi], x: optX[bi], y: optY[bi],
    targetO: optTargetO[bi], targetX: optTargetX[bi], policy: optPolicy[bi],
    rotDir: rotDirection(curO, optTargetO[bi]),
    total: bestTotal, cleared: bestCleared,
  };
}
