import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.ts"],
  theme: {
    extend: {
      colors: {
        bg: "#0D0D0D",
        surface: "#1A1A1A",
        accent: "#00FF87",
        "accent-dim": "#00CC6A",
        warning: "#FF6B35",
        muted: "#888888",
        text: "#E8E8E8",
      },
      fontFamily: {
        mono: ['"Share Tech Mono"', '"IBM Plex Mono"', "monospace"],
        body: ['"IBM Plex Mono"', "monospace"],
      },
    },
  },
  plugins: [],
} satisfies Config;
