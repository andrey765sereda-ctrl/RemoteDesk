interface Env {
  APP_ENV?: string;
  PAGES_ORIGIN?: string;
  TURN_KEY_ID?: string;
  TURN_API_TOKEN?: string;
  PAIRING_DIRECTORY: DurableObjectNamespace;
}

type PairingStatus = "waiting" | "pending" | "approved" | "rejected" | "expired";

interface PairingSession {
  sessionId: string;
  hostSecretHash: string;
  pairCodeHash: string;
  createdAt: number;
  expiresAt: number;
  status: PairingStatus;
  clientTokenHash?: string;
  hostOffer?: string;
  clientAnswer?: string;
}

interface RateBucket {
  count: number;
  resetAt: number;
}

function isRtcDescription(value: unknown, expectedType: "offer" | "answer"): value is string {
  if (typeof value !== "string" || value.length > 100_000) return false;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return false;
    const description = parsed as Record<string, unknown>;
    return description.type === expectedType && typeof description.sdp === "string" && description.sdp.length > 0 && description.sdp.length <= 90_000;
  } catch {
    return false;
  }
}

const JSON_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store, max-age=0",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "pragma": "no-cache",
};

function isAllowedOrigin(origin: string, env: Env): boolean {
  try {
    const parsed = new URL(origin);
    const local = (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") && parsed.protocol === "http:";
    if (local) return true;
    if (parsed.protocol !== "https:") return false;
    if (env.PAGES_ORIGIN) return origin === env.PAGES_ORIGIN;
    // Transitional default. Once GitHub Pages URL is known, set PAGES_ORIGIN
    // in wrangler.toml to the exact origin (e.g. https://username.github.io).
    return parsed.hostname.endsWith(".github.io");
  } catch {
    return false;
  }
}

function corsHeaders(origin: string | null, env: Env): Record<string, string> {
  const headers: Record<string, string> = {
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "600",
    "vary": "Origin",
  };
  if (origin && isAllowedOrigin(origin, env)) headers["access-control-allow-origin"] = origin;
  return headers;
}

function json(data: unknown, status = 200, origin: string | null = null, env?: Env): Response {
  const cors = env ? corsHeaders(origin, env) : {};
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...cors },
  });
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) return null;
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  // SDP descriptions are larger than ordinary pairing requests; keep a strict cap.
  const maxBytes = 128 * 1024;
  if (declaredLength > maxBytes) return null;
  const text = await request.text();
  if (text.length > maxBytes) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    if (origin && !isAllowedOrigin(origin, env)) {
      return json({ error: "origin_not_allowed" }, 403);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      return json({
        app: "RemoteDesk API",
        status: "ok",
        version: "0.3.1",
        environment: env.APP_ENV ?? "unknown",
        capabilities: ["health-check", "temporary-pairing", "host-approval", "webrtc-screen-preview"],
        remoteControlEnabled: false,
      }, 200, origin, env);
    }

    const supported = new Set([
      "/api/pairing/start",
      "/api/pairing/claim",
      "/api/pairing/host-status",
      "/api/pairing/decision",
      "/api/pairing/client-status",
      "/api/rtc/host-offer",
      "/api/rtc/host-answer",
      "/api/rtc/client-offer",
      "/api/rtc/client-answer",
      "/api/rtc/ice-servers",
    ]);

    if (!supported.has(url.pathname) || request.method !== "POST") {
      return json({ error: "not_found", message: "Endpoint not found." }, 404, origin, env);
    }

    const body = await readJson(request);
    if (!body) return json({ error: "invalid_json", message: "Expected a JSON object smaller than 128 KB." }, 400, origin, env);

    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const headers = new Headers({
      "content-type": "application/json",
      "x-rd-client-ip": ip,
    });
    const internalRequest = new Request(`https://pairing.internal${url.pathname}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    try {
      const id = env.PAIRING_DIRECTORY.idFromName("remotedesk-global-pairing-directory");
      const directory = env.PAIRING_DIRECTORY.get(id);
      const result = await directory.fetch(internalRequest);
      const text = await result.text();
      return new Response(text, {
        status: result.status,
        headers: { ...JSON_HEADERS, ...corsHeaders(origin, env) },
      });
    } catch {
      return json({ error: "pairing_service_unavailable" }, 503, origin, env);
    }
  },
};

/**
 * Durable, strongly coordinated store for short-lived pairing requests.
 * It never grants desktop control; it only lets the user approve a temporary
 * pairing request initiated by their own Windows Host process.
 */
export class PairingDirectory {
  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return this.reply({ error: "method_not_allowed" }, 405);
    const body = await readJson(request);
    if (!body) return this.reply({ error: "invalid_json" }, 400);

    const path = new URL(request.url).pathname;
    if (path === "/api/pairing/start") return this.start(body, request);
    if (path === "/api/pairing/claim") return this.claim(body, request);
    if (path === "/api/pairing/host-status") return this.hostStatus(body);
    if (path === "/api/pairing/decision") return this.decision(body);
    if (path === "/api/pairing/client-status") return this.clientStatus(body);
    if (path === "/api/rtc/host-offer") return this.hostOffer(body);
    if (path === "/api/rtc/host-answer") return this.hostAnswer(body);
    if (path === "/api/rtc/client-offer") return this.clientOffer(body);
    if (path === "/api/rtc/client-answer") return this.clientAnswer(body);
    if (path === "/api/rtc/ice-servers") return this.iceServers(body);
    return this.reply({ error: "not_found" }, 404);
  }

  private reply(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
  }

  private async rateLimit(key: string, limit: number, windowMs: number): Promise<boolean> {
    const now = Date.now();
    const bucket = await this.state.storage.get<RateBucket>(key);
    if (!bucket || bucket.resetAt <= now) {
      await this.state.storage.put<RateBucket>(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (bucket.count >= limit) return false;
    await this.state.storage.put<RateBucket>(key, { count: bucket.count + 1, resetAt: bucket.resetAt });
    return true;
  }

  private async hashed(value: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  private secureEquals(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let result = 0;
    for (let i = 0; i < a.length; i += 1) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return result === 0;
  }

  private async randomHex(bytes = 32): Promise<string> {
    const data = crypto.getRandomValues(new Uint8Array(bytes));
    return Array.from(data, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  private async loadSession(sessionId: string): Promise<PairingSession | undefined> {
    return this.state.storage.get<PairingSession>(`session:${sessionId}`);
  }

  private async saveSession(session: PairingSession): Promise<void> {
    await this.state.storage.put<PairingSession>(`session:${session.sessionId}`, session);
  }

  private isExpired(session: PairingSession): boolean {
    return Date.now() >= session.expiresAt;
  }

  private async start(body: Record<string, unknown>, request: Request): Promise<Response> {
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    const hostSecret = typeof body.hostSecret === "string" ? body.hostSecret : "";
    const pairCode = typeof body.pairCode === "string" ? body.pairCode.toUpperCase() : "";
    if (!/^[a-f0-9]{32}$/i.test(sessionId) || !/^[a-f0-9]{64}$/i.test(hostSecret) || !/^[A-F0-9]{12}$/.test(pairCode)) {
      return this.reply({ error: "invalid_pairing_request" }, 400);
    }

    const ipHash = await this.hashed(request.headers.get("x-rd-client-ip") ?? "unknown");
    if (!(await this.rateLimit(`rl:start:${ipHash}`, 10, 60_000))) return this.reply({ error: "rate_limited" }, 429);

    const pairCodeHash = await this.hashed(pairCode);
    const existingId = await this.state.storage.get<string>(`code:${pairCodeHash}`);
    if (existingId) {
      const existingSession = await this.loadSession(existingId);
      if (existingSession && !this.isExpired(existingSession) && existingSession.status !== "expired") {
        return this.reply({ error: "pair_code_collision" }, 409);
      }
      await this.state.storage.delete(`code:${pairCodeHash}`);
    }
    if (await this.loadSession(sessionId)) return this.reply({ error: "session_exists" }, 409);

    const now = Date.now();
    const session: PairingSession = {
      sessionId,
      hostSecretHash: await this.hashed(hostSecret),
      pairCodeHash,
      createdAt: now,
      expiresAt: now + 5 * 60_000,
      status: "waiting",
    };
    await this.saveSession(session);
    await this.state.storage.put(`code:${pairCodeHash}`, sessionId);
    return this.reply({ ok: true, expiresAt: session.expiresAt });
  }

  private async claim(body: Record<string, unknown>, request: Request): Promise<Response> {
    const pairCode = typeof body.pairCode === "string" ? body.pairCode.toUpperCase().replace(/-/g, "") : "";
    if (!/^[A-F0-9]{12}$/.test(pairCode)) return this.reply({ error: "invalid_or_expired_code" }, 400);

    const ipHash = await this.hashed(request.headers.get("x-rd-client-ip") ?? "unknown");
    const allowed = await this.state.blockConcurrencyWhile(async () => this.rateLimit(`rl:claim:${ipHash}`, 8, 60_000));
    if (!allowed) return this.reply({ error: "rate_limited", message: "Too many attempts. Wait one minute and try again." }, 429);

    const pairCodeHash = await this.hashed(pairCode);
    return this.state.blockConcurrencyWhile(async () => {
      const sessionId = await this.state.storage.get<string>(`code:${pairCodeHash}`);
      if (!sessionId) return this.reply({ error: "invalid_or_expired_code" }, 400);
      const session = await this.loadSession(sessionId);
      if (!session || this.isExpired(session) || session.status !== "waiting") {
        if (session && this.isExpired(session)) {
          session.status = "expired";
          await this.saveSession(session);
        }
        await this.state.storage.delete(`code:${pairCodeHash}`);
        return this.reply({ error: "invalid_or_expired_code" }, 400);
      }
      const clientToken = await this.randomHex(32);
      session.clientTokenHash = await this.hashed(clientToken);
      session.status = "pending";
      await this.saveSession(session);
      await this.state.storage.delete(`code:${pairCodeHash}`);
      return this.reply({ ok: true, sessionId, clientToken, expiresAt: session.expiresAt });
    });
  }

  private async hostStatus(body: Record<string, unknown>): Promise<Response> {
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    const hostSecret = typeof body.hostSecret === "string" ? body.hostSecret : "";
    if (!/^[a-f0-9]{32}$/i.test(sessionId) || !/^[a-f0-9]{64}$/i.test(hostSecret)) return this.reply({ error: "unauthorized" }, 401);
    const session = await this.loadSession(sessionId);
    if (!session || !this.secureEquals(await this.hashed(hostSecret), session.hostSecretHash)) return this.reply({ error: "unauthorized" }, 401);
    if (this.isExpired(session) && session.status !== "expired") {
      session.status = "expired";
      session.hostOffer = undefined;
      session.clientAnswer = undefined;
      await this.saveSession(session);
    }
    return this.reply({ ok: true, status: session.status, expiresAt: session.expiresAt });
  }

  private async decision(body: Record<string, unknown>): Promise<Response> {
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    const hostSecret = typeof body.hostSecret === "string" ? body.hostSecret : "";
    const approve = body.approve;
    if (!/^[a-f0-9]{32}$/i.test(sessionId) || !/^[a-f0-9]{64}$/i.test(hostSecret) || typeof approve !== "boolean") {
      return this.reply({ error: "invalid_request" }, 400);
    }
    return this.state.blockConcurrencyWhile(async () => {
      const session = await this.loadSession(sessionId);
      if (!session || !this.secureEquals(await this.hashed(hostSecret), session.hostSecretHash)) return this.reply({ error: "unauthorized" }, 401);
      if (this.isExpired(session)) {
        session.status = "expired";
        await this.saveSession(session);
        return this.reply({ error: "pairing_expired", status: session.status }, 410);
      }
      if (session.status !== "pending") return this.reply({ error: "no_pending_request", status: session.status }, 409);
      session.status = approve ? "approved" : "rejected";
      if (approve) session.expiresAt = Date.now() + 30 * 60_000;
      await this.saveSession(session);
      return this.reply({ ok: true, status: session.status });
    });
  }

  private async clientStatus(body: Record<string, unknown>): Promise<Response> {
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    const clientToken = typeof body.clientToken === "string" ? body.clientToken : "";
    if (!/^[a-f0-9]{32}$/i.test(sessionId) || !/^[a-f0-9]{64}$/i.test(clientToken)) return this.reply({ error: "unauthorized" }, 401);
    const session = await this.loadSession(sessionId);
    if (!session || !session.clientTokenHash || !this.secureEquals(await this.hashed(clientToken), session.clientTokenHash)) {
      return this.reply({ error: "unauthorized" }, 401);
    }
    if (this.isExpired(session) && session.status !== "expired") {
      session.status = "expired";
      session.hostOffer = undefined;
      session.clientAnswer = undefined;
      await this.saveSession(session);
    }
    return this.reply({ ok: true, status: session.status, expiresAt: session.expiresAt });
  }

  private async authorizedHost(body: Record<string, unknown>): Promise<PairingSession | null> {
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    const hostSecret = typeof body.hostSecret === "string" ? body.hostSecret : "";
    if (!/^[a-f0-9]{32}$/i.test(sessionId) || !/^[a-f0-9]{64}$/i.test(hostSecret)) return null;
    const session = await this.loadSession(sessionId);
    if (!session || !this.secureEquals(await this.hashed(hostSecret), session.hostSecretHash)) return null;
    if (this.isExpired(session)) {
      session.status = "expired";
      session.hostOffer = undefined;
      session.clientAnswer = undefined;
      await this.saveSession(session);
      return null;
    }
    if (session.status !== "approved") return null;
    return session;
  }

  private async authorizedClient(body: Record<string, unknown>): Promise<PairingSession | null> {
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    const clientToken = typeof body.clientToken === "string" ? body.clientToken : "";
    if (!/^[a-f0-9]{32}$/i.test(sessionId) || !/^[a-f0-9]{64}$/i.test(clientToken)) return null;
    const session = await this.loadSession(sessionId);
    if (!session || !session.clientTokenHash || !this.secureEquals(await this.hashed(clientToken), session.clientTokenHash)) return null;
    if (this.isExpired(session)) {
      session.status = "expired";
      session.hostOffer = undefined;
      session.clientAnswer = undefined;
      await this.saveSession(session);
      return null;
    }
    if (session.status !== "approved") return null;
    return session;
  }

  private async hostOffer(body: Record<string, unknown>): Promise<Response> {
    const session = await this.authorizedHost(body);
    if (!session) return this.reply({ error: "unauthorized_or_session_not_approved" }, 401);
    const description = body.description;
    if (!isRtcDescription(description, "offer")) return this.reply({ error: "invalid_webrtc_offer" }, 400);
    session.hostOffer = description;
    session.clientAnswer = undefined;
    await this.saveSession(session);
    return this.reply({ ok: true, status: "offer_ready" });
  }

  private async hostAnswer(body: Record<string, unknown>): Promise<Response> {
    const session = await this.authorizedHost(body);
    if (!session) return this.reply({ error: "unauthorized_or_session_not_approved" }, 401);
    return this.reply({ ok: true, status: session.clientAnswer ? "ready" : "waiting", description: session.clientAnswer ?? null });
  }

  private async clientOffer(body: Record<string, unknown>): Promise<Response> {
    const session = await this.authorizedClient(body);
    if (!session) return this.reply({ error: "unauthorized_or_session_not_approved" }, 401);
    return this.reply({ ok: true, status: session.hostOffer ? "ready" : "waiting", description: session.hostOffer ?? null });
  }

  private async clientAnswer(body: Record<string, unknown>): Promise<Response> {
    const session = await this.authorizedClient(body);
    if (!session) return this.reply({ error: "unauthorized_or_session_not_approved" }, 401);
    const description = body.description;
    if (!isRtcDescription(description, "answer")) return this.reply({ error: "invalid_webrtc_answer" }, 400);
    session.clientAnswer = description;
    await this.saveSession(session);
    return this.reply({ ok: true, status: "answer_ready" });
  }

  /** Return short-lived Cloudflare TURN credentials only to an approved paired endpoint. */
  private async iceServers(body: Record<string, unknown>): Promise<Response> {
    const session = await this.authorizedHost(body) ?? await this.authorizedClient(body);
    if (!session) return this.reply({ error: "unauthorized_or_session_not_approved" }, 401);
    if (!(await this.rateLimit(`rl:ice:${session.sessionId}`, 12, 60_000))) {
      return this.reply({ error: "rate_limited" }, 429);
    }

    const keyId = this.env.TURN_KEY_ID?.trim();
    const apiToken = this.env.TURN_API_TOKEN?.trim();
    if (!keyId || !apiToken) {
      return this.reply({
        error: "turn_not_configured",
        message: "Cloudflare TURN credentials are not configured. Direct STUN-only fallback may fail on restrictive networks."
      }, 503);
    }

    let response: Response;
    try {
      response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
        method: "POST",
        headers: {
          "authorization": `Bearer ${apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ ttl: 3600 }),
      });
    } catch {
      return this.reply({ error: "turn_service_unreachable" }, 502);
    }
    if (!response.ok) {
      // Do not expose account credentials or raw upstream diagnostics to the client.
      return this.reply({ error: "turn_credentials_failed", upstreamStatus: response.status }, 502);
    }

    let data: unknown;
    try { data = await response.json(); } catch { return this.reply({ error: "invalid_turn_response" }, 502); }
    if (!data || typeof data !== "object" || !Array.isArray((data as Record<string, unknown>).iceServers)) {
      return this.reply({ error: "invalid_turn_response" }, 502);
    }
    const iceServers = (data as { iceServers: unknown[] }).iceServers.filter((item) => {
      if (!item || typeof item !== "object") return false;
      const urls = (item as Record<string, unknown>).urls;
      return typeof urls === "string" || (Array.isArray(urls) && urls.every((url) => typeof url === "string"));
    });
    if (iceServers.length === 0) return this.reply({ error: "empty_turn_response" }, 502);
    return this.reply({ iceServers, ttl: 3600 });
  }
}
