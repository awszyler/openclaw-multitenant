// ============================================================
// Admin Routes (Internal ALB only)
// Validates: Requirements 7.2
// ============================================================

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { hashPassword } from '../lib/password.js';

// ------------------------------------------------------------
// DynamoDB Client
// ------------------------------------------------------------

const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const AUTH_USERS_TABLE = process.env.AUTH_USERS_TABLE ?? 'openclaw-auth-users-prod';

// ------------------------------------------------------------
// Route Plugin
// ------------------------------------------------------------

export default async function adminRoutes(app: FastifyInstance): Promise<void> {
  // --------------------------------------------------------
  // POST /admin/users — Create admin account
  // Only accessible via internal ALB
  // --------------------------------------------------------

  app.post('/admin/users', async (request: FastifyRequest, reply: FastifyReply) => {
    const { user_id, email, password, groups } = request.body as {
      user_id?: string;
      email?: string;
      password?: string;
      groups?: string[];
    };

    if (!user_id || !email || !password) {
      return reply.status(400).send({
        error: { code: 'INVALID_REQUEST', message: 'user_id, email, and password are required' },
      });
    }

    // Check if user already exists
    const existing = await ddbClient.send(
      new GetCommand({
        TableName: AUTH_USERS_TABLE,
        Key: { user_id },
      }),
    );

    if (existing.Item) {
      return reply.status(409).send({
        error: { code: 'USER_ALREADY_EXISTS', message: `User '${user_id}' already exists` },
      });
    }

    // Hash password and create user
    const passwordHash = await hashPassword(password);
    const now = new Date().toISOString();

    await ddbClient.send(
      new PutCommand({
        TableName: AUTH_USERS_TABLE,
        Item: {
          user_id,
          email,
          password_hash: passwordHash,
          groups: groups ?? ['openclaw-admins'],
          force_change_pwd: true,
          created_at: now,
          updated_at: now,
        },
      }),
    );

    return reply.status(201).send({
      user_id,
      email,
      groups: groups ?? ['openclaw-admins'],
      force_change_pwd: true,
      created_at: now,
    });
  });
}
