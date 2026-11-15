import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Columns that no query returns unless it asks for them explicitly (a
 * `select` naming the column, or `omit: { <column>: false }` on the query):
 *   - Store.meta_capi_token: the encrypted Meta Conversions API token. Store
 *     rows are returned whole by many endpoints (owner, admin, provider,
 *     public), so the column is kept out of every read by default.
 *   - Order.tracking_context: the buyer's IP / user agent / Meta cookies,
 *     read only by MetaConversionsService.
 *   - ProductTranslation.email_note: the per-product order confirmation
 *     note (headless booking E2). Translations are read with
 *     `translations: true` by the storefront, cart, page builder and more,
 *     so the note is kept out of all of them; only the mail include and the
 *     owner product read / update / duplicate opt in.
 * The generated types still list these columns, so treat them as absent
 * unless the query opted in.
 */
export const PRISMA_GLOBAL_OMIT = {
  store: { meta_capi_token: true },
  order: { tracking_context: true },
  productTranslation: { email_note: true },
} as const;

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    super({ omit: PRISMA_GLOBAL_OMIT });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
