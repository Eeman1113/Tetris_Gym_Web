// GitHub Pages serves this project from a subpath, so runtime fetches for the
// ROM and the audio worklet have to carry the same prefix Next applies to its
// own assets. Empty in local dev.
export const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
