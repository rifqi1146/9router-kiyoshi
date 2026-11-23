import pkg from "../../../package.json" with { type: "json" };

// App configuration
export const APP_CONFIG = {
  name: "9Router-Kiyoshi",
  description: "AI routing gateway — private bench build (based on 9Router-Plinian)",
  version: pkg.version,
  // Attribution shown in the sidebar footer.
  basedOn: {
    label: "Based on 9Router-Plinian",
    url: "https://github.com/Azhar457/9router",
  },
};

// GitHub configuration
export const GITHUB_CONFIG = {
  changelogUrl: "https://raw.githubusercontent.com/rifqi1146/9router-kiyoshi/main/CHANGELOG.md",
  donateUrl: "https://9router.com/api/donate",
};

// Updater configuration
const GH_LATEST_URL = `https://github.com/rifqi1146/9router-kiyoshi/releases/latest/download/9router-kiyoshi-latest.tgz`;
// Per-OS install command templates.
// - bash / sh: single line with &&
// - cmd: powershell one-liner (avoids curl alias + && problems)
// - pwsh: native PowerShell one-liner (curl.exe + ; separators)
// - posix path via $TMPDIR so macOS + Linux both work
export const UPDATER_CONFIG = {
  npmPackageName: "9router-kiyoshi",
  // GitHub is the update source of truth (npm is deprecated / dual-use-blocked).
  // The updater downloads this tarball and runs `npm i -g <file>`.
  ghRepo: "rifqi1146/9router-kiyoshi",
  ghAsset: "9router-kiyoshi-latest.tgz",
  ghUrl: GH_LATEST_URL,
  // Backwards-compat default (bash). Kept as-is so existing consumers don't
  // break; Sidebar now picks the OS-specific one via `installCmdForPlatform`.
  installCmd: `curl -fsSL ${GH_LATEST_URL} -o /tmp/9router-kiyoshi.tgz && npm i -g /tmp/9router-kiyoshi.tgz`,
  installCmdLatest: `curl -fsSL ${GH_LATEST_URL} -o /tmp/9router-kiyoshi.tgz && npm i -g /tmp/9router-kiyoshi.tgz`,
  // Command templates per platform. Each returns a string the user can
  // copy+paste into the matching shell and it will work.
  installCmdByPlatform: {
    // bash / zsh / sh (macOS Terminal, Ubuntu, etc)
    bash: `curl -fsSL ${GH_LATEST_URL} -o /tmp/9router-kiyoshi.tgz && npm i -g /tmp/9router-kiyoshi.tgz`,
    // cmd.exe (Windows) — powershell one-liner, no &&, no /tmp
    cmd: `powershell -NoProfile -Command "curl.exe -fsSL ${GH_LATEST_URL} -o $env:TEMP\\9router-kiyoshi.tgz; npm i -g $env:TEMP\\9router-kiyoshi.tgz"`,
    // PowerShell (Windows) — native, no shell escaping
    pwsh: `curl.exe -fsSL ${GH_LATEST_URL} -o $env:TEMP\\9router-kiyoshi.tgz; npm i -g $env:TEMP\\9router-kiyoshi.tgz`,
  },
  // Pick the right command for the current OS. In the browser `navigator.platform`
  // / `userAgent` is available; on Node we fall back to `process.platform`.
  installCmdForPlatform(platform) {
    const p = String(platform || "").toLowerCase();
    if (p.includes("win")) return this.installCmdByPlatform.cmd;
    if (p.includes("mac") || p.includes("darwin")) return this.installCmdByPlatform.bash;
    // linux / unknown → bash
    return this.installCmdByPlatform.bash;
  },
  shutdownCountdownSec: 3,
  exitDelayMs: 500,
  statusPort: 20129,
  statusPollIntervalMs: 1000,
  statusLogTailLines: 8,
  installRetries: 3,
  installRetryDelayMs: 5000,
  lingerAfterDoneMs: 30000,
  waitForExitMinMs: 5000,
  waitForExitMaxMs: 20000,
  waitForExitCheckMs: 500,
  appPort: 20128,
};

// Theme configuration
export const THEME_CONFIG = {
  storageKey: "theme",
  defaultTheme: "amoled", // "light" | "dark" | "amoled"
};

export const THEMES = [
  { id: "light", label: "Paper", icon: "light_mode" },
  { id: "dark", label: "Charcoal", icon: "dark_mode" },
  { id: "amoled", label: "AMOLED", icon: "contrast" },
];

export const PALETTES = {};

// Subscription
export const SUBSCRIPTION_CONFIG = {
  price: 1.0,
  currency: "USD",
  interval: "month",
  planName: "Pro Plan",
};

// API endpoints
export const API_ENDPOINTS = {
  users: "/api/users",
  providers: "/api/providers",
  payments: "/api/payments",
  auth: "/api/auth",
};

export const CONSOLE_LOG_CONFIG = {
  maxLines: 200,
  pollIntervalMs: 1000,
};

// Client-side store TTL: how long fetched data stays fresh before re-fetching
export const CLIENT_STORE_TTL_MS = 60000;

// Quota auto-ping: keep 5h windows warm by sending a tiny request right after reset.
export const QUOTA_AUTOPING_CONFIG = {
  tickIntervalMs: 60000,                // scheduler tick
  pingLeadMs: 5000,                     // fire once reset passes (within tolerance)
  refreshAheadMs: 300000,               // refetch usage when within 5min of reset
  failureCooldownMs: 900000,            // avoid failed ping spam while upstream/auth is unhealthy
  providers: {
    claude: {
      settingsKey: "claudeAutoPing",    // preserve existing settings contract
      quotaKey: "session (5h)",         // quota key returned by usage handler
      pingModel: "claude-haiku-4-5-20251001",
      pingText: "hi",
      pingMaxTokens: 1,
    },
    codex: {
      settingsKey: "codexAutoPing",
      quotaKey: "session",
      pingWhenResetAtSlides: true,
      resetAtDriftMs: 30000,
      minPingIntervalMs: 600000,
      skipWhenBlockingQuotaExhausted: true,
      // gpt-5.6-terra is the lightweight model for auto-pinging Codex 5h reset window.
      pingModel: "gpt-5.6-terra",
      pingText: "hi",
      pingInstructions: "Reply with OK.",
      pingReasoningEffort: "none",
    },
  },
};

// Re-export from providers.js for backward compatibility
export {
  FREE_PROVIDERS,
  OAUTH_PROVIDERS,
  APIKEY_PROVIDERS,
  WEB_COOKIE_PROVIDERS,
  AI_PROVIDERS,
  AUTH_METHODS,
} from "./providers.js";

