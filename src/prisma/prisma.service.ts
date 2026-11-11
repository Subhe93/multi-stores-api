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
 * The generated types still list both columns, so treat them as absent
 * unless the query opted in.
 */
export const PRISMA_GLOBAL_OMIT = {
  store: { meta_capi_token: true },
  order: { tracking_context: true },
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
