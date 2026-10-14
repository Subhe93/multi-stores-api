import { Injectable } from '@nestjs/common';
import { InvoiceKind, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { invoiceErrors } from './invoice-errors';
import { INVOICE_PREFIX_PATTERN } from './dto/numbering.dto';
import type { NumberingInput, NumberingSequenceInput } from './invoices.types';

/** A sequence row locked FOR UPDATE inside the caller's transaction. */
export interface LockedSequence {
  id: string;
  prefix: string;
  padding: number;
  next_number: number;
  issued_count: number;
}

/** "INV-" + 1001 padded to `padding` digits. */
export function formatInvoiceNumber(
  prefix: string,
  padding: number,
  n: number,
): string {
  return `${prefix}${String(n).padStart(Math.max(0, padding), '0')}`;
}

/** Prefix rule (D2): empty or ending in a non-digit, so prefix+n never collides. */
export function isValidPrefix(prefix: string): boolean {
  return INVOICE_PREFIX_PATTERN.test(prefix);
}

/**
 * Gapless numbering (D2). One InvoiceSequence row per (profile, kind); a
 * number is taken under SELECT ... FOR UPDATE in the same transaction that
 * inserts the document, so a rollback also rolls the counter back and
 * concurrent issuers of one profile are serialized.
 */
@Injectable()
export class InvoiceNumberingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Lock the (profile, kind) sequence for the rest of `tx`. Callers check
   * idempotency AFTER this (race-free) and only then call consume().
   */
  async lock(
    tx: Prisma.TransactionClient,
    profileId: string,
    kind: InvoiceKind,
  ): Promise<LockedSequence> {
    const rows = await tx.$queryRaw<LockedSequence[]>`
      SELECT id, prefix, padding, next_number, issued_count
      FROM "InvoiceSequence"
      WHERE legal_profile_id = ${profileId} AND kind = ${kind}::"InvoiceKind"
      FOR UPDATE`;
    if (!rows[0]) throw invoiceErrors.profileIncomplete(['numbering']);
    const r = rows[0];
    return {
      id: r.id,
      prefix: r.prefix,
      padding: Number(r.padding),
      next_number: Number(r.next_number),
      issued_count: Number(r.issued_count),
    };
  }

  /** Take the locked sequence's next number and advance the counter. */
  async consume(
    tx: Prisma.TransactionClient,
    seq: LockedSequence,
  ): Promise<{ sequence_number: number; number: string }> {
    await tx.invoiceSequence.update({
      where: { id: seq.id },
      data: {
        next_number: { increment: 1 },
        issued_count: { increment: 1 },
        last_issued_at: new Date(),
      },
    });
    return {
      sequence_number: seq.next_number,
      number: formatInvoiceNumber(seq.prefix, seq.padding, seq.next_number),
    };
  }

  /** lock() + consume() for callers without an idempotency check. */
  async allocate(
    tx: Prisma.TransactionClient,
    profileId: string,
    kind: InvoiceKind,
  ) {
    return this.consume(tx, await this.lock(tx, profileId, kind));
  }

  /**
   * PUT /invoices/my/numbering. Prefix and padding may change any time
   * (cosmetic, copied onto each document); next_number only while nothing
   * was issued in the series (continuing e.g. a WooCommerce sequence).
   */
  async updateNumbering(profileId: string, dto: NumberingInput): Promise<void> {
    const parts: [InvoiceKind, NumberingSequenceInput | undefined][] = [
      [InvoiceKind.INVOICE, dto.invoice],
      [InvoiceKind.CREDIT_NOTE, dto.credit_note],
    ];
    for (const [, input] of parts) {
      if (input?.prefix !== undefined && !isValidPrefix(input.prefix)) {
        throw invoiceErrors.numberingInvalid(
          'The prefix must be empty or end in a non-digit.',
        );
      }
    }
    await this.prisma.$transaction(async (tx) => {
      for (const [kind, input] of parts) {
        if (!input) continue;
        const seq = await this.lock(tx, profileId, kind);
        const data: Prisma.InvoiceSequenceUpdateInput = {};
        if (input.prefix !== undefined) data.prefix = input.prefix;
        if (input.padding !== undefined) data.padding = input.padding;
        if (
          input.next_number !== undefined &&
          input.next_number !== seq.next_number
        ) {
          if (seq.issued_count > 0) throw invoiceErrors.sequenceLocked();
          data.next_number = input.next_number;
          data.start_number = input.next_number;
        }
        if (Object.keys(data).length) {
          await tx.invoiceSequence.update({ where: { id: seq.id }, data });
        }
      }
    });
  }
}
