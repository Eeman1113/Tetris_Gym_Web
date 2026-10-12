import "./globals.css";

export const metadata = {
  title: "Tetris Gym Online",
  description: "Tetris Gym in your browser. Keyboard or controller, nothing else.",
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#000000",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
