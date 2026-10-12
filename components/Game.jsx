"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { BASE } from "@/lib/base";
import { createNes } from "@/lib/nes";
import { createPad } from "@/lib/pad";
import { bindKeyboard } from "@/lib/keyboard";
import { bindGamepads } from "@/lib/gamepad";
import TouchPad from "./TouchPad";

const ROM_URL = `${BASE}/game.nes`;

// Primary pointer is a finger that cannot hover: a phone or tablet.
// Deliberately not `any-pointer`, which also matches a touchscreen laptop
// being driven by its trackpad.
const COARSE = "(pointer: coarse) and (hover: none)";

function subscribeCoarse(cb) {
  const mq = window.matchMedia(COARSE);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

function useTouchPrimary() {
  return useSyncExternalStore(
    subscribeCoarse,
    () => window.matchMedia(COARSE).matches,
    () => false, // never render touch controls during SSR
  );
}

export default function Game() {
  const canvasRef = useRef(null);
  const emuRef = useRef(null);
  const [pad, setPad] = useState(null);
  const [gamepadPresent, setGamepadPresent] = useState(false);
  const [failed, setFailed] = useState(null);
  const touchPrimary = useTouchPrimary();

  useEffect(() => {
    let disposed = false;
    let emulator = null;
    const cleanups = [];

    // Every input source funnels its button edges through one refcounted pad,
    // which forwards them to whichever emulator instance is live.
    const input = createPad({
      down: (b) => emuRef.current?.down(b),
      up: (b) => emuRef.current?.up(b),
    });

    cleanups.push(bindKeyboard(input));
    cleanups.push(bindGamepads(input, { onPresence: setGamepadPresent }));

    // Browsers hold the audio device until a real gesture. The picture starts
    // immediately regardless; this just lets the sound in when it can.
    const unlock = () => emuRef.current?.unlockAudio();
    for (const type of ["pointerdown", "keydown", "touchstart"]) {
      window.addEventListener(type, unlock);
      cleanups.push(() => window.removeEventListener(type, unlock));
    }

    // Boot straight into the game — there is nothing else this app does.
    (async () => {
      try {
        const res = await fetch(ROM_URL);
        if (!res.ok) throw new Error(`Could not load the game (${res.status})`);
        const rom = new Uint8Array(await res.arrayBuffer());
        if (disposed) return;

        emulator = await createNes(canvasRef.current, rom, {
          workletUrl: `${BASE}/nes-audio-worklet.js`,
          onError: (e) => setFailed(e.message || String(e)),
        });
        if (disposed) {
          emulator.destroy();
          return;
        }
        emuRef.current = emulator;
        emulator.start();
        setPad(input);
      } catch (e) {
        if (!disposed) setFailed(e.message || String(e));
      }
    })();

    return () => {
      disposed = true;
      for (const fn of cleanups) fn();
      emuRef.current = null;
      emulator?.destroy();
    };
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  }, []);

  const showTouch = touchPrimary && !gamepadPresent;

  return (
    <main className="root">
      <div className="screen">
        <canvas ref={canvasRef} width={256} height={240} />
        {failed && <p className="error">{failed}</p>}
      </div>
      {showTouch && pad && <TouchPad pad={pad} onMenu={toggleFullscreen} />}
    </main>
  );
}
