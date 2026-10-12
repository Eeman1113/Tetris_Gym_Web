"use client";

import { useCallback } from "react";
import { BTN } from "@/lib/buttons";

// Geometry and colour are traced pixel for pixel from the reference skin: a
// 768 x 658 design space, reproduced as vectors so it stays sharp at any size.
const W = 768;
const H = 658;

const DPAD = { cx: 174, cy: 296, reach: 156, diag: 0.38 };
const EMPTY = new Set();

const FACE = [
  { id: "X", cx: 549, cy: 182, btn: BTN.A },
  { id: "Y", cx: 443, cy: 293, btn: BTN.B },
  { id: "A", cx: 660, cy: 292, btn: BTN.A },
  { id: "B", cx: 554, cy: 404, btn: BTN.B },
];

export default function TouchPad({ pad, onMenu }) {
  // Each touch pointer is its own token in the pad's refcount, so a second
  // finger landing on a button another finger already holds cannot release it,
  // and lifting one finger never cancels the other.
  const token = (e) => `t:${e.pointerId}`;

  const grab = (e) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    if (navigator.vibrate) navigator.vibrate(6);
  };
  const end = useCallback((e) => pad.hold(token(e), EMPTY), [pad]);

  const btnProps = (btn) => ({
    onPointerDown: (e) => {
      grab(e);
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
      pad.hold(token(e), dpadAt(e));
    },
    onPointerMove: (e) => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
      pad.hold(token(e), dpadAt(e));
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
      aria-hidden="true"
    >
      <defs>
        {/* Rubber d-pad: lit across the middle, falling away toward the tips. */}
        <radialGradient
          id="dpadFace"
          gradientUnits="userSpaceOnUse"
          cx="174"
          cy="296"
          r="170"
        >
          <stop offset="0" stopColor="var(--dpad-lit)" />
          <stop offset="1" stopColor="var(--dpad-dim)" />
        </radialGradient>
        <radialGradient id="hub" cx="0.4" cy="0.35" r="0.85">
          <stop offset="0" stopColor="var(--dpad-lit)" />
          <stop offset="1" stopColor="var(--dpad-dim)" />
        </radialGradient>
        {FACE.map(({ id }) => (
          <radialGradient key={id} id={`face${id}`} cx="0.36" cy="0.3" r="0.9">
            <stop offset="0" stopColor={`var(--btn-${id}-lit)`} />
            <stop offset="1" stopColor={`var(--btn-${id})`} />
          </radialGradient>
        ))}
        <radialGradient id="cap" cx="0.4" cy="0.32" r="0.85">
          <stop offset="0" stopColor="var(--cap-lit)" />
          <stop offset="1" stopColor="var(--cap)" />
        </radialGradient>
        <filter id="lift" x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="5" stdDeviation="6" floodOpacity="0.3" />
        </filter>
        <filter id="liftSm" x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow dx="0" dy="2" stdDeviation="2.5" floodOpacity="0.28" />
        </filter>
      </defs>

      {/* top edge: a black strip with the shoulder buttons hanging below it */}
      <rect x={0} y={0} width={W} height={28} fill="#000" />
      <rect x={-40} y={0} width={257} height={67} rx={16} fill="var(--tab)" />
      <rect x={550} y={0} width={258} height={67} rx={16} fill="var(--tab)" />
      <text className="cap" x={108} y={52} fill="#f4f4f4" fontSize="26">
        L
      </text>
      <text className="cap" x={657} y={52} fill="#f4f4f4" fontSize="26">
        R
      </text>

      {/* d-pad */}
      <g filter="url(#lift)">
        <rect x={118} y={149} width={113} height={298} rx={24} fill="url(#dpadFace)" />
        <rect x={19} y={247} width={311} height={101} rx={24} fill="url(#dpadFace)" />
      </g>
      <g fill="var(--arrow)">
        <polygon points="174,171 201,219 147,219" />
        <polygon points="174,425 201,377 147,377" />
        <polygon points="41,298 89,271 89,325" />
        <polygon points="308,298 260,271 260,325" />
      </g>
      <circle cx={174} cy={296} r={29} fill="url(#hub)" />

      {/* face cluster: a grey disc, two light ridges, four buttons */}
      <circle cx={551} cy={289} r={195} fill="var(--cluster)" />
      <g stroke="var(--ridge)" strokeWidth={134} strokeLinecap="round" fill="none">
        <line x1={443} y1={293} x2={549} y2={182} />
        <line x1={554} y1={404} x2={660} y2={292} />
      </g>
      {FACE.map(({ id, cx, cy }) => (
        <circle
          key={id}
          cx={cx}
          cy={cy}
          r={55}
          fill={`url(#face${id})`}
          stroke="#111"
          strokeWidth={4}
          filter="url(#lift)"
        />
      ))}
      <g className="face">
        {FACE.map(({ id, cx, cy }) => (
          <text key={id} x={cx} y={cy + 22} fill={`var(--btn-${id}-ink)`} fontSize="64">
            {id}
          </text>
        ))}
      </g>

      {/* menu / select / start */}
      {[
        [44, "MENU"],
        [322, "SELECT"],
        [446, "START"],
      ].map(([x, label]) => (
        <g key={label}>
          <circle cx={x} cy={513} r={22} fill="url(#cap)" filter="url(#liftSm)" />
          <text className="cap" x={x} y={561} fill="var(--ink)" fontSize="20">
            {label}
          </text>
        </g>
      ))}

      {/* transparent hit targets, sized for thumbs rather than for looks */}
      <g className="hit" fill="transparent">
        <rect
          x={DPAD.cx - DPAD.reach}
          y={DPAD.cy - DPAD.reach}
          width={DPAD.reach * 2}
          height={DPAD.reach * 2}
          {...dpadProps}
        />
        {FACE.map(({ id, cx, cy, btn }) => (
          <circle key={id} cx={cx} cy={cy} r={62} {...btnProps(btn)} />
        ))}
        <circle cx={322} cy={516} r={46} {...btnProps(BTN.SELECT)} />
        <circle cx={446} cy={516} r={46} {...btnProps(BTN.START)} />
        <circle
          cx={44}
          cy={516}
          r={46}
          onPointerDown={(e) => {
            e.preventDefault();
            if (navigator.vibrate) navigator.vibrate(6);
            onMenu();
          }}
        />
      </g>
    </svg>
  );
}
