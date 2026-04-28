import { prisma } from "./db.js";
import type { Prisma } from "@prisma/client";
import { logger } from "./logger.js";

export type AuditAction = "create" | "update" | "delete";
export type AuditEntity = "physicalCopy" | "trophy" | "completion" | "book" | "reading";

/**
 * Records an audit row. Best-effort — failures here must never break the
 * primary mutation, so callers wrap us in fire-and-forget try/catches.
 */
export async function audit(opts: {
  userId?: string | null;
  action: AuditAction;
  entity: AuditEntity;
  entityId: string;
  details?: Record<string, unknown>;
}): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: opts.userId ?? null,
        action: opts.action,
        entity: opts.entity,
        entityId: opts.entityId,
        ...(opts.details ? { details: opts.details as Prisma.InputJsonValue } : {}),
      },
    });
  } catch (err) {
    logger.warn({ err, opts }, "audit log write failed");
  }
}
