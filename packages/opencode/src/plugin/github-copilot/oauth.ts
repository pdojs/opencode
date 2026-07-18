// Shared GitHub OAuth constants and URL builders used by the Copilot auth
// plugin and the `opencode auth github` CLI command.

export const CLIENT_ID = "Ov23li8tweQw6odWQebz"

export function normalizeDomain(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "")
}

/** Returns the base URL for the GitHub Copilot REST API. */
export function apiBase(enterpriseUrl?: string): string {
  return enterpriseUrl
    ? `https://copilot-api.${normalizeDomain(enterpriseUrl)}`
    : "https://api.githubcopilot.com"
}

/** Returns the GitHub OAuth device-flow URLs for a given auth domain. */
export function oauthUrls(domain: string) {
  return {
    deviceCode: `https://${domain}/login/device/code`,
    accessToken: `https://${domain}/login/oauth/access_token`,
  }
}

export * as CopilotOAuth from "./oauth"
