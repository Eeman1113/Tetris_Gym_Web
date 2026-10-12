/** @type {import('next').NextConfig} */

// Set in CI to "/Tetris_Gym_Web" so the GitHub Pages project URL resolves, and
// left empty for local dev so the app still serves from the root.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

const nextConfig = {
  // Fully static: the app is one client page with no server work to do.
  output: "export",
  basePath,
  trailingSlash: true,
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
  // A stray lockfile one directory up would otherwise be inferred as the root.
  turbopack: { root: import.meta.dirname },
  // The emulator is a single long-lived instance; a double mount would run two.
  reactStrictMode: false,
};

export default nextConfig;
