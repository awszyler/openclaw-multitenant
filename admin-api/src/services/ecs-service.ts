// ============================================================
// ECS Container Management Service for OpenClaw Admin Platform
// Validates: Requirements 3.7, 3.8, 3.9
// ============================================================

import {
  ECSClient,
  RunTaskCommand,
  StopTaskCommand,
  DescribeTasksCommand,
  type Task,
  type KeyValuePair,
} from '@aws-sdk/client-ecs';
import { updateItem, USERS_TABLE } from '../lib/dynamo.js';
import { AppError, ErrorCode } from '../lib/types.js';

// ------------------------------------------------------------
// AWS Clients & Environment Configuration
// ------------------------------------------------------------

const ecsClient = new ECSClient({});

const ECS_CLUSTER = process.env.ECS_CLUSTER ?? '';
const ECS_TASK_DEFINITION = process.env.ECS_TASK_DEFINITION ?? '';
const ECS_SUBNETS = process.env.ECS_SUBNETS ?? '';
const ECS_SECURITY_GROUPS = process.env.ECS_SECURITY_GROUPS ?? '';
const STAGE = process.env.STAGE ?? 'dev';
const DATA_BUCKET = process.env.DATA_BUCKET ?? '';

// ------------------------------------------------------------
// Types
// ------------------------------------------------------------

/** Configuration required to start an ECS container for a user */
export interface StartContainerConfig {
  ecrImage: string;
  skillGroup: string;
  s3StatePath: string;
  openclawConfigB64: string;
  wecomBotId?: string;
  /** Region to inject as AWS_REGION so the in-container AWS SDK default
   *  credential chain talks to the right Bedrock endpoint. Only relevant
   *  for bedrock-type providers; litellm traffic is region-agnostic. */
  bedrockRegion?: string;
}

/** Container status information returned by getContainerStatus */
export interface ContainerStatusInfo {
  taskArn: string;
  lastStatus: string;
  desiredStatus: string;
  privateIp?: string;
  healthStatus?: string;
  startedAt?: string;
  stoppedAt?: string;
  stoppedReason?: string;
}

// ------------------------------------------------------------
// ECS Service Functions
// ------------------------------------------------------------

/**
 * Start an ECS container for a user.
 * Calls ECS RunTask and updates the Users Table with task_arn and task_status.
 *
 * @param userId - The user ID to start a container for
 * @param config - Container configuration (image, skill group, etc.)
 * @returns The ARN of the started ECS task
 * @throws AppError 500 if RunTask fails or returns no tasks
 */
export async function startContainer(
  userId: string,
  config: StartContainerConfig,
): Promise<string> {
  const subnets = ECS_SUBNETS.split(',').filter(Boolean);
  const securityGroups = ECS_SECURITY_GROUPS.split(',').filter(Boolean);

  const overrides: KeyValuePair[] = [
    { name: 'OPENCLAW_USER_ID', value: userId },
    { name: 'OPENCLAW_STAGE', value: STAGE },
    { name: 'OPENCLAW_CONFIG_B64', value: config.openclawConfigB64 },
    { name: 'SESSION_BUCKET', value: DATA_BUCKET },
  ];

  if (config.bedrockRegion) {
    overrides.push({ name: 'AWS_REGION', value: config.bedrockRegion });
    overrides.push({ name: 'AWS_DEFAULT_REGION', value: config.bedrockRegion });
  }

  try {
    const result = await ecsClient.send(
      new RunTaskCommand({
        cluster: ECS_CLUSTER,
        taskDefinition: ECS_TASK_DEFINITION,
        launchType: 'FARGATE',
        count: 1,
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets,
            securityGroups,
            assignPublicIp: 'DISABLED',
          },
        },
        overrides: {
          containerOverrides: [
            {
              name: 'openclaw',
              environment: overrides,
            },
            {
              name: 'cred-proxy',
              environment: [
                { name: 'OPENCLAW_USER_ID', value: userId },
                { name: 'SESSION_BUCKET', value: DATA_BUCKET },
              ],
            },
          ],
        },
        tags: [
          { key: 'openclaw:user-id', value: userId },
          { key: 'openclaw:stage', value: STAGE },
          { key: 'openclaw:skill-group', value: config.skillGroup },
        ],
      }),
    );

    const task = result.tasks?.[0];
    if (!task?.taskArn) {
      const failureReason =
        result.failures?.[0]?.reason ?? 'Unknown failure';
      throw new AppError(
        500,
        ErrorCode.INTERNAL_ERROR,
        `ECS RunTask failed for user '${userId}': ${failureReason}`,
      );
    }

    const taskArn = task.taskArn;

    // Update Users Table with task_arn and task_status
    await updateUsersTableTaskInfo(userId, taskArn, task.lastStatus ?? 'PROVISIONING');

    return taskArn;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError(
      500,
      ErrorCode.INTERNAL_ERROR,
      `ECS RunTask failed for user '${userId}': ${(error as Error).message}`,
    );
  }
}

/**
 * Stop an ECS container for a user.
 * Calls ECS StopTask. Idempotent — if the task is already stopped, treats as success.
 *
 * @param userId - The user ID whose container to stop
 * @param taskArn - The ARN of the ECS task to stop
 */
export async function stopContainer(
  userId: string,
  taskArn: string,
): Promise<void> {
  try {
    await ecsClient.send(
      new StopTaskCommand({
        cluster: ECS_CLUSTER,
        task: taskArn,
        reason: `Stopped by admin platform for user ${userId}`,
      }),
    );
  } catch (error) {
    const err = error as Error;
    // Idempotent: if the task is already stopped or not found, treat as success
    if (
      err.name === 'InvalidParameterException' ||
      err.message?.includes('is not valid') ||
      err.message?.includes('not found')
    ) {
      // Task already stopped or doesn't exist — this is fine
    } else {
      throw new AppError(
        500,
        ErrorCode.INTERNAL_ERROR,
        `ECS StopTask failed for user '${userId}': ${err.message}`,
      );
    }
  }

  // Update Users Table to reflect stopped status
  await updateUsersTableTaskInfo(userId, taskArn, 'STOPPED');
}

/**
 * Restart an ECS container for a user.
 * Stops the current task, then starts a new one.
 *
 * @param userId - The user ID whose container to restart
 * @param taskArn - The ARN of the current ECS task to stop
 * @param config - Container configuration for the new task
 * @returns The ARN of the newly started ECS task
 */
export async function restartContainer(
  userId: string,
  taskArn: string,
  config: StartContainerConfig,
): Promise<string> {
  await stopContainer(userId, taskArn);
  return startContainer(userId, config);
}

/**
 * Get real-time container status for one or more ECS tasks.
 * Calls ECS DescribeTasks and returns status, private IP, and health status.
 *
 * @param taskArns - Array of ECS task ARNs to describe
 * @returns Array of container status info objects
 */
export async function getContainerStatus(
  taskArns: string[],
): Promise<ContainerStatusInfo[]> {
  if (taskArns.length === 0) {
    return [];
  }

  // DescribeTasks supports up to 100 task ARNs per call
  const results: ContainerStatusInfo[] = [];
  const batchSize = 100;

  for (let i = 0; i < taskArns.length; i += batchSize) {
    const batch = taskArns.slice(i, i + batchSize);

    try {
      const response = await ecsClient.send(
        new DescribeTasksCommand({
          cluster: ECS_CLUSTER,
          tasks: batch,
        }),
      );

      const tasks = response.tasks ?? [];
      for (const task of tasks) {
        results.push(extractContainerStatus(task));
      }

      // For tasks that failed to describe, mark as unknown
      const failures = response.failures ?? [];
      for (const failure of failures) {
        results.push({
          taskArn: failure.arn ?? 'unknown',
          lastStatus: 'UNKNOWN',
          desiredStatus: 'UNKNOWN',
          stoppedReason: failure.reason,
        });
      }
    } catch (error) {
      // On DescribeTasks failure, mark all tasks in this batch as unknown
      for (const arn of batch) {
        results.push({
          taskArn: arn,
          lastStatus: 'UNKNOWN',
          desiredStatus: 'UNKNOWN',
          stoppedReason: `DescribeTasks failed: ${(error as Error).message}`,
        });
      }
    }
  }

  return results;
}

// ------------------------------------------------------------
// Internal Helpers
// ------------------------------------------------------------

/**
 * Extract container status information from an ECS Task object.
 */
function extractContainerStatus(task: Task): ContainerStatusInfo {
  // Get private IP from the first ENI attachment
  let privateIp: string | undefined;
  const eniAttachment = task.attachments?.find((a) => a.type === 'ElasticNetworkInterface');
  if (eniAttachment) {
    const ipDetail = eniAttachment.details?.find((d) => d.name === 'privateIPv4Address');
    privateIp = ipDetail?.value;
  }

  // Get health status from the main container
  const mainContainer = task.containers?.find((c) => c.name === 'openclaw');
  const healthStatus = mainContainer?.healthStatus;

  return {
    taskArn: task.taskArn ?? 'unknown',
    lastStatus: task.lastStatus ?? 'UNKNOWN',
    desiredStatus: task.desiredStatus ?? 'UNKNOWN',
    privateIp,
    healthStatus,
    startedAt: task.startedAt?.toISOString(),
    stoppedAt: task.stoppedAt?.toISOString(),
    stoppedReason: task.stoppedReason,
  };
}

/**
 * Update the Users Table with ECS task information.
 */
async function updateUsersTableTaskInfo(
  userId: string,
  taskArn: string,
  taskStatus: string,
): Promise<void> {
  const now = new Date().toISOString();

  try {
    await updateItem(
      USERS_TABLE(),
      { user_id: userId },
      'SET #task_arn = :task_arn, #task_status = :task_status, #updated_at = :updated_at',
      {
        '#task_arn': 'task_arn',
        '#task_status': 'task_status',
        '#updated_at': 'updated_at',
      },
      {
        ':task_arn': taskArn,
        ':task_status': taskStatus,
        ':updated_at': now,
      },
    );
  } catch (error) {
    // Log but don't fail the operation — the ECS action already succeeded
    console.error(
      `Failed to update Users Table task info for user '${userId}':`,
      error,
    );
  }
}
