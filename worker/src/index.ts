interface Env {
  APP_ENV?: string;
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'vary': 'Origin',
  };
  // Restrictive by default. Configure the deployed GitHub Pages origin below.
  // Only allow HTTPS origins for the public API, plus localhost for development.
  if (origin) {
    try {
      const parsed = new URL(origin);
      const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
      const isGithubPages = parsed.protocol === 'https:' && parsed.hostname.endsWith('.github.io');
      if (isLocal || isGithubPages) headers['access-control-allow-origin'] = origin;
    } catch {
      // Invalid Origin: omit allow-origin, causing browsers to reject cross-origin access.
    }
  }
  return headers;
}

function json(data: unknown, status = 200, origin: string | null = null): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...JSON_HEADERS, ...corsHeaders(origin) },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname === '/api/health' && request.method === 'GET') {
      return json({
        app: 'RemoteDesk API',
        status: 'ok',
        version: '0.1.0',
        environment: env.APP_ENV ?? 'unknown',
        capabilities: ['health-check'],
        remoteControlEnabled: false,
      }, 200, origin);
    }

    return json({
      error: 'not_found',
      message: 'This endpoint is not implemented in Phase 1.',
    }, 404, origin);
  },
};
