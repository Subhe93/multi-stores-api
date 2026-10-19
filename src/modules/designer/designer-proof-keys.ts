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

/** Which proof columns a key lives in (M5.6: the back has its own pair). */
export type ProofSide = 'front' | 'back';

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
  // Either side's column may hold the key (a 'same' back never shares the
  // front file, but the check is cheap and keeps the invariant obvious).
  const [designs, orders] = await Promise.all([
    prisma.design.count({
      where: {
        OR: [{ proof_key: key }, { proof_back_key: key }],
        ...(opts.exceptDesignId ? { id: { not: opts.exceptDesignId } } : {}),
      },
    }),
    prisma.orderItemDesign.count({
      where: {
        OR: [{ proof_key: key }, { proof_back_key: key }],
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
 * Used by `DesignerRenderService.renderAndRecordProof` (the only writer of
 * a design's proof key). Without `previousKey` the current key is read
 * right before the update, so the file a concurrent render recorded
 * meanwhile is the one released.
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
    /** M5.6: 'back' writes `proof_back_key` / `proof_back_sha`. */
    side?: ProofSide;
    logger?: Pick<Logger, 'warn'>;
  },
): Promise<boolean> {
  const back = input.side === 'back';
  const previous =
    input.previousKey !== undefined
      ? input.previousKey
      : ((): Promise<string | null> =>
          prisma.design
            .findUnique({
              where: { id: input.designId },
              select: { proof_key: true, proof_back_key: true },
            })
            .then((d) => (back ? d?.proof_back_key : d?.proof_key) ?? null))();
  const previousKey = await previous;
  const res = await prisma.design.updateMany({
    where: { id: input.designId, state_version: input.stateVersion },
    data: back
      ? { proof_back_key: input.newKey, proof_back_sha: input.stateSha }
      : { proof_key: input.newKey, proof_state_sha: input.stateSha },
  });
  if (res.count === 0) {
    await releaseProofKey(prisma, storage, input.newKey, {
      logger: input.logger,
    });
    return false;
  }
  if (previousKey && previousKey !== input.newKey) {
    await releaseProofKey(prisma, storage, previousKey, {
      logger: input.logger,
    });
  }
  return true;
}
