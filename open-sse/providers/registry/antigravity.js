import { ANTIGRAVITY_IDE_BASE_URL, ANTIGRAVITY_IDE_USER_AGENT, ANTIGRAVITY_OAUTH_CLIENT } from "../shared.js";

export default {
  id: "antigravity",
  priority: 20,
  alias: "ag",
  uiAlias: "ag",
  display: {
    name: "Antigravity",
    icon: "rocket_launch",
    color: "#F59E0B",
    website: "https://antigravity.google",
    notice: {
      signupUrl: "https://antigravity.google",
    },
    deprecated: true,
    deprecationNotice: "RISK_NOTICE",
  },
  category: "oauth",
  serviceKinds: ["llm", "image", "webSearch"],
  transport: {
    baseUrls: [ANTIGRAVITY_IDE_BASE_URL],
    format: "antigravity",
    headers: {
      "User-Agent": ANTIGRAVITY_IDE_USER_AGENT,
    },
    retry: {
      // One retry only. Every 429 retry is another rejected request against the
      // same account; with a single active account the old 3-attempt ladder
      // (2s/4s/8s) turned one capacity blip into a minute of hammering.
      "429": {
        attempts: 1,
      },
      "500": {
        attempts: 3,
      },
      "503": {
        attempts: 3,
      },
    },
    usage: {
      quotaApiUrl: `${ANTIGRAVITY_IDE_BASE_URL}/v1internal:fetchAvailableModels`,
      quotaSummaryApiUrl: `${ANTIGRAVITY_IDE_BASE_URL}/v1internal:retrieveUserQuotaSummary`,
      loadProjectApiUrl: "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
      tokenUrl: "https://oauth2.googleapis.com/token",
    },
    clientId: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
    clientSecret: "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",
  },
  models: [
    // Verified against a live `v1internal:fetchAvailableModels` on 2026-11-17.
    // Anything not in that response answers 404 NOT_FOUND ("Requested entity
    // was not found"), so it must not be advertised by /v1/models.
    { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)", upstreamModelId: "gemini-3.8-flash-high" },
    { id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)", upstreamModelId: "gemini-3.8-flash-medium" },
    { id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)", upstreamModelId: "gemini-3.8-flash-low" },
    { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", upstreamModelId: "gemini-3.8-flash-medium" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)" },
    { id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)" },
    { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
    // Image generation models
    { id: "gemini-3.1-flash-image", name: "Gemini 3.1 Flash (Image)", kind: "image", imageGen: true, capabilities: ["textToImage"] },
  ],

  oauth: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userInfoUrl: "https://www.googleapis.com/oauth2/v1/userinfo",
    scopes: [
      "https://www.googleapis.com/auth/cloud-platform",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/cclog",
      "https://www.googleapis.com/auth/experimentsandconfigs",
    ],
    apiEndpoint: "https://daily-cloudcode-pa.googleapis.com",
    apiVersion: "v1internal",
    loadCodeAssistEndpoint: "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
    onboardUserEndpoint: "https://cloudcode-pa.googleapis.com/v1internal:onboardUser",
    loadCodeAssistUserAgent: ANTIGRAVITY_IDE_USER_AGENT,
    refreshLeadMs: 300000,
  },
  searchViaChat: {
    defaultModel: "gemini-2.5-flash",
    endpoint: `${ANTIGRAVITY_IDE_BASE_URL}/v1internal:generateContent`,
    freeTier: "Free — Google Search grounding through an Antigravity OAuth account.",
  },
  features: {
    usage: true,
  },
};
