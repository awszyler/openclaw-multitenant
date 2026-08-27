// ============================================================
// Authentication Routes
// Validates: Requirements 7.3, 7.5
// ============================================================

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { signAccessToken, signRefreshToken, verifyToken, loadKeyPair, publicKeyToJwk } from '../lib/jwt.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import type { JwtPayload } from '../lib/jwt.js';

// ------------------------------------------------------------
// DynamoDB Client
// ------------------------------------------------------------

const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const AUTH_USERS_TABLE = process.env.AUTH_USERS_TABLE ?? 'openclaw-auth-users-prod';

// ------------------------------------------------------------
// Route Plugin
// ------------------------------------------------------------

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  // --------------------------------------------------------
  // POST /auth/login
  // --------------------------------------------------------

  app.post('/auth/login', async (request: FastifyRequest, reply: FastifyReply) => {
    const { username, password } = request.body as { username?: string; password?: string };

    if (!username || !password) {
      return reply.status(400).send({
        error: { code: 'INVALID_REQUEST', message: 'Username and password are required' },
      });
    }

    // Fetch user from DynamoDB
    const result = await ddbClient.send(
      new GetCommand({
        TableName: AUTH_USERS_TABLE,
        Key: { user_id: username },
      }),
    );

    const user = result.Item;

    // Generic error message — do not distinguish between user-not-found and wrong-password
    if (!user) {
      return reply.status(401).send({
        error: { code: 'INVALID_CREDENTIALS', message: 'Invalid username or password' },
      });
    }

    const passwordValid = await verifyPassword(password, user.password_hash as string);
    if (!passwordValid) {
      return reply.status(401).send({
        error: { code: 'INVALID_CREDENTIALS', message: 'Invalid username or password' },
      });
    }

    // Check force_change_pwd flag
    if (user.force_change_pwd) {
      return reply.status(403).send({
        error: {
          code: 'FORCE_CHANGE_PASSWORD',
          message: 'Password change required on first login',
          details: { force_change_pwd: true },
        },
      });
    }

    // Sign tokens
    const keyPair = await loadKeyPair();
    const payload: JwtPayload = {
      sub: user.user_id as string,
      email: (user.email as string) ?? '',
      groups: (user.groups as string[]) ?? [],
    };

    const accessToken = signAccessToken(payload, keyPair.privateKey);
    const refreshToken = signRefreshToken(payload, keyPair.privateKey);

    return reply.status(200).send({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 3600,
      token_type: 'Bearer',
    });
  });

  // --------------------------------------------------------
  // POST /auth/refresh
  // --------------------------------------------------------

  app.post('/auth/refresh', async (request: FastifyRequest, reply: FastifyReply) => {
    const { refresh_token } = request.body as { refresh_token?: string };

    if (!refresh_token) {
      return reply.status(400).send({
        error: { code: 'INVALID_REQUEST', message: 'Refresh token is required' },
      });
    }

    try {
      const keyPair = await loadKeyPair();
      const decoded = verifyToken(refresh_token, keyPair.publicKey);

      // Ensure it's a refresh token
      if (decoded.token_type !== 'refresh') {
        return reply.status(401).send({
          error: { code: 'INVALID_TOKEN', message: 'Invalid refresh token' },
        });
      }

      // Sign a new access token
      const payload: JwtPayload = {
        sub: decoded.sub,
        email: decoded.email,
        groups: decoded.groups,
      };

      const accessToken = signAccessToken(payload, keyPair.privateKey);

      return reply.status(200).send({
        access_token: accessToken,
        expires_in: 3600,
        token_type: 'Bearer',
      });
    } catch {
      return reply.status(401).send({
        error: { code: 'INVALID_TOKEN', message: 'Invalid or expired refresh token' },
      });
    }
  });

  // --------------------------------------------------------
  // POST /auth/change-password
  // --------------------------------------------------------

  app.post('/auth/change-password', async (request: FastifyRequest, reply: FastifyReply) => {
    const { username, old_password, new_password } = request.body as {
      username?: string;
      old_password?: string;
      new_password?: string;
    };

    if (!username || !old_password || !new_password) {
      return reply.status(400).send({
        error: { code: 'INVALID_REQUEST', message: 'Username, old_password, and new_password are required' },
      });
    }

    if (new_password.length < 8) {
      return reply.status(400).send({
        error: { code: 'INVALID_REQUEST', message: 'New password must be at least 8 characters' },
      });
    }

    // Fetch user
    const result = await ddbClient.send(
      new GetCommand({
        TableName: AUTH_USERS_TABLE,
        Key: { user_id: username },
      }),
    );

    const user = result.Item;
    if (!user) {
      return reply.status(401).send({
        error: { code: 'INVALID_CREDENTIALS', message: 'Invalid username or password' },
      });
    }

    // Verify old password
    const passwordValid = await verifyPassword(old_password, user.password_hash as string);
    if (!passwordValid) {
      return reply.status(401).send({
        error: { code: 'INVALID_CREDENTIALS', message: 'Invalid username or password' },
      });
    }

    // Hash new password and update
    const newHash = await hashPassword(new_password);
    const now = new Date().toISOString();

    await ddbClient.send(
      new UpdateCommand({
        TableName: AUTH_USERS_TABLE,
        Key: { user_id: username },
        UpdateExpression: 'SET password_hash = :hash, force_change_pwd = :f, updated_at = :now',
        ExpressionAttributeValues: {
          ':hash': newHash,
          ':f': false,
          ':now': now,
        },
      }),
    );

    return reply.status(200).send({ success: true });
  });

  // --------------------------------------------------------
  // GET /auth/.well-known/jwks.json
  // --------------------------------------------------------

  app.get('/auth/.well-known/jwks.json', async (_request: FastifyRequest, reply: FastifyReply) => {
    const keyPair = await loadKeyPair();
    const jwk = publicKeyToJwk(keyPair.publicKey);

    return reply.status(200).send({
      keys: [jwk],
    });
  });
}
