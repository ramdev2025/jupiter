/**
 * Cloudflare Worker frontdoor for the Jupiter container.
 *
 * The Worker itself holds no logic: it starts the container (if asleep) and
 * proxies the request. Everything - REST API and the dashboard - is served by
 * the FastAPI app inside, which keeps the dashboard same-origin with the API
 * and means no CORS configuration is needed.
 *
 * Secrets are injected at container start rather than baked into the image or
 * committed to wrangler config. Set them with:
 *   wrangler secret put DATABASE_URL
 *   wrangler secret put JUPITER_LLM_API_KEY
 */

import { Container } from "@cloudflare/containers";

interface Env {
  JUPITER: DurableObjectNamespace<JupiterContainer>;
  /** Postgres URL. Use Neon's *pooled* endpoint (host contains `-pooler`). */
  DATABASE_URL: string;
  /** Optional: enables semantic conflict detection. Absent = feature off. */
  JUPITER_LLM_API_KEY?: string;
  JUPITER_LLM_MODEL?: string;
  JUPITER_LLM_BASE_URL?: string;
  JUPITER_LOCK_TTL?: string;
}

export class JupiterContainer extends Container<Env> {
  defaultPort = 8080;
  requiredPorts = [8080];

  /** The dashboard polls every 3s while open, so an idle hour means nobody is
   *  watching and nothing is claimed. Waking costs one 2-3s cold start. */
  sleepAfter = "1h";

  /** Required: the app dials out to Postgres (TCP 5432) and, when semantic
   *  detection is on, to the LLM gateway over HTTPS. */
  enableInternet = true;

  /** Jupiter already exposes this, unauthenticated and cheap. */
  pingEndpoint = "/healthz";

  onError(error: unknown) {
    console.error("jupiter container error", error);
  }
}

/** Only non-secret env goes here; secrets are added per-start below. */
function baseEnv(env: Env): Record<string, string> {
  const vars: Record<string, string> = {
    DATABASE_URL: env.DATABASE_URL,
    JUPITER_LOCK_TTL: env.JUPITER_LOCK_TTL ?? "300",
  };
  if (env.JUPITER_LLM_MODEL) vars.JUPITER_LLM_MODEL = env.JUPITER_LLM_MODEL;
  if (env.JUPITER_LLM_BASE_URL) vars.JUPITER_LLM_BASE_URL = env.JUPITER_LLM_BASE_URL;
  if (env.JUPITER_LLM_API_KEY) vars.JUPITER_LLM_API_KEY = env.JUPITER_LLM_API_KEY;
  return vars;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.DATABASE_URL) {
      return new Response(
        "DATABASE_URL is not set. Run: wrangler secret put DATABASE_URL\n",
        { status: 500, headers: { "content-type": "text/plain" } },
      );
    }

    // A single named instance, deliberately. Jupiter is one team's shared
    // source of truth; spreading requests across instances would split its
    // in-process semantic cache for no benefit, since all state that matters
    // lives in Postgres anyway.
    const container = env.JUPITER.getByName("singleton");

    // startAndWaitForPorts, not start: start() returns when the process
    // launches, not when uvicorn is accepting connections.
    await container.startAndWaitForPorts({
      startOptions: { envVars: baseEnv(env) },
    });

    // fetch, not containerFetch: containerFetch cannot carry a WebSocket
    // upgrade, and keeping fetch() here leaves that door open.
    return container.fetch(request);
  },
} satisfies ExportedHandler<Env>;
