// ============================================================
// Auth Proxy Routes (China mode only)
// Proxies /api/auth/* requests to the internal Auth Service ALB.
// In global mode (Cognito), these routes are not needed — the
// frontend talks directly to Cognito via Amplify SDK.
// ============================================================

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import http from 'node:http';

// ------------------------------------------------------------
// Configuration
// ------------------------------------------------------------

/**
 * Derive Auth Service base URL from JWKS_URI.
 * JWKS_URI is set to: http://<auth-alb-dns>/auth/.well-known/jwks.json
 * We extract the scheme + host to get: http://<auth-alb-dns>
 */
function getAuthServiceBaseUrl(): string | null {
  const jwksUri = process.env.JWKS_URI;
  if (!jwksUri) return null;
  try {
    const url = new URL(jwksUri);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------
// Proxy Helper
// ------------------------------------------------------------

interface ProxyResult {
  statusCode: number;
  body: string;
  headers: Record<string, string>;
}

function proxyRequest(
  method: string,
  targetUrl: string,
  body?: string,
  headers?: Record<string, string>,
): Promise<ProxyResult> {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const opts: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(body ? { 'Content-Length': Buffer.byteLength(body).toString() } : {}),
        ...headers,
      },
      timeout: 10000,
    };

    const req = http.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode ?? 500,
          body: Buffer.concat(chunks).toString(),
          headers: (res.headers as Record<string, string>) ?? {},
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Auth service request timed out'));
    });

    if (body) req.write(body);
    req.end();
  });
}

// ------------------------------------------------------------
// Route Plugin
// ------------------------------------------------------------

export default async function authProxyRoutes(app: FastifyInstance): Promise<void> {
  const deploymentMode = process.env.DEPLOYMENT_MODE ?? 'global';

  // Only register auth proxy routes in China mode
  if (deploymentMode !== 'china') {
    return;
  }

  const authBaseUrl = getAuthServiceBaseUrl();
  if (!authBaseUrl) {
    app.log.warn('JWKS_URI not set — auth proxy routes will return 503');
  }

  // --------------------------------------------------------
  // POST /api/auth/login
  // --------------------------------------------------------
  app.post('/api/auth/login', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!authBaseUrl) {
      return reply.status(503).send({ error: 'Auth service not configured' });
    }
    const result = await proxyRequest('POST', `${authBaseUrl}/auth/login`, JSON.stringify(request.body));
    reply.status(result.statusCode).send(JSON.parse(result.body));
  });

  // --------------------------------------------------------
  // POST /api/auth/refresh
  // --------------------------------------------------------
  app.post('/api/auth/refresh', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!authBaseUrl) {
      return reply.status(503).send({ error: 'Auth service not configured' });
    }
    const result = await proxyRequest('POST', `${authBaseUrl}/auth/refresh`, JSON.stringify(request.body));
    reply.status(result.statusCode).send(JSON.parse(result.body));
  });

  // --------------------------------------------------------
  // POST /api/auth/change-password
  // --------------------------------------------------------
  app.post('/api/auth/change-password', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!authBaseUrl) {
      return reply.status(503).send({ error: 'Auth service not configured' });
    }
    const authHeader = request.headers.authorization;
    const headers: Record<string, string> = {};
    if (authHeader) headers['Authorization'] = authHeader;

    const result = await proxyRequest(
      'POST',
      `${authBaseUrl}/auth/change-password`,
      JSON.stringify(request.body),
      headers,
    );
    reply.status(result.statusCode).send(JSON.parse(result.body));
  });
}
