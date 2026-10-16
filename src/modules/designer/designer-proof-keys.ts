/**
 * Proof file bookkeeping of the designer app (M4.2 fixes, retention).
 *
 * A proof key can be shared: the order snapshot reuses the draft's proof
 * (`OrderItemDesign.proof_key = Design.proof_key`, §5.4), so a proof file is
 * deleted only when no other design and no order design whose files are
 * still kept references it.
 *
 * `replaceDesignProofKey` is the one place a design's proof key changes:
 * the new key is recorded (fenced by `state_version`) and the previous file
 * deleted when nothing else uses it. A key that lost the race is released
 * instead, so no proof file is ever left without a row.
 */
import type { Logger } from '@nestjs/common';
import type { PrismaService } from '../../prisma/prisma.service';
import type { PrivateStorage } from '../../common/storage/private-file-storage';

type Db = Pick<PrismaService, 'design' | 'orderItemDesign'>;

/**
 * Deletes a proof file unless another row still references it. Returns
 * true when the file was deleted. Never throws unless `strict` (retention
 * reverts its claim on a storage failure).
 */
export async function releaseProofKey(
  prisma: Db,
  storage: Pick<PrivateStorage, 'delete'>,
  key: string | null | undefined,
  opts: {
    exceptDesignId?: string | null;
    exceptOrderDesignId?: string | null;
    strict?: boolean;
    logger?: Pick<Logger, 'warn'>;
  } = {},
): Promise<boolean> {
  if (!key) return false;
  const [designs, orders] = await Promise.all([
    prisma.design.count({
      where: {
        proof_key: key,
        ...(opts.exceptDesignId ? { id: { not: opts.exceptDesignId } } : {}),
      },
    }),
    prisma.orderItemDesign.count({
      where: {
        proof_key: key,
        files_purged_at: null,
        ...(opts.exceptOrderDesignId
          ? { id: { not: opts.exceptOrderDesignId } }
          : {}),
      },
    }),
  ]);
  if (designs > 0 || orders > 0) return false;
  try {
    await storage.delete(key);
    return true;
  } catch (e) {
    if (opts.strict) throw e;
    opts.logger?.warn(`designer proof ${key} not deleted: ${String(e)}`);
    return false;
  }
}

/**
 * Records `newKey` as the design's proof when the state is still the one
 * rendered (`state_version`), then deletes the previous proof file if
 * nothing else references it. When the state moved on meanwhile, the new
 * file is released instead. Returns whether the key was recorded.
 *
 * Render service hand-off (fixer B): `renderDesignProof` should call this
 * instead of its own `design.updateMany({proof_key, proof_state_sha})`.
 */
export async function replaceDesignProofKey(
  prisma: Db,
  storage: Pick<PrivateStorage, 'delete'>,
  input: {
    designId: string;
    stateVersion: number;
    newKey: string;
    stateSha: string;
    previousKey?: string | null;
    logger?: Pick<Logger, 'warn'>;
  },
): Promise<boolean> {
  const previous =
    input.previousKey !== undefined
      ? input.previousKey
      : ((
          await prisma.design.findUnique({
            where: { id: input.designId },
            select: { proof_key: true },
          })
        )?.proof_key ?? null);
  const res = await prisma.design.updateMany({
    where: { id: input.designId, state_version: input.stateVersion },
    data: { proof_key: input.newKey, proof_state_sha: input.stateSha },
  });
  if (res.count === 0) {
    await releaseProofKey(prisma, storage, input.newKey, {
      logger: input.logger,
    });
    return false;
  }
  if (previous && previous !== input.newKey) {
    await releaseProofKey(prisma, storage, previous, { logger: input.logger });
  }
  return true;
}
