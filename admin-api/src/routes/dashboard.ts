// ============================================================
// Dashboard & System Health Routes for OpenClaw Admin Platform
// Validates: Requirements 6.1, 6.3
// ============================================================

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  ECSClient,
  ListTasksCommand,
} from '@aws-sdk/client-ecs';
import { authMiddleware } from '../middleware/auth.js';
import { scan, USERS_TABLE, PROVIDERS_TABLE } from '../lib/dynamo.js';
import type { User, Provider, DashboardData, HealthStatus } from '../lib/types.js';

// ------------------------------------------------------------
// AWS Clients & Environment Configuration
// ------------------------------------------------------------

const ecsClient = new ECSClient({});

const ECS_CLUSTER = process.env.ECS_CLUSTER ?? '';
const LITELLM_URL = process.env.LITELLM_URL ?? 'http://localhost:4000';

// ------------------------------------------------------------
// Pure Aggregation Logic (exported for property testing)
// ------------------------------------------------------------

/**
 * Pure function that aggregates dashboard data from raw user and provider lists.
 *
 * - total_users: count of users whose status is NOT 'deleted'
 * - active_users: count of users whose status is 'active'
 * - monthly_token_usage: sum of usage_tokens for users whose usage_month matches currentMonth
 * - available_models: count of providers whose status is 'active'
 * - running_containers: passed in from ECS (not computed here)
 *
 * @param users - All users from Users Table (including deleted)
 * @param providers - All providers from Providers Table
 * @param runningContainers - Number of running ECS tasks (from external source)
 * @param currentMonth - Current month string in YYYY-MM format
 * @returns Aggregated dashboard data
 */
export function aggregateDashboardData(
  users: Pick<User, 'status' | 'usage_tokens' | 'usage_month'>[],
  providers: Pick<Provider, 'status'>[],
  runningContainers: number,
  currentMonth: string,
): DashboardData {
  let totalUsers = 0;
  let activeUsers = 0;
  let monthlyTokenUsage = 0;

  for (const user of users) {
    if (user.status !== 'deleted') {
      totalUsers++;
    }
    if (user.status === 'active') {
      activeUsers++;
    }
    if (user.usage_month === currentMonth) {
      monthlyTokenUsage += user.usage_tokens ?? 0;
    }
  }

  let availableModels = 0;
  for (const provider of providers) {
    if (provider.status === 'active') {
      availableModels++;
    }
  }

  return {
    total_users: totalUsers,
    active_users: activeUsers,
    running_containers: runningContainers,
    monthly_token_usage: monthlyTokenUsage,
    available_models: availableModels,
  };
}

// ------------------------------------------------------------
// Internal Helpers
// ------------------------------------------------------------

/**
 * Get the current month as YYYY-MM string.
 */
function getCurrentMonth(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/**
 * Get the count of running ECS tasks in the cluster.
 * Uses ListTasks with desiredStatus=RUNNING.
 */
async function getRunningContainerCount(): Promise<number> {
  if (!ECS_CLUSTER) {
    return 0;
  }

  try {
    const result = await ecsClient.send(
      new ListTasksCommand({
        cluster: ECS_CLUSTER,
        desiredStatus: 'RUNNING',
      }),
    );
    return result.taskArns?.length ?? 0;
  } catch {
    // If ECS call fails, return 0 rather than failing the whole dashboard
    return 0;
  }
}

// ------------------------------------------------------------
// Route Plugin
// ------------------------------------------------------------

export default async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  // Apply authMiddleware to all routes in this plugin
  app.addHook('preHandler', authMiddleware);

  // ----------------------------------------------------------
  // GET /api/dashboard — Aggregated dashboard data
  // ----------------------------------------------------------
  app.get('/api/dashboard', async (_request: FastifyRequest, _reply: FastifyReply) => {
    // Fetch users, providers, and running container count in parallel
    const [userResult, providerResult, runningContainers] = await Promise.all([
      scan<User>(USERS_TABLE()),
      scan<Provider>(PROVIDERS_TABLE()),
      getRunningContainerCount(),
    ]);

    const currentMonth = getCurrentMonth();

    const dashboard = aggregateDashboardData(
      userResult.items,
      providerResult.items,
      runningContainers,
      currentMonth,
    );

    return dashboard;
  });

  // ----------------------------------------------------------
  // GET /api/system/health — System health check
  // ----------------------------------------------------------
  app.get('/api/system/health', async (_request: FastifyRequest, _reply: FastifyReply) => {
    const health: Record<string, 'healthy' | 'unhealthy'> = {
      dynamodb: 'unhealthy',
      ecs: 'unhealthy',
      s3: 'unhealthy',
    };

    // Check DynamoDB connectivity (scan with limit 1)
    const dynamoCheck = scan(USERS_TABLE(), { limit: 1 })
      .then(() => { health.dynamodb = 'healthy'; })
      .catch(() => { /* remains unhealthy */ });

    // Check ECS connectivity (list tasks)
    const ecsCheck = (async () => {
      if (!ECS_CLUSTER) return;
      try {
        await ecsClient.send(
          new ListTasksCommand({
            cluster: ECS_CLUSTER,
            maxResults: 1,
          }),
        );
        health.ecs = 'healthy';
      } catch {
        /* remains unhealthy */
      }
    })();

    // Check S3 data bucket connectivity (list objects with limit 1)
    const s3Check = (async () => {
      try {
        const bucketName = process.env.DATA_BUCKET ?? '';
        if (!bucketName) return;
        // @aws-sdk/client-s3 is externalized (available in Lambda runtime)
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { ListObjectsV2Command, S3Client } = require('@aws-sdk/client-s3');
        const s3 = new S3Client({});
        await s3.send(new ListObjectsV2Command({ Bucket: bucketName, MaxKeys: 1 }));
        health.s3 = 'healthy';
      } catch {
        /* remains unhealthy */
      }
    })();

    // Run all checks in parallel
    await Promise.all([dynamoCheck, ecsCheck, s3Check]);

    return health;
  });
}
