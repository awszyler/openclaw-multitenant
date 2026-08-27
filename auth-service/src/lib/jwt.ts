// ============================================================
// JWT Signing & Verification Module (RS256)
// Validates: Requirements 7.6, 7.9
// ============================================================

import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

// ------------------------------------------------------------
// Types
// ------------------------------------------------------------

export interface JwtPayload {
  sub: string;
  email: string;
  groups: string[];
}

export interface KeyPair {
  privateKey: string;
  publicKey: string;
}

// ------------------------------------------------------------
// Key Management
// ------------------------------------------------------------

let cachedKeyPair: KeyPair | null = null;

const secretsClient = new SecretsManagerClient({});

/**
 * Load RS256 key pair from Secrets Manager.
 * Caches the result in memory for the lifetime of the process.
 */
export async function loadKeyPair(): Promise<KeyPair> {
  if (cachedKeyPair) {
    return cachedKeyPair;
  }

  const secretName = process.env.AUTH_KEYS_SECRET ?? 'openclaw/prod/admin/auth-keys';

  const command = new GetSecretValueCommand({ SecretId: secretName });
  const response = await secretsClient.send(command);

  if (!response.SecretString) {
    throw new Error('Auth keys secret is empty');
  }

  const parsed = JSON.parse(response.SecretString) as { privateKey: string; publicKey: string };
  cachedKeyPair = {
    privateKey: parsed.privateKey,
    publicKey: parsed.publicKey,
  };

  return cachedKeyPair;
}

/**
 * Generate a new RS256 key pair (utility for initial setup).
 */
export function generateKeyPair(): KeyPair {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { privateKey, publicKey };
}

// ------------------------------------------------------------
// Token Signing
// ------------------------------------------------------------

const ACCESS_TOKEN_EXPIRY = '1h';
const REFRESH_TOKEN_EXPIRY = '7d';
const ISSUER = 'openclaw-auth-service';

/**
 * Sign an access token (1 hour expiry).
 * Payload includes sub, email, groups.
 */
export function signAccessToken(payload: JwtPayload, privateKey: string): string {
  return jwt.sign(
    {
      sub: payload.sub,
      email: payload.email,
      groups: payload.groups,
    },
    privateKey,
    {
      algorithm: 'RS256',
      expiresIn: ACCESS_TOKEN_EXPIRY,
      issuer: ISSUER,
    },
  );
}

/**
 * Sign a refresh token (7 day expiry).
 * Payload includes sub, email, groups.
 */
export function signRefreshToken(payload: JwtPayload, privateKey: string): string {
  return jwt.sign(
    {
      sub: payload.sub,
      email: payload.email,
      groups: payload.groups,
      token_type: 'refresh',
    },
    privateKey,
    {
      algorithm: 'RS256',
      expiresIn: REFRESH_TOKEN_EXPIRY,
      issuer: ISSUER,
    },
  );
}

// ------------------------------------------------------------
// Token Verification
// ------------------------------------------------------------

export interface VerifiedToken extends JwtPayload {
  iat: number;
  exp: number;
  iss: string;
  token_type?: string;
}

/**
 * Verify a JWT token using the RS256 public key.
 * Returns the decoded payload if valid, throws otherwise.
 */
export function verifyToken(token: string, publicKey: string): VerifiedToken {
  const decoded = jwt.verify(token, publicKey, {
    algorithms: ['RS256'],
    issuer: ISSUER,
  });

  return decoded as VerifiedToken;
}

/**
 * Extract the public key in JWK format for the JWKS endpoint.
 */
export function publicKeyToJwk(publicKeyPem: string): object {
  const keyObject = crypto.createPublicKey(publicKeyPem);
  const jwk = keyObject.export({ format: 'jwk' });
  return {
    ...jwk,
    alg: 'RS256',
    use: 'sig',
    kid: crypto.createHash('sha256').update(publicKeyPem).digest('hex').slice(0, 16),
  };
}
