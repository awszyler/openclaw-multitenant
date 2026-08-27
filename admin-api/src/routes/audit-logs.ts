// ============================================================
// Audit Log Routes for OpenClaw Admin Platform
// Validates: Requirements 6.2, 10.3
// ============================================================

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authMiddleware } from '../middleware/auth.js';
import { queryAuditLogs } from '../services/audit-service.js';
import { AppError, ErrorCode, type AuditAction } from '../lib/types.js';

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

/** Valid audit action values for query parameter validation */
const VALID_ACTIONS: Set<string> = new Set([
  'user.create',
  'user.update',
  'user.delete',
  'user.update_model',
  'user.update_status',
  'user.restart',
  'user.stop',
  'user.start',
  'provider.create',
  'provider.update',
  'provider.delete',
  'system.health_check',
]);

/** Validate a date string is in YYYY-MM-DD format */
function isValidDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !isNaN(Date.parse(value));
}

// ------------------------------------------------------------
// Route Plugin
// ------------------------------------------------------------

export default async function auditLogsRoutes(app: FastifyInstance): Promise<void> {
  // Apply authMiddleware to all routes in this plugin
  app.addHook('preHandler', authMiddleware);

  // ----------------------------------------------------------
  // GET /api/audit-logs — Query audit logs with filters
  //
  // Query parameters:
  //   startDate (required) — YYYY-MM-DD inclusive start
  //   endDate   (required) — YYYY-MM-DD inclusive end
  //   action    (optional) — filter by action type
  //   actor     (optional) — filter by actor userId
  // ----------------------------------------------------------
  app.get(
    '/api/audit-logs',
    async (
      request: FastifyRequest<{
        Querystring: {
          startDate?: string;
          endDate?: string;
          action?: string;
          actor?: string;
        };
      }>,
      _reply: FastifyReply,
    ) => {
      const { startDate, endDate, action, actor } = request.query;

      // Validate required date parameters
      if (!startDate || !endDate) {
        throw new AppError(
          400,
          ErrorCode.INTERNAL_ERROR,
          'startDate and endDate query parameters are required (YYYY-MM-DD)',
        );
      }

      if (!isValidDate(startDate)) {
        throw new AppError(
          400,
          ErrorCode.INTERNAL_ERROR,
          `Invalid startDate format: '${startDate}'. Expected YYYY-MM-DD`,
        );
      }

      if (!isValidDate(endDate)) {
        throw new AppError(
          400,
          ErrorCode.INTERNAL_ERROR,
          `Invalid endDate format: '${endDate}'. Expected YYYY-MM-DD`,
        );
      }

      if (startDate > endDate) {
        throw new AppError(
          400,
          ErrorCode.INTERNAL_ERROR,
          'startDate must not be after endDate',
        );
      }

      // Validate optional action parameter
      if (action && !VALID_ACTIONS.has(action)) {
        throw new AppError(
          400,
          ErrorCode.INTERNAL_ERROR,
          `Invalid action filter: '${action}'`,
        );
      }

      const logs = await queryAuditLogs(
        startDate,
        endDate,
        action as AuditAction | undefined,
        actor,
      );

      return logs;
    },
  );
}
