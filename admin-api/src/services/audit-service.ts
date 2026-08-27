// ============================================================
// Audit Log Service for OpenClaw Admin Platform
// Validates: Requirements 10.1, 10.2, 10.3
// ============================================================

import { ulid } from 'ulid';
import { putItem, query, AUDIT_LOGS_TABLE } from '../lib/dynamo.js';
import type { AuditAction, AuditLog, AuditTargetType } from '../lib/types.js';

/** Number of seconds in 90 days (TTL duration) */
const TTL_90_DAYS_SECONDS = 90 * 24 * 60 * 60;

/**
 * Write an audit log entry using fire-and-forget pattern.
 * Failures are logged to console.error and do not block the caller.
 *
 * @param actor - The userId of the person performing the action (from JWT sub)
 * @param action - The action type enum value
 * @param targetType - The target entity type (user | provider | system)
 * @param targetId - The ID of the target entity
 * @param detail - A map of change details (before/after values)
 * @param ip - The source IP address of the request
 */
export function writeAuditLog(
  actor: string,
  action: AuditAction,
  targetType: AuditTargetType,
  targetId: string,
  detail: Record<string, unknown>,
  ip: string,
): void {
  const now = new Date();
  const logDate = formatDate(now);
  const isoTimestamp = now.toISOString();
  const logId = ulid();
  const timestampLogId = `${isoTimestamp}#${logId}`;
  const createdAt = isoTimestamp;
  const expireAt = Math.floor(now.getTime() / 1000) + TTL_90_DAYS_SECONDS;

  const item: AuditLog = {
    log_date: logDate,
    'timestamp#log_id': timestampLogId,
    actor,
    action,
    target_type: targetType,
    target_id: targetId,
    detail,
    ip,
    created_at: createdAt,
    expire_at: expireAt,
  };

  // Fire-and-forget: do not await, catch errors with console.error
  putItem(AUDIT_LOGS_TABLE(), item as unknown as Record<string, unknown>).catch((err: unknown) => {
    console.error('Failed to write audit log:', err);
  });
}

/**
 * Query audit logs within a date range with optional filters.
 * Iterates over each day in the range and queries the partition for that day.
 *
 * @param startDate - Start date in YYYY-MM-DD format (inclusive)
 * @param endDate - End date in YYYY-MM-DD format (inclusive)
 * @param action - Optional action type filter
 * @param actor - Optional actor filter
 * @returns Array of audit log entries sorted by timestamp
 */
export async function queryAuditLogs(
  startDate: string,
  endDate: string,
  action?: AuditAction,
  actor?: string,
): Promise<AuditLog[]> {
  const dates = getDateRange(startDate, endDate);
  const allLogs: AuditLog[] = [];

  for (const date of dates) {
    const keyConditionExpression = 'log_date = :logDate';
    const expressionAttributeValues: Record<string, unknown> = {
      ':logDate': date,
    };

    // Build optional filter expression
    const filterParts: string[] = [];
    const expressionAttributeNames: Record<string, string> = {};

    if (action) {
      filterParts.push('#action = :action');
      expressionAttributeNames['#action'] = 'action';
      expressionAttributeValues[':action'] = action;
    }

    if (actor) {
      filterParts.push('actor = :actor');
      expressionAttributeValues[':actor'] = actor;
    }

    const filterExpression = filterParts.length > 0 ? filterParts.join(' AND ') : undefined;

    const result = await query<AuditLog>(
      AUDIT_LOGS_TABLE(),
      keyConditionExpression,
      expressionAttributeValues,
      {
        filterExpression,
        expressionAttributeNames:
          Object.keys(expressionAttributeNames).length > 0
            ? expressionAttributeNames
            : undefined,
        scanIndexForward: true,
      },
    );

    allLogs.push(...result.items);
  }

  // Sort all results by the sort key (timestamp#log_id) ascending
  allLogs.sort((a, b) =>
    a['timestamp#log_id'].localeCompare(b['timestamp#log_id']),
  );

  return allLogs;
}

// ------------------------------------------------------------
// Pure Filtering Logic (testable without DynamoDB)
// ------------------------------------------------------------

/**
 * Filter criteria for audit logs.
 */
export interface AuditLogFilterCriteria {
  startDate?: string; // YYYY-MM-DD inclusive
  endDate?: string;   // YYYY-MM-DD inclusive
  action?: AuditAction;
  actor?: string;
}

/**
 * Pure function that filters an array of audit logs based on the given criteria.
 * Returns only entries that satisfy ALL provided filter conditions.
 *
 * - startDate/endDate: filter by log_date (inclusive range)
 * - action: exact match on action field
 * - actor: exact match on actor field
 *
 * @param logs - The full set of audit log entries
 * @param criteria - The filter conditions to apply
 * @returns Filtered audit log entries
 */
export function filterAuditLogs(
  logs: AuditLog[],
  criteria: AuditLogFilterCriteria,
): AuditLog[] {
  return logs.filter((log) => {
    // Date range filter
    if (criteria.startDate && log.log_date < criteria.startDate) {
      return false;
    }
    if (criteria.endDate && log.log_date > criteria.endDate) {
      return false;
    }

    // Action filter
    if (criteria.action && log.action !== criteria.action) {
      return false;
    }

    // Actor filter
    if (criteria.actor && log.actor !== criteria.actor) {
      return false;
    }

    return true;
  });
}

// ------------------------------------------------------------
// Helper Functions
// ------------------------------------------------------------

/**
 * Format a Date object as YYYY-MM-DD string.
 */
export function formatDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Generate an array of date strings (YYYY-MM-DD) from startDate to endDate inclusive.
 */
export function getDateRange(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const current = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');

  while (current <= end) {
    dates.push(formatDate(current));
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return dates;
}
