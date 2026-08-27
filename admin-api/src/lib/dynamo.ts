// ============================================================
// DynamoDB Client Wrapper for OpenClaw Admin Platform
// Validates: Requirements 2.1, 2.2, 2.3
// ============================================================

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
  ScanCommand,
  type GetCommandInput,
  type PutCommandInput,
  type UpdateCommandInput,
  type DeleteCommandInput,
  type QueryCommandInput,
  type ScanCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { AppError, ErrorCode } from './types.js';

// ------------------------------------------------------------
// Table Name Constants (from environment variables)
// ------------------------------------------------------------

/**
 * Table name accessors. Use functions to support late env var binding
 * (dev-server sets env vars before import, but ESM hoisting may evaluate early).
 */
export function USERS_TABLE(): string { return process.env.USERS_TABLE ?? ''; }
export function PROVIDERS_TABLE(): string { return process.env.PROVIDERS_TABLE ?? ''; }
export function AUDIT_LOGS_TABLE(): string { return process.env.AUDIT_LOGS_TABLE ?? ''; }

// ------------------------------------------------------------
// DynamoDB Document Client Initialization
// ------------------------------------------------------------

const ddbClient = new DynamoDBClient({});

export const docClient = DynamoDBDocumentClient.from(ddbClient, {
  marshallOptions: {
    removeUndefinedValues: true,
  },
});

// ------------------------------------------------------------
// In-Memory Store (dev mode only)
// ------------------------------------------------------------

const DEV_MODE = (): boolean => process.env.DEV_MODE === 'true';

const _memStore: Record<string, Map<string, Record<string, unknown>>> = {};

function memTable(tableName: string): Map<string, Record<string, unknown>> {
  if (!_memStore[tableName]) _memStore[tableName] = new Map();
  return _memStore[tableName];
}

function memKey(key: Record<string, unknown>): string {
  return Object.values(key).map(String).join('#');
}

/** Seed in-memory data (dev mode only). Call from dev-server.ts. */
export function seedDevData(tableName: string, items: Record<string, unknown>[], keyField: string): void {
  const table = memTable(tableName);
  for (const item of items) {
    table.set(String(item[keyField]), item);
  }
}

// ------------------------------------------------------------
// Generic Typed Wrapper Methods
// ------------------------------------------------------------

/**
 * Get a single item from a DynamoDB table by its key.
 * Returns `undefined` if the item does not exist.
 */
export async function getItem<T>(
  tableName: string,
  key: Record<string, unknown>,
): Promise<T | undefined> {
  if (DEV_MODE()) {
    return memTable(tableName).get(memKey(key)) as T | undefined;
  }
  const params: GetCommandInput = {
    TableName: tableName,
    Key: key,
  };

  try {
    const result = await docClient.send(new GetCommand(params));
    return result.Item as T | undefined;
  } catch (error) {
    throw new AppError(
      502,
      ErrorCode.UPSTREAM_ERROR,
      `DynamoDB GetItem failed on table ${tableName}: ${(error as Error).message}`,
    );
  }
}

/**
 * Put (create or overwrite) an item in a DynamoDB table.
 */
export async function putItem<T extends Record<string, unknown>>(
  tableName: string,
  item: T,
  conditionExpression?: string,
  expressionAttributeNames?: Record<string, string>,
  expressionAttributeValues?: Record<string, unknown>,
): Promise<void> {
  if (DEV_MODE()) {
    const k = Object.values(item)[0];
    memTable(tableName).set(String(k), { ...item });
    return;
  }
  const params: PutCommandInput = {
    TableName: tableName,
    Item: item,
    ...(conditionExpression && { ConditionExpression: conditionExpression }),
    ...(expressionAttributeNames && { ExpressionAttributeNames: expressionAttributeNames }),
    ...(expressionAttributeValues && { ExpressionAttributeValues: expressionAttributeValues }),
  };

  try {
    await docClient.send(new PutCommand(params));
  } catch (error) {
    const err = error as Error;
    // Surface ConditionalCheckFailedException for callers to handle (e.g. duplicate key)
    if (err.name === 'ConditionalCheckFailedException') {
      throw error;
    }
    throw new AppError(
      502,
      ErrorCode.UPSTREAM_ERROR,
      `DynamoDB PutItem failed on table ${tableName}: ${err.message}`,
    );
  }
}

/**
 * Update an item in a DynamoDB table using an update expression.
 * Returns the updated attributes based on the ReturnValues setting.
 */
export async function updateItem<T>(
  tableName: string,
  key: Record<string, unknown>,
  updateExpression: string,
  expressionAttributeNames?: Record<string, string>,
  expressionAttributeValues?: Record<string, unknown>,
  conditionExpression?: string,
): Promise<T | undefined> {
  if (DEV_MODE()) {
    const existing = memTable(tableName).get(memKey(key));
    if (!existing) return undefined;
    if (expressionAttributeNames && expressionAttributeValues) {
      for (const [alias, fieldName] of Object.entries(expressionAttributeNames)) {
        const valueAlias = alias.replace('#', ':');
        if (valueAlias in expressionAttributeValues) {
          existing[fieldName] = expressionAttributeValues[valueAlias];
        }
      }
    }
    memTable(tableName).set(memKey(key), existing);
    return existing as T;
  }
  const params: UpdateCommandInput = {
    TableName: tableName,
    Key: key,
    UpdateExpression: updateExpression,
    ReturnValues: 'ALL_NEW',
    ...(expressionAttributeNames && { ExpressionAttributeNames: expressionAttributeNames }),
    ...(expressionAttributeValues && { ExpressionAttributeValues: expressionAttributeValues }),
    ...(conditionExpression && { ConditionExpression: conditionExpression }),
  };

  try {
    const result = await docClient.send(new UpdateCommand(params));
    return result.Attributes as T | undefined;
  } catch (error) {
    const err = error as Error;
    if (err.name === 'ConditionalCheckFailedException') {
      throw error;
    }
    throw new AppError(
      502,
      ErrorCode.UPSTREAM_ERROR,
      `DynamoDB UpdateItem failed on table ${tableName}: ${err.message}`,
    );
  }
}

/**
 * Delete an item from a DynamoDB table by its key.
 */
export async function deleteItem(
  tableName: string,
  key: Record<string, unknown>,
  conditionExpression?: string,
  expressionAttributeNames?: Record<string, string>,
  expressionAttributeValues?: Record<string, unknown>,
): Promise<void> {
  if (DEV_MODE()) {
    memTable(tableName).delete(memKey(key));
    return;
  }
  const params: DeleteCommandInput = {
    TableName: tableName,
    Key: key,
    ...(conditionExpression && { ConditionExpression: conditionExpression }),
    ...(expressionAttributeNames && { ExpressionAttributeNames: expressionAttributeNames }),
    ...(expressionAttributeValues && { ExpressionAttributeValues: expressionAttributeValues }),
  };

  try {
    await docClient.send(new DeleteCommand(params));
  } catch (error) {
    const err = error as Error;
    if (err.name === 'ConditionalCheckFailedException') {
      throw error;
    }
    throw new AppError(
      502,
      ErrorCode.UPSTREAM_ERROR,
      `DynamoDB DeleteItem failed on table ${tableName}: ${err.message}`,
    );
  }
}

/**
 * Query items from a DynamoDB table or index.
 * Automatically handles pagination to return all matching items.
 */
export async function query<T>(
  tableName: string,
  keyConditionExpression: string,
  expressionAttributeValues: Record<string, unknown>,
  options?: {
    indexName?: string;
    filterExpression?: string;
    expressionAttributeNames?: Record<string, string>;
    limit?: number;
    scanIndexForward?: boolean;
    exclusiveStartKey?: Record<string, unknown>;
  },
): Promise<{ items: T[]; lastEvaluatedKey?: Record<string, unknown> }> {
  if (DEV_MODE()) {
    const allItems = Array.from(memTable(tableName).values());
    const items = allItems.filter((item) => {
      for (const [key, value] of Object.entries(expressionAttributeValues)) {
        const fieldName = key.replace(':', '');
        if (item[fieldName] === value) return true;
      }
      return false;
    });
    return { items: items as T[] };
  }
  const params: QueryCommandInput = {
    TableName: tableName,
    KeyConditionExpression: keyConditionExpression,
    ExpressionAttributeValues: expressionAttributeValues,
    ...(options?.indexName && { IndexName: options.indexName }),
    ...(options?.filterExpression && { FilterExpression: options.filterExpression }),
    ...(options?.expressionAttributeNames && {
      ExpressionAttributeNames: options.expressionAttributeNames,
    }),
    ...(options?.limit && { Limit: options.limit }),
    ...(options?.scanIndexForward !== undefined && {
      ScanIndexForward: options.scanIndexForward,
    }),
    ...(options?.exclusiveStartKey && {
      ExclusiveStartKey: options.exclusiveStartKey,
    }),
  };

  try {
    const result = await docClient.send(new QueryCommand(params));
    return {
      items: (result.Items ?? []) as T[],
      lastEvaluatedKey: result.LastEvaluatedKey as Record<string, unknown> | undefined,
    };
  } catch (error) {
    throw new AppError(
      502,
      ErrorCode.UPSTREAM_ERROR,
      `DynamoDB Query failed on table ${tableName}: ${(error as Error).message}`,
    );
  }
}

/**
 * Scan all items from a DynamoDB table with optional filtering.
 * Automatically handles pagination to return all matching items.
 */
export async function scan<T>(
  tableName: string,
  options?: {
    filterExpression?: string;
    expressionAttributeNames?: Record<string, string>;
    expressionAttributeValues?: Record<string, unknown>;
    limit?: number;
    exclusiveStartKey?: Record<string, unknown>;
  },
): Promise<{ items: T[]; lastEvaluatedKey?: Record<string, unknown> }> {
  if (DEV_MODE()) {
    let items = Array.from(memTable(tableName).values()) as T[];
    if (options?.filterExpression && options.expressionAttributeNames && options.expressionAttributeValues) {
      const names = options.expressionAttributeNames;
      const values = options.expressionAttributeValues;
      const expr = options.filterExpression;
      items = items.filter((item) => {
        const rec = item as Record<string, unknown>;
        for (const [alias, fieldName] of Object.entries(names)) {
          const valueAlias = alias.replace('#', ':');
          if (valueAlias in values) {
            if (expr.includes(`${alias} <> ${valueAlias}`) && rec[fieldName] === values[valueAlias]) return false;
            if (expr.includes(`${alias} = ${valueAlias}`) && rec[fieldName] !== values[valueAlias]) return false;
          }
        }
        return true;
      });
    }
    return { items };
  }
  const params: ScanCommandInput = {
    TableName: tableName,
    ...(options?.filterExpression && { FilterExpression: options.filterExpression }),
    ...(options?.expressionAttributeNames && {
      ExpressionAttributeNames: options.expressionAttributeNames,
    }),
    ...(options?.expressionAttributeValues && {
      ExpressionAttributeValues: options.expressionAttributeValues,
    }),
    ...(options?.limit && { Limit: options.limit }),
    ...(options?.exclusiveStartKey && {
      ExclusiveStartKey: options.exclusiveStartKey,
    }),
  };

  try {
    const result = await docClient.send(new ScanCommand(params));
    return {
      items: (result.Items ?? []) as T[],
      lastEvaluatedKey: result.LastEvaluatedKey as Record<string, unknown> | undefined,
    };
  } catch (error) {
    throw new AppError(
      502,
      ErrorCode.UPSTREAM_ERROR,
      `DynamoDB Scan failed on table ${tableName}: ${(error as Error).message}`,
    );
  }
}
