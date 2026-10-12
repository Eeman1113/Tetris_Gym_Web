"use client";

import { useEffect, useRef, useState } from "react";
import { BASE } from "@/lib/base";
import { createNes } from "@/lib/nes";
import { createAutoplay } from "@/lib/autoplay";
import PadLights from "./PadLights";

const ROM_URL = `${BASE}/game.nes`;

// The bot thinks once per piece, roughly twice a second at killscreen speed.
// Sampling its state 12 times a second is plenty to read and costs the
// emulator — which is pacing itself against the audio clock on this thread —
// almost nothing.
const SAMPLE_MS = 80;

const EMPTY = {
  state: "booting",
  games: 0,
  level: 0,
  lines: 0,
  score: 0,
  piece: null,
  next: null,
  targetX: null,
  targetRot: null,
  gravity: 0,
  buttons: 0,
  glow: 0,
  searchMs: 0,
  piecesPlaced: 0,
};

export default function Auto() {
  const canvasRef = useRef(null);
  const [view, setView] = useState(EMPTY);
  const [reboots, setReboots] = useState(0);
  const [failed, setFailed] = useState(null);

  useEffect(() => {
    let disposed = false;
    let emulator = null;
    let timer = 0;
    let crashes = 0;
    const unlock = () => emulator?.unlockAudio();

    // If the bot ever finds itself on a screen it cannot move off, power-cycle
    // the console rather than sit there. Nothing is lost: it boots straight
    // back to the mode menu and the bot walks the same path in again.
    const bot = createAutoplay({
      onStuck: () => {
        emulator?.reset();
        bot.reset();
        crashes = 0;
      },
    });

    (async () => {
      try {
        const res = await fetch(ROM_URL);
        if (!res.ok) throw new Error(`Could not load the game (${res.status})`);
        const rom = new Uint8Array(await res.arrayBuffer());
        if (disposed) return;

        emulator = await createNes(canvasRef.current, rom, {
          workletUrl: `${BASE}/nes-audio-worklet.js`,
          // The ROM itself can fall over once the level counter climbs far
          // enough — that is NES Tetris doing it, not the emulator — so a
          // crash is just another thing to reboot out of. Three in a row
          // without the bot getting anywhere means something else is wrong,
          // and then it is worth showing.
          onError: (e) => {
            if (!emulator || ++crashes > 3) {
              setFailed(e.message || String(e));
              return;
            }
            emulator.reset();
            bot.reset();
            emulator.start();
            setReboots(crashes);
          },
          // One call per *emulated* frame, not per animation frame: the loop
          // runs several emulated frames inside one rAF while catching up, and
          // a bot that missed those frames would desynchronise from the piece.
          onBeforeFrame: bot.beforeFrame,
        });
        if (disposed) {
          emulator.destroy();
          return;
        }
        emulator.start();
        let seenPieces = 0;
        timer = setInterval(() => {
          // Progress since the last sample means any earlier crash was a
          // one-off, so stop counting it against the reboot budget.
          if (bot.status.piecesPlaced !== seenPieces) {
            seenPieces = bot.status.piecesPlaced;
            crashes = 0;
          }
          setView({ ...bot.status });
        }, SAMPLE_MS);
        // Same deal as on the main page: the picture runs immediately, and the
        // browser lets the sound in the first time the viewer touches anything.
        for (const type of ["pointerdown", "keydown", "touchstart"]) {
          window.addEventListener(type, unlock);
        }
      } catch (e) {
        if (!disposed) setFailed(e.message || String(e));
      }
    })();

    return () => {
      disposed = true;
      if (timer) clearInterval(timer);
      for (const type of ["pointerdown", "keydown", "touchstart"]) {
        window.removeEventListener(type, unlock);
      }
      emulator?.destroy();
    };
  }, []);

  return (
    <main className="root auto">
      <div className="screen">
        <canvas ref={canvasRef} width={256} height={240} />
        {failed && <p className="error">{failed}</p>}
      </div>
      <div className="hud">
        <PadLights glow={view.glow} />
        <dl className="hud-stats">
          <Stat k="state" v={view.state} />
          <Stat k="game" v={view.games + 1} />
          <Stat k="level" v={view.level} />
          <Stat k="lines" v={view.lines} />
          <Stat k="score" v={view.score} />
          <Stat k="piece" v={view.piece ?? "—"} />
          <Stat k="next" v={view.next ?? "—"} />
          <Stat
            k="target"
            v={view.targetX == null ? "—" : `col ${view.targetX} · turn ${view.targetRot}`}
          />
          <Stat k="gravity" v={view.gravity ? `${view.gravity} f/row` : "—"} />
          <Stat k="pieces" v={view.piecesPlaced} />
          <Stat k="reboots" v={reboots} />
          <Stat k="search" v={`${view.searchMs.toFixed(2)} ms`} />
        </dl>
      </div>
    </main>
  );
}

function Stat({ k, v }) {
  return (
    <div className="hud-row">
      <dt>{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}
