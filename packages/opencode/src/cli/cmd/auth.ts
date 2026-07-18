import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { Auth } from "@/auth"
import { Duration, Effect, Option } from "effect"
import { UI } from "../ui"
import * as Prompt from "../effect/prompt"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { errorMessage } from "@/util/error"
import { CLIENT_ID, normalizeDomain, oauthUrls } from "@/plugin/github-copilot/oauth"
import open from "open"

const POLLING_SAFETY_MARGIN = Duration.millis(3000)

const openBrowser = (url: string) => Effect.promise(() => open(url).catch(() => undefined))

const cliTry = <V>(label: string, fn: () => PromiseLike<V>) =>
  Effect.tryPromise({
    try: fn,
    catch: (e) => new CliError({ message: label + errorMessage(e) }),
  })

const promptValue = <V>(value: Option.Option<V>) => {
  if (Option.isNone(value)) return Effect.die(new UI.CancelledError())
  return Effect.succeed(value.value)
}

// Polls GitHub's OAuth token endpoint until the user completes authorization.
// Uses the same device-flow polling semantics as the Copilot plugin.
const pollForToken = (
  accessTokenUrl: string,
  deviceCode: string,
  interval: Duration.Duration,
  userAgent: string,
): Effect.Effect<string, CliError> =>
  Effect.gen(function* () {
    yield* Effect.sleep(Duration.sum(interval, POLLING_SAFETY_MARGIN))
    const data = yield* cliTry("Failed to poll GitHub: ", () =>
      fetch(accessTokenUrl, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": userAgent,
        },
        body: JSON.stringify({
          client_id: CLIENT_ID,
          device_code: deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      }).then((r) => r.json() as Promise<Record<string, unknown>>),
    )
    if (typeof data.access_token === "string") return data.access_token
    if (data.error === "slow_down") {
      const next =
        typeof data.interval === "number"
          ? Duration.seconds(data.interval)
          : Duration.sum(interval, Duration.seconds(5))
      return yield* pollForToken(accessTokenUrl, deviceCode, next, userAgent)
    }
    if (data.error === "authorization_pending")
      return yield* pollForToken(accessTokenUrl, deviceCode, interval, userAgent)
    return yield* fail(typeof data.error === "string" ? data.error : "authorization failed")
  })

export const AuthGithubCommand = effectCmd({
  command: "github",
  aliases: ["gh"],
  describe: "log in with GitHub Copilot",
  instance: false,
  builder: (yargs: Argv) =>
    yargs.option("enterprise", {
      alias: "e",
      type: "string",
      describe: "GitHub Enterprise URL or domain (e.g. company.ghe.com)",
    }),
  handler: Effect.fn("Cli.auth.github")(function* (args: { enterprise?: string }) {
    const authSvc = yield* Auth.Service

    UI.empty()
    yield* Prompt.intro("Log in with GitHub Copilot")

    let domain = "github.com"

    if (args.enterprise) {
      domain = normalizeDomain(args.enterprise)
    } else {
      const deploymentType = yield* promptValue(
        yield* Prompt.select({
          message: "Select GitHub deployment type",
          options: [
            { label: "GitHub.com", value: "github.com", hint: "Public" },
            { label: "GitHub Enterprise", value: "enterprise", hint: "Data residency or self-hosted" },
          ],
        }),
      )

      if (deploymentType === "enterprise") {
        const enterpriseInput = yield* promptValue(
          yield* Prompt.text({
            message: "Enter your GitHub Enterprise URL or domain",
            placeholder: "company.ghe.com or https://company.ghe.com",
            validate: (v) => {
              if (!v) return "URL or domain is required"
              try {
                const u = v.includes("://") ? new URL(v) : new URL(`https://${v}`)
                if (!u.hostname) return "Please enter a valid URL or domain"
              } catch {
                return "Please enter a valid URL (e.g., company.ghe.com)"
              }
            },
          }),
        )
        domain = normalizeDomain(enterpriseInput)
      }
    }

    const userAgent = `opencode/${InstallationVersion}`
    const urls = oauthUrls(domain)

    const deviceData = yield* cliTry("Failed to contact GitHub: ", () =>
      fetch(urls.deviceCode, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": userAgent,
        },
        body: JSON.stringify({ client_id: CLIENT_ID, scope: "read:user" }),
      }).then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json() as Promise<{
          verification_uri: string
          user_code: string
          device_code: string
          interval: number
        }>
      }),
    )

    yield* Prompt.log.info(`Go to: ${deviceData.verification_uri}`)
    yield* Prompt.log.info(`Enter code: ${deviceData.user_code}`)
    yield* openBrowser(deviceData.verification_uri)

    const spinner = Prompt.spinner()
    yield* spinner.start("Waiting for authorization...")

    const token = yield* pollForToken(
      urls.accessToken,
      deviceData.device_code,
      Duration.seconds(deviceData.interval),
      userAgent,
    ).pipe(Effect.tapError(() => spinner.stop("Authorization failed", 1)))

    yield* Effect.orDie(
      authSvc.set("github-copilot", {
        type: "oauth",
        access: token,
        refresh: token,
        expires: 0,
        ...(domain !== "github.com" ? { enterpriseUrl: domain } : {}),
      }),
    )

    yield* spinner.stop("Logged in with GitHub Copilot")
    yield* Prompt.outro("Run `opencode` to start using Copilot models")
  }),
})

export const AuthCommand = cmd({
  command: "auth",
  describe: "manage authentication",
  builder: (yargs) => yargs.command(AuthGithubCommand).demandCommand(),
  async handler() {},
})
