"use client";

import { BTN } from "@/lib/buttons";

/**
 * The eight NES buttons, lit as the bot presses them.
 *
 * Laid out like the pad itself — d-pad left, SELECT/START in the middle, B and
 * A on the right — so a glance maps onto the controller rather than onto an
 * abstract bit field. Flat blocks, hard edges, no radius and no animation: the
 * only thing that ever changes is which cells are on, which is the one thing
 * worth noticing.
 *
 * `glow` is a decaying trail rather than the live button mask. At level 29 the
 * bot taps for a single frame (16ms) and releases, which no display can show;
 * the trail holds each press lit for about a tenth of a second so the rhythm
 * of the taps is actually legible.
 */
export default function PadLights({ glow }) {
  const on = (b) => ((glow >> b) & 1) === 1;
  const cell = (b, label, cls = "") => (
    <div className={`pl-key ${cls} ${on(b) ? "on" : ""}`} aria-label={label}>
      {label}
    </div>
  );

  return (
    <div className="pl" role="group" aria-label="controller input">
      <div className="pl-dpad">
        <div />
        {cell(BTN.UP, "▲")}
        <div />
        {cell(BTN.LEFT, "◀")}
        <div className="pl-hub" />
        {cell(BTN.RIGHT, "▶")}
        <div />
        {cell(BTN.DOWN, "▼")}
        <div />
      </div>
      <div className="pl-mid">
        {cell(BTN.SELECT, "SELECT", "pl-wide")}
        {cell(BTN.START, "START", "pl-wide")}
      </div>
      <div className="pl-face">
        {cell(BTN.B, "B", "pl-round")}
        {cell(BTN.A, "A", "pl-round")}
      </div>
    </div>
  );
}
