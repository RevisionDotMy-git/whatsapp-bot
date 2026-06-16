import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

/**
 * Audit Logger utility function to write system events to the database.
 */
export async function logAudit(
  level: 'INFO' | 'WARN' | 'ERROR',
  action: string,
  details: string,
  operator?: string
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        level,
        action,
        details,
        operator,
      },
    });
    console.log(`[AuditLog - ${level}] Action: ${action} | Operator: ${operator || 'SYSTEM'} | Details: ${details}`);
  } catch (err) {
    // Fallback console log if db is not connected
    console.error(`FAILED TO WRITE AUDIT LOG: ${err}`);
    console.log(`[AuditLog - ${level}] Action: ${action} | Details: ${details}`);
  }
}
