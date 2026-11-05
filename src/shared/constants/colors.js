// Kiyoshi palette for 9router-kiyoshi (Paper / Charcoal / AMOLED)
// Mirror of src/app/globals.css tokens for runtime JS consumers.

export const COLORS = {
  // Primary — Forest Green
  primary: {
    DEFAULT: "#203A2B",
    hover: "#2B4937",
    dark: "#4A6547",
    darkHover: "#5A7F55",
    amoled: "#3F6B4A",
  },

  brass: {
    DEFAULT: "#8B6A3F",
    light: "#C0A175",
    dark: "#C0A175",
    amoled: "#C9AC80",
  },

  // Paper (Light) theme
  light: {
    bg: "#F6F4EE",
    bgAlt: "#F0EEE7",
    surface: "#FFFFFF",
    sidebar: "#F6F4EE",
    border: "#DED8CC",
    textMain: "#242722",
    textMuted: "#686B64",
  },

  // Charcoal (Dark) theme
  dark: {
    bg: "#131513",
    bgAlt: "#191C19",
    surface: "#191C19",
    sidebar: "#131513",
    border: "#2E332E",
    textMain: "#E8E6DF",
    textMuted: "#9A9C93",
  },

  // AMOLED True Black theme
  amoled: {
    bg: "#000000",
    bgAlt: "#050505",
    surface: "#0A0A0A",
    sidebar: "#000000",
    border: "#1F1F1F",
    textMain: "#F2F1EC",
    textMuted: "#9C9E97",
  },

  // Status colors — solid & quiet
  status: {
    success: "#2E5D3A",
    warning: "#8B6A3F",
    error: "#B8442A",
    info: "#4A6547",
  },
};

// CSS Variables mapping
export const CSS_VARIABLES = {
  light: {
    "--color-primary": COLORS.primary.DEFAULT,
    "--color-primary-hover": COLORS.primary.hover,
    "--color-bg": COLORS.light.bg,
    "--color-bg-alt": COLORS.light.bgAlt,
    "--color-surface": COLORS.light.surface,
    "--color-sidebar": COLORS.light.sidebar,
    "--color-border": COLORS.light.border,
    "--color-text-main": COLORS.light.textMain,
    "--color-text-muted": COLORS.light.textMuted,
  },
  dark: {
    "--color-primary": COLORS.primary.dark,
    "--color-primary-hover": COLORS.primary.darkHover,
    "--color-bg": COLORS.dark.bg,
    "--color-bg-alt": COLORS.dark.bgAlt,
    "--color-surface": COLORS.dark.surface,
    "--color-sidebar": COLORS.dark.sidebar,
    "--color-border": COLORS.dark.border,
    "--color-text-main": COLORS.dark.textMain,
    "--color-text-muted": COLORS.dark.textMuted,
  },
  amoled: {
    "--color-primary": COLORS.primary.amoled,
    "--color-primary-hover": COLORS.primary.darkHover,
    "--color-bg": COLORS.amoled.bg,
    "--color-bg-alt": COLORS.amoled.bgAlt,
    "--color-surface": COLORS.amoled.surface,
    "--color-sidebar": COLORS.amoled.sidebar,
    "--color-border": COLORS.amoled.border,
    "--color-text-main": COLORS.amoled.textMain,
    "--color-text-muted": COLORS.amoled.textMuted,
  },
};
