import { ANTIGRAVITY_CONFIG } from "../constants/oauth.js";
import { antigravityFetch } from "open-sse/utils/antigravityWire.js";

/**
 * The native Antigravity Go client (`agy`) signs in with
 * `redirect_uri=https://antigravity.google/oauth-callback`, PKCE S256, and ends
 * on a Google-hosted page that displays the authorization code for the user to
 * paste back into the terminal. Mirroring that exactly keeps the signed-in
 * identity indistinguishable from the real CLI on Google's side and removes the
 * local callback server from the flow.
 */
export const ANTIGRAVITY_REDIRECT_URI = "https://antigravity.google/oauth-callback";

const antigravity = {
  config: ANTIGRAVITY_CONFIG,
  flowType: "authorization_code",
  // agy derives a 43-character base64url verifier (32 random bytes) — the same
  // shape every PKCE S256 client sends.
  pkceVerifierBytes: 32,
  fixedRedirectUri: ANTIGRAVITY_REDIRECT_URI,
  buildAuthUrl: (config, redirectUri, state, codeChallenge) => {
    const params = new URLSearchParams({
      client_id: config.clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: config.scopes.join(" "),
      state: state,
      access_type: "offline",
      prompt: "consent",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    return `${config.authorizeUrl}?${params.toString()}`;
  },
  exchangeToken: async (config, code, redirectUri, codeVerifier) => {
    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code: code,
        redirect_uri: redirectUri,
        ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token exchange failed: ${error}`);
    }

    return await response.json();
  },
  postExchange: async (tokens) => {
    const loadHeaders = {
      "Authorization": `Bearer ${tokens.access_token}`,
      "Content-Type": "application/json",
    };
    // Captured from agy 1.5.14: loadCodeAssist carries one metadata field only.
    const metadata = { ideType: "ANTIGRAVITY" };

    // Fetch user info
    // agy calls userinfo with Go's default UA, not the Antigravity UA.
    const userInfoRes = await fetch(`${ANTIGRAVITY_CONFIG.userInfoUrl}?alt=json`, {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        "User-Agent": "Go-http-client/1.1",
      },
    });
    const userInfo = userInfoRes.ok ? await userInfoRes.json() : {};

    // Load Code Assist to get project ID and tier
    let projectId = "";
    let tierId = "legacy-tier";
    try {
      const loadRes = await antigravityFetch(ANTIGRAVITY_CONFIG.loadCodeAssistEndpoint, {
        method: "POST",
        headers: loadHeaders,
        body: JSON.stringify({ metadata }),
      });
      if (loadRes.ok) {
        const data = await loadRes.json();
        projectId = data.cloudaicompanionProject?.id || data.cloudaicompanionProject || "";
        if (Array.isArray(data.allowedTiers)) {
          for (const tier of data.allowedTiers) {
            if (tier.isDefault && tier.id) {
              tierId = tier.id.trim();
              break;
            }
          }
        }
      }
    } catch (e) {
      console.log("Failed to load code assist:", e);
    }

    // Fire-and-forget onboarding — does not block DB save
    if (projectId) {
      const doOnboard = async () => {
        for (let i = 0; i < 10; i++) {
          try {
            const onboardRes = await antigravityFetch(ANTIGRAVITY_CONFIG.onboardUserEndpoint, {
              method: "POST",
              headers: loadHeaders,
              body: JSON.stringify({ tierId, metadata }),
            });
            if (onboardRes.ok) {
              const result = await onboardRes.json();
              if (result.done === true) break;
            }
          } catch (e) {
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      };
      doOnboard().catch(() => {});
    }

    return { userInfo, projectId };
  },
  mapTokens: (tokens, extra) => ({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresIn: tokens.expires_in,
    scope: tokens.scope,
    email: extra?.userInfo?.email,
    projectId: extra?.projectId,
  }),
};

export default antigravity;
