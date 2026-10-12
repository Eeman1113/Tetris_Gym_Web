# Tetris Gym Online

Tetris Gym in the browser. It boots straight into the game — no menus, no
settings, no start screen.

- **Keyboard**: arrows to move, `Z`/`X` to rotate, `Enter` to start, `Shift` to
  select.
- **Controller**: Xbox, DualSense, 8BitDo and friends, over Bluetooth or USB.
  Plug in or press a button and it is picked up automatically.
- **Phone**: an on-screen SNES pad appears by itself, and gets out of the way
  the moment a controller connects.

Emulation is [jsnes](https://github.com/bfirsh/jsnes) driving a canvas and an
AudioWorklet, paced against the audio clock so it holds 60.0988 Hz regardless of
the display's refresh rate.

## Running it

```sh
npm install
npm run dev
```

Pushing to `main` builds a static export and publishes it to GitHub Pages.
