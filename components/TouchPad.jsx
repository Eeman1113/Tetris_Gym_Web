"use client";

import { memo, useCallback, useEffect, useRef } from "react";
import { BTN } from "@/lib/buttons";

/* ---------------------------------------------------------------------------
   THE PIXEL GRID
   One user unit in this viewBox is exactly ONE ART PIXEL. The reference skin
   was traced in a 768 x 658 space; this is that space divided by 4, which puts
   an art pixel at about 2 CSS px on a 390px-wide phone — chunky enough to read
   as pixel art while keeping the traced proportions within a unit (the
   measured edges do not all land on whole numbers; they are rounded to the
   grid, and the relationships between them survive).
   Every x / y / width / height / radius in this file is an integer in that
   grid, the root <svg> uses shape-rendering="crispEdges", and there are no
   gradients and no filters anywhere: shading is a flat base, one hard lighter
   tone on the top-left, one hard darker tone on the bottom-right, and a
   two-unit outline on every part.
--------------------------------------------------------------------------- */
const W = 192;
const H = 165;

// d-pad: plus centred on (44,74) — vertical arm 28 x 74, horizontal 78 x 26.
const DPAD = { cx: 44, cy: 74, reach: 39, diag: 0.38 };
const VW = 14; // vertical arm half-width
const VH = 37; // vertical arm half-height
const HW = 39; // horizontal arm half-width
const HH = 13; // horizontal arm half-height
const BAND = 3; // step between the d-pad's shading layers

const EMPTY = new Set();

// face cluster: a true diamond around (138,73), 27 units out on each axis.
const FACE = [
  { id: "X", cx: 138, cy: 46, btn: BTN.A },
  { id: "Y", cx: 111, cy: 73, btn: BTN.B },
  { id: "A", cx: 165, cy: 73, btn: BTN.A },
  { id: "B", cx: 138, cy: 100, btn: BTN.B },
];

// Buttons sit exactly where the reference skin puts them (11 / 80 / 112). The
// bitmap labels are wider than the smooth text they replace, so each label has
// its own x: MENU's would otherwise overhang the left edge, and SELECT and
// START would run into one another. The offsets are small against the width of
// the words themselves, and every label still reads as belonging to its button.
const CAPS = [
  { x: 11, lx: 15, label: "MENU" },
  { x: 80, lx: 78, label: "SELECT" },
  { x: 112, lx: 117, label: "START" },
];

/* --- pixel geometry -------------------------------------------------------- */

// Stair-stepped disc, midpoint-circle flavoured: one row of whole pixels per
// `step` units, each row's half-width snapped to `step` too, so the steps are
// chunky in both axes and the silhouette is symmetric about the centre.
// `r` and `step` are chosen so r % step === 0, which keeps every row aligned.
function discRows(cx, cy, r, step) {
  const rows = [];
  for (let y = cy - r; y < cy + r; y += step) {
    const dy = Math.abs(y + step / 2 - cy);
    const hw =
      Math.round(Math.sqrt(Math.max(r * r - dy * dy, 0)) / step) * step;
    if (hw > 0) rows.push([cx - hw, y, 2 * hw]);
  }
  return rows;
}

// Clip one row set to another. Shaded layers are offset copies of the
// silhouette, and this stops them spilling past its stair steps.
function clipRows(rows, bound) {
  const by = new Map(bound.map(([x, y, w]) => [y, [x, w]]));
  const out = [];
  for (const [x, y, w] of rows) {
    const b = by.get(y);
    if (!b) continue;
    const x0 = Math.max(x, b[0]);
    const x1 = Math.min(x + w, b[0] + b[1]);
    if (x1 > x0) out.push([x0, y, x1 - x0]);
  }
  return out;
}

const rowRects = (rows, fill, h) =>
  rows.map(([x, y, w], i) => (
    <rect key={i} x={x} y={y} width={w} height={h} fill={fill} />
  ));

// A raised round part in three tones. Four flat layers, painted in this order:
// the outline silhouette, the lit tone filling it, the shadow crescent offset
// down-right, then the base inset clear of both — which leaves the lit tone
// showing as a crescent along the top-left.
function Disc({ cx, cy, r, step, base, lit, dark, outline }) {
  const core = discRows(cx, cy, r - step, step);
  return (
    <>
      {rowRects(discRows(cx, cy, r, step), outline, step)}
      {rowRects(core, lit, step)}
      {rowRects(
        clipRows(discRows(cx + step, cy + step, r - step, step), core),
        dark,
        step
      )}
      {rowRects(clipRows(discRows(cx, cy, r - 2 * step, step), core), base, step)}
    </>
  );
}

// Same three-tone scheme on a rectangle, with the same two-unit outline the
// discs carry, then a `band`-thick highlight along top/left and shadow along
// bottom/right.
const RING = 2; // outline thickness, uniform across every part of the pad
function Plate({ x, y, w, h, band, base, lit, dark, outline }) {
  const i = RING;
  return (
    <>
      <rect x={x} y={y} width={w} height={h} fill={outline} />
      <rect x={x + i} y={y + i} width={w - 2 * i} height={h - 2 * i} fill={lit} />
      <rect
        x={x + i + band}
        y={y + i + band}
        width={w - 2 * i - band}
        height={h - 2 * i - band}
        fill={dark}
      />
      <rect
        x={x + i + band}
        y={y + i + band}
        width={w - 2 * i - 2 * band}
        height={h - 2 * i - 2 * band}
        fill={base}
      />
    </>
  );
}

// The d-pad plus, inset by `d` on every edge. Axis-aligned H/V segments only,
// so every vertex is a whole grid unit.
const plus = (cx, cy, d) => {
  const a = VW - d;
  const b = VH - d;
  const c = HW - d;
  const e = HH - d;
  return (
    `M${cx - a} ${cy - b}H${cx + a}V${cy - e}H${cx + c}V${cy + e}` +
    `H${cx + a}V${cy + b}H${cx - a}V${cy + e}H${cx - c}V${cy - e}H${cx - a}Z`
  );
};

// Blocky stair-stepped arrow: `n` steps, each `rise` tall, growing one unit
// wider per side per step. Measured from the tip. The stair is deliberately
// shallower than the 2x2 steps elsewhere — a triangle as wide as it is tall
// can only be drawn with a 1-per-side stair, and matching the reference's
// roughly square arrows matters more than matching step size.
function Arrow({ dir, tx, ty, n = 6, rise = 2, fill }) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const half = i + 1;
    if (dir === "up" || dir === "down") {
      const y = dir === "up" ? ty + i * rise : ty - (i + 1) * rise;
      out.push([tx - half, y, 2 * half, rise]);
    } else {
      const x = dir === "left" ? tx + i * rise : tx - (i + 1) * rise;
      out.push([x, ty - half, rise, 2 * half]);
    }
  }
  return (
    <>
      {out.map(([x, y, w, h], i) => (
        <rect key={i} x={x} y={y} width={w} height={h} fill={fill} />
      ))}
    </>
  );
}

/* --- 5x7 bitmap font ------------------------------------------------------ */
// Only the glyphs this pad needs. Each glyph is 5 wide and 7 tall with a
// 1-column gap, so one character advances 6 units; every lit pixel is drawn as
// one <rect> of `scale` grid units. 5x7 rather than 3x5 because M, N and X are
// not tellable apart three pixels wide.
const GLYPHS = {
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  B: ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
  C: [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  L: ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
  M: ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
  N: ["#...#", "##..#", "##..#", "#.#.#", "#..##", "#..##", "#...#"],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  U: ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  X: ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"],
  Y: ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
};
const ADVANCE = 6; // glyph width + one blank column

// Draws `text` centred on cx with its cap line at `top`.
function Word({ text, cx, top, scale, fill }) {
  const span = (text.length * ADVANCE - 1) * scale;
  const x0 = cx - Math.round(span / 2);
  const out = [];
  for (let i = 0; i < text.length; i++) {
    const glyph = GLYPHS[text[i]];
    if (!glyph) continue;
    for (let ry = 0; ry < glyph.length; ry++) {
      for (let rx = 0; rx < glyph[ry].length; rx++) {
        if (glyph[ry][rx] !== "#") continue;
        out.push(
          <rect
            key={`${i}.${rx}.${ry}`}
            x={x0 + i * ADVANCE * scale + rx * scale}
            y={top + ry * scale}
            width={scale}
            height={scale}
            fill={fill}
          />
        );
      }
    }
  }
  return <>{out}</>;
}

/* --- ridges --------------------------------------------------------------- */
// The two light diagonal ridges, Y -> X and B -> A. A 45-degree band drawn as
// a run of 24 x 24 squares stepped 3 units at a time: the overlap fuses into
// one band whose edges are deliberate 3-unit stairs. A square run on a
// 45-degree line is sqrt(2) wider than the square, so 24 reproduces the
// measured 134-unit (33.5 grid unit) capsule. The run overshoots both ends by
// one step so the band tucks under the buttons, as the capsule caps did.
const RIDGE_HALF = 12;
const RIDGE_STEP = 3;
const ridgeSquares = (x1, y1, x2, y2) => {
  const n = Math.abs(x2 - x1);
  const sx = Math.sign(x2 - x1);
  const sy = Math.sign(y2 - y1);
  const out = [];
  for (let t = RIDGE_STEP; t <= n - RIDGE_STEP; t += RIDGE_STEP) {
    out.push([x1 + sx * t - RIDGE_HALF, y1 + sy * t - RIDGE_HALF]);
  }
  return out;
};

/* --- haptics -------------------------------------------------------------- */
// On by default, no setting. Slight on purpose: a 6ms tick on press, a 3ms one
// when a sliding thumb crosses into a new direction, nothing on release.
// iOS Safari has no navigator.vibrate, and a bare call can throw, so guard.
const buzz = (ms) => {
  try {
    if (typeof navigator !== "undefined" && navigator.vibrate) {
      navigator.vibrate(ms);
    }
  } catch {
    /* vibration is a nicety; never let it break input */
  }
};
const sameDirs = (a, b) => {
  if (!a || a.size !== b.size) return false;
  for (const v of b) if (!a.has(v)) return false;
  return true;
};

function TouchPad({ pad, onMenu }) {
  // Each touch pointer is its own token in the pad's refcount, so a second
  // finger landing on a button another finger already holds cannot release it,
  // and lifting one finger never cancels the other.
  const token = (e) => `t:${e.pointerId}`;
  // Last direction set per live pointer, for the slide-across-the-d-pad tick.
  const dirs = useRef(new Map());

  // Which pieces of art each live pointer is lighting up. Haptics are not
  // dependable — iOS Safari has no navigator.vibrate at all, and a silenced
  // phone suppresses the rest — so a press has to be visible. Kept out of
  // React state and applied straight to the DOM: a press must never cost a
  // re-render of 800 rects, and the art is memoised precisely so it doesn't.
  const art = useRef(new Map()); // visual id -> <g>
  const litBy = useRef(new Map()); // pointer token -> Set<visual id>
  const regArt = (id) => (el) => {
    if (el) art.current.set(id, el);
    else art.current.delete(id);
  };
  // Sets the class on every registered piece rather than diffing against what
  // was set last time: a React re-render would rewrite className from the JSX
  // and silently drop a class a diff still believed was there.
  const syncArt = () => {
    const want = new Set();
    for (const ids of litBy.current.values()) for (const id of ids) want.add(id);
    for (const [id, el] of art.current) el.classList.toggle("down", want.has(id));
  };
  const light = (tok, ids) => {
    if (ids && ids.size) litBy.current.set(tok, ids);
    else litBy.current.delete(tok);
    syncArt();
  };
  const ARROW_OF = {
    [BTN.UP]: "up",
    [BTN.DOWN]: "down",
    [BTN.LEFT]: "left",
    [BTN.RIGHT]: "right",
  };

  // This component unmounts the instant a real controller is detected. If a
  // thumb is down at that moment no pointerup, pointercancel or
  // lostpointercapture ever reaches the removed element, so without this the
  // token stays in the pad's refcount and that button is held for the rest of
  // the session. Same story when the page is hidden mid-press.
  useEffect(() => {
    const releaseAll = () => {
      dirs.current.clear();
      litBy.current.clear();
      syncArt();
      pad.releaseNamespace("t:");
    };
    const onHide = () => {
      if (document.hidden) releaseAll();
    };
    window.addEventListener("pagehide", releaseAll);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", releaseAll);
      document.removeEventListener("visibilitychange", onHide);
      releaseAll();
    };
  }, [pad]);

  const grab = (e) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const end = useCallback(
    (e) => {
      dirs.current.delete(token(e));
      light(token(e), EMPTY);
      pad.hold(token(e), EMPTY);
    },
    [pad]
  );

  const btnProps = (btn, id) => ({
    onPointerDown: (e) => {
      grab(e);
      buzz(6);
      light(token(e), new Set([id]));
      pad.hold(token(e), new Set([btn]));
    },
    onPointerUp: end,
    onPointerCancel: end,
    onLostPointerCapture: end,
    onContextMenu: (e) => e.preventDefault(),
  });

  // One hit area with geometric hit-testing rather than four child elements:
  // touch pointers get implicit capture on the element they land on, so child
  // cells would keep reporting the first cell touched and sliding from left to
  // right without lifting off would be impossible.
  const dpadAt = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
    const y = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
    const out = new Set();
    if (Math.hypot(x, y) < 0.22) return out; // dead centre
    if (x < -DPAD.diag) out.add(BTN.LEFT);
    else if (x > DPAD.diag) out.add(BTN.RIGHT);
    if (y < -DPAD.diag) out.add(BTN.UP);
    else if (y > DPAD.diag) out.add(BTN.DOWN);
    if (out.size === 0) {
      if (Math.abs(x) > Math.abs(y)) out.add(x < 0 ? BTN.LEFT : BTN.RIGHT);
      else out.add(y < 0 ? BTN.UP : BTN.DOWN);
    }
    return out;
  };

  const dpadProps = {
    onPointerDown: (e) => {
      grab(e);
      const next = dpadAt(e);
      if (next.size) buzz(6); // a dead-centre press holds nothing, so stays silent
      dirs.current.set(token(e), next);
      light(token(e), new Set([...next].map((b) => ARROW_OF[b])));
      pad.hold(token(e), next);
    },
    onPointerMove: (e) => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
      const next = dpadAt(e);
      if (!sameDirs(dirs.current.get(token(e)), next)) {
        dirs.current.set(token(e), next);
        light(token(e), new Set([...next].map((b) => ARROW_OF[b])));
        if (next.size) buzz(3); // crossed into a new direction mid-slide
      }
      pad.hold(token(e), next);
    },
    onPointerUp: end,
    onPointerCancel: end,
    onLostPointerCapture: end,
    onContextMenu: (e) => e.preventDefault(),
  };

  return (
    <svg
      className="pad"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid meet"
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      {/* top edge: a black strip with the shoulder tabs hanging below it */}
      <rect x={0} y={0} width={W} height={7} fill="#000" />
      {[-10, 138].map((x) => (
        <Plate
          key={x}
          x={x}
          y={0}
          w={64}
          h={17}
          band={2}
          base="var(--tab)"
          lit="var(--tab-lit)"
          dark="var(--tab-dark)"
          outline="var(--outline)"
        />
      ))}
      <Word text="L" cx={27} top={5} scale={1} fill="var(--tab-ink)" />
      <Word text="R" cx={164} top={5} scale={1} fill="var(--tab-ink)" />

      {/* d-pad: one plus, outlined and stepped, with blocky arrows and a hub */}
      <path d={plus(DPAD.cx, DPAD.cy, 0)} fill="var(--outline)" />
      <path d={plus(DPAD.cx, DPAD.cy, RING)} fill="var(--dpad-lit)" />
      <path
        d={plus(DPAD.cx + BAND, DPAD.cy + BAND, RING + BAND)}
        fill="var(--dpad-dark)"
      />
      <path d={plus(DPAD.cx, DPAD.cy, RING + 2 * BAND)} fill="var(--dpad)" />
      {/* Tips sit inside the face of each arm, clear of the bevel: the
          vertical face runs y 44..104 and the horizontal one x 12..76. The
          horizontal pair takes one step fewer because that arm is the shorter
          of the two in the reference, exactly as it is here. Each arrow is its
          own group so a held direction can light up on its own. */}
      {[
        { dir: "up", tx: 44, ty: 45, n: 6 },
        { dir: "down", tx: 44, ty: 103, n: 6 },
        { dir: "left", tx: 13, ty: 74, n: 5 },
        { dir: "right", tx: 75, ty: 74, n: 5 },
      ].map(({ dir, tx, ty, n }) => (
        <g key={dir} className="key" ref={regArt(dir)} fill="var(--c-arrow)">
          <Arrow dir={dir} tx={tx} ty={ty} n={n} />
        </g>
      ))}
      <Disc
        cx={44}
        cy={74}
        r={8}
        step={2}
        base="var(--dpad)"
        lit="var(--dpad-lit)"
        dark="var(--dpad-dark)"
        outline="var(--outline)"
      />

      {/* face cluster: a stepped grey disc, two light ridges, four buttons */}
      <Disc
        cx={138}
        cy={73}
        r={48}
        step={2}
        base="var(--cluster)"
        lit="var(--cluster-lit)"
        dark="var(--cluster-dark)"
        outline="var(--outline)"
      />
      <g fill="var(--ridge)">
        {[
          ridgeSquares(111, 73, 138, 46),
          ridgeSquares(138, 100, 165, 73),
        ].map((squares, r) =>
          squares.map(([x, y], i) => (
            <rect
              key={`${r}.${i}`}
              x={x}
              y={y}
              width={RIDGE_HALF * 2}
              height={RIDGE_HALF * 2}
            />
          ))
        )}
      </g>
      {FACE.map(({ id, cx, cy }) => (
        <g
          key={id}
          className="key"
          ref={regArt(id)}
          style={{
            "--up-base": `var(--btn-${id})`,
            "--up-lit": `var(--btn-${id}-lit)`,
            "--up-dark": `var(--btn-${id}-dark)`,
          }}
        >
          <Disc
            cx={cx}
            cy={cy}
            r={14}
            step={2}
            base="var(--c-base)"
            lit="var(--c-lit)"
            dark="var(--c-dark)"
            outline="var(--outline)"
          />
          <Word text={id} cx={cx} top={cy - 7} scale={2} fill={`var(--btn-${id}-ink)`} />
        </g>
      ))}

      {/* menu / select / start */}
      {CAPS.map(({ x, lx, label }) => (
        <g key={label}>
          <g
            className="key"
            ref={regArt(label)}
            style={{
              "--up-base": "var(--cap)",
              "--up-lit": "var(--cap-lit)",
              "--up-dark": "var(--cap-dark)",
            }}
          >
            <Disc
              cx={x}
              cy={128}
              r={6}
              step={2}
              base="var(--c-base)"
              lit="var(--c-lit)"
              dark="var(--c-dark)"
              outline="var(--outline)"
            />
          </g>
          {/* the label is printed on the shell, so it does not sink */}
          <Word text={label} cx={lx} top={138} scale={1} fill="var(--ink)" />
        </g>
      ))}

      {/* Transparent hit targets, sized for thumbs rather than for looks: the
          same reach as before (every radius here is the old one / 4, rounded
          up), and none of them overlap. Nothing in this group is visible, so
          plain circles are the right shape for accuracy. */}
      <g className="hit" fill="transparent">
        <rect
          x={DPAD.cx - DPAD.reach}
          y={DPAD.cy - DPAD.reach}
          width={DPAD.reach * 2}
          height={DPAD.reach * 2}
          {...dpadProps}
        />
        {FACE.map(({ id, cx, cy, btn }) => (
          <circle key={id} cx={cx} cy={cy} r={16} {...btnProps(btn, id)} />
        ))}
        <circle cx={80} cy={129} r={12} {...btnProps(BTN.SELECT, "SELECT")} />
        <circle cx={112} cy={129} r={12} {...btnProps(BTN.START, "START")} />
        <circle
          cx={11}
          cy={129}
          r={12}
          onContextMenu={(e) => e.preventDefault()}
          onPointerDown={(e) => {
            grab(e);
            buzz(6);
            light(token(e), new Set(["MENU"]));
            onMenu();
          }}
          onPointerUp={(e) => light(token(e), EMPTY)}
          onPointerCancel={(e) => light(token(e), EMPTY)}
          onLostPointerCapture={(e) => light(token(e), EMPTY)}
        />
      </g>
    </svg>
  );
}

// 800-odd rects of static art. `pad` is stable for the emulator's lifetime and
// Game memoises `onMenu`, so this lets React skip the whole subtree whenever
// Game re-renders for something unrelated.
export default memo(TouchPad);
