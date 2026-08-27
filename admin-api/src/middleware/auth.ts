// ============================================================
// Dual-Mode JWT Authentication Middleware
// Validates: Requirements 7.8, 7.9, 8.1, 8.2, 8.3, 8.4
// ============================================================

import type { FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from 'jose';
import { AppError, ErrorCode, type JwtPayload } from '../lib/types.js';

// ------------------------------------------------------------
// Configuration
// ------------------------------------------------------------

/** Deployment mode from environment variable (read dynamically to support testing) */
function getDeploymentMode(): string {
  return process.env.DEPLOYMENT_MODE ?? 'global';
}

/** Required admin group name */
const ADMIN_GROUP = 'openclaw-admins';

// ------------------------------------------------------------
// Verifier Interfaces & Implementations
// ------------------------------------------------------------

interface JwtVerifier {
  verify(token: string): Promise<JwtPayload>;
}

// -- Global mode: Cognito JWT Verifier -----------------------

function createCognitoVerifier(): JwtVerifier {
  const userPoolId = process.env.COGNITO_USER_POOL_ID;
  const clientId = process.env.COGNITO_CLIENT_ID;

  if (!userPoolId || !clientId) {
    throw new Error(
      'COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID must be set in global mode',
    );
  }

  const verifier = CognitoJwtVerifier.create({
    userPoolId,
    clientId,
    tokenUse: 'id',
  });

  return {
    async verify(token: string): Promise<JwtPayload> {
      try {
        const payload = await verifier.verify(token);
        return {
          sub: payload.sub as string,
          email: (payload.email as string) ?? '',
          groups: (payload['cognito:groups'] as string[]) ?? [],
        };
      } catch (err: unknown) {
        if (isTokenExpiredError(err)) {
          throw new AppError(401, ErrorCode.TOKEN_EXPIRED, 'Token has expired');
        }
        throw new AppError(401, ErrorCode.INVALID_TOKEN, 'Invalid token');
      }
    },
  };
}

// -- China mode: JWKS Verifier -------------------------------

function createJwksVerifier(): JwtVerifier {
  const jwksUri = process.env.JWKS_URI;

  if (!jwksUri) {
    throw new Error('JWKS_URI must be set in china mode');
  }

  const jwks = createRemoteJWKSet(new URL(jwksUri));

  return {
    async verify(token: string): Promise<JwtPayload> {
      try {
        const { payload } = await jwtVerify(token, jwks);
        return {
          sub: (payload.sub as string) ?? '',
          email: (payload.email as string) ?? '',
          groups: (payload.groups as string[]) ?? [],
        };
      } catch (err: unknown) {
        if (err instanceof joseErrors.JWTExpired) {
          throw new AppError(401, ErrorCode.TOKEN_EXPIRED, 'Token has expired');
        }
        throw new AppError(401, ErrorCode.INVALID_TOKEN, 'Invalid token');
      }
    },
  };
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

/** Check if an error indicates token expiration (aws-jwt-verify) */
function isTokenExpiredError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return msg.includes('expired') || msg.includes('exp');
  }
  return false;
}

/** Extract Bearer token from Authorization header */
function extractBearerToken(request: FastifyRequest): string | null {
  const authHeader = request.headers.authorization;
  if (!authHeader) return null;

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') return null;

  return parts[1];
}

// ------------------------------------------------------------
// Verifier Singleton (lazy-initialized)
// ------------------------------------------------------------

let _verifier: JwtVerifier | null = null;

function getVerifier(): JwtVerifier {
  if (_verifier) return _verifier;

  _verifier =
    getDeploymentMode() === 'china' ? createJwksVerifier() : createCognitoVerifier();

  return _verifier;
}

/**
 * Reset the cached verifier. Useful for testing when switching
 * between deployment modes.
 */
export function resetVerifier(): void {
  _verifier = null;
}

// ------------------------------------------------------------
// Fastify preHandler Hook
// ------------------------------------------------------------

/**
 * Dual-mode JWT authentication middleware.
 *
 * - Extracts JWT from `Authorization: Bearer <token>` header
 * - Verifies signature and expiration using the appropriate verifier
 *   based on `DEPLOYMENT_MODE` env var (global → Cognito, china → JWKS)
 * - Injects parsed `JwtPayload` into `request.jwtPayload`
 * - Admin group members (`openclaw-admins`) can perform all operations
 * - Non-admin authenticated users can only perform read operations (GET)
 *
 * Error responses:
 * - 401 when JWT is missing, invalid, or expired
 * - 403 when non-admin user attempts a write operation (POST/PUT/DELETE)
 */
export const authMiddleware: preHandlerHookHandler = async (
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> => {
  // Dev mode bypass: skip JWT verification when AUTH_BYPASS is set
  // The "token" is actually the username from the login form.
  // Username "admin" → admin role, anything else → viewer (read-only).
  if (process.env.AUTH_BYPASS === 'true') {
    const devToken = extractBearerToken(request) ?? 'anonymous';
    const isDevAdmin = devToken === 'admin';
    request.jwtPayload = {
      sub: devToken,
      email: `${devToken}@localhost`,
      groups: isDevAdmin ? ['openclaw-admins'] : [],
    };

    // Still enforce read-only for non-admin in dev mode
    const isWriteMethod = request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS';
    if (!isDevAdmin && isWriteMethod) {
      throw new AppError(403, ErrorCode.INSUFFICIENT_PERMISSIONS, 'Write operations require admin privileges');
    }
    return;
  }

  // 1. Extract token
  const token = extractBearerToken(request);
  if (!token) {
    throw new AppError(401, ErrorCode.MISSING_TOKEN, 'Missing or malformed Authorization header');
  }

  // 2. Verify token (signature + expiration)
  const verifier = getVerifier();
  const payload = await verifier.verify(token);

  // 3. Inject payload into request context
  request.jwtPayload = payload;

  // 4. Role-based access control:
  //    - Admin group → full access (read + write)
  //    - Authenticated non-admin → read-only (GET only)
  const isAdmin = payload.groups.includes(ADMIN_GROUP);
  const isWriteMethod = request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS';

  if (!isAdmin && isWriteMethod) {
    throw new AppError(
      403,
      ErrorCode.INSUFFICIENT_PERMISSIONS,
      'Write operations require admin privileges',
    );
  }
};

// ------------------------------------------------------------
// Fastify Type Augmentation
// ------------------------------------------------------------

declare module 'fastify' {
  interface FastifyRequest {
    jwtPayload?: JwtPayload;
  }
}

// ------------------------------------------------------------
// Exported Utilities (for testing / other modules)
// ------------------------------------------------------------

export { extractBearerToken, ADMIN_GROUP };
