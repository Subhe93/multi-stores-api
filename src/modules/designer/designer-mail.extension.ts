import { Injectable, Optional, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import type {
  OrderEmailEvent,
  OrderForEmail,
  OrderMailExtension,
} from '../mail/order-mail.helpers';
import {
  DESIGNER_HARD_CAP_DAYS,
  DESIGNER_TERMINAL_KEEP_DAYS,
  DesignerRetentionService,
} from './designer-retention.service';
import { DesignerTriggersService } from './designer-triggers.service';
import { DesignerUrlsService, designerMailLinkExpiry } from './designer-urls';

const DAY_MS = 24 * 60 * 60 * 1000;
/** A proof link in an email lives at least this long (retention may lag). */
export const DESIGNER_MAIL_MIN_LINK_DAYS = 7;

/**
 * Designer app in order emails (M4.2 §8.5, WP10; X27): the design proof
 * replaces the product image of a designed line. The design's text values
 * already reach the email as `source='DESIGN'` value rows (M4.0 C-SNAP), so
 * nothing else is added.
 *
 * The image is a signed `oid_proof` link (no attachment): it keeps working
 * after the app is switched off. Its expiry (`designerMailLinkExpiry`) is the
 * files purge date estimated when the email is sent (shipped + keep days,
 * cancelled + 14 days, else the hard cap after the order), never sooner than
 * 7 days and never later than the mail-link cap (30 days by default,
 * `DESIGNER_MAIL_LINK_MAX_DAYS`), so a leaked email link does not live for a
 * year. After the purge the route answers 410, like the dashboard link.
 *
 * Double-sided lines (M5.6) add a second override under `<item id>:back`
 * (the signed `oid_proof_back` link) that the items block shows under the
 * front proof; single-sided lines give the front key only, as before.
 *
 * Orders without designs give no overrides, so their emails are unchanged.
 * A store that never had a designed order (and whose app is off) costs no
 * query per email: one cached isEnabled plus a cached existence probe
 * (`DesignerTriggersService.storeHasDesigns`).
 */
@Injectable()
export class DesignerMailExtension implements OrderMailExtension, OnModuleInit {
  constructor(
    private readonly mail: MailService,
    private readonly prisma: PrismaService,
    private readonly urls: DesignerUrlsService,
    private readonly retention: DesignerRetentionService,
    // Optional so the positional spec constructors stay valid.
    @Optional() private readonly presence?: DesignerTriggersService,
  ) {}

  onModuleInit(): void {
    this.mail.registerOrderMailExtension(this);
  }

  async itemImages(
    order: OrderForEmail,
    _event: OrderEmailEvent,
  ): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    if (!order.store_id || !order.items?.length) return out;
    if (this.presence && !(await this.presence.storeHasDesigns(order.store_id)))
      return out;
    const rows = await this.prisma.orderItemDesign.findMany({
      where: {
        order_id: order.id,
        store_id: order.store_id,
        files_purged_at: null,
        proof_key: { not: null },
      },
      select: {
        id: true,
        order_item_id: true,
        store_id: true,
        shipped_at: true,
        terminal_at: true,
        created_at: true,
        back_mode: true,
        proof_back_key: true,
      },
    });
    if (!rows.length) return out;
    const settings = await this.retention.settingsOf(order.store_id);
    const now = Date.now();
    for (const r of rows) {
      const plus = (d: Date | null, days: number) =>
        d ? d.getTime() + days * DAY_MS : null;
      const purgeAt = Math.min(
        ...[
          plus(r.shipped_at, settings.print_keep_days_after_shipped),
          plus(r.terminal_at, DESIGNER_TERMINAL_KEEP_DAYS),
          plus(r.created_at, DESIGNER_HARD_CAP_DAYS),
        ].filter((t): t is number => t !== null),
      );
      const expiresAt = designerMailLinkExpiry(purgeAt, now, {
        minDays: DESIGNER_MAIL_MIN_LINK_DAYS,
      });
      out[r.order_item_id] = this.urls.absolute(
        this.urls.signedPath('oid_proof', r.id, r.store_id, {
          expiresAt,
          now,
        }),
      );
      if (r.back_mode && r.proof_back_key) {
        out[`${r.order_item_id}:back`] = this.urls.absolute(
          this.urls.signedPath('oid_proof_back', r.id, r.store_id, {
            expiresAt,
            now,
          }),
        );
      }
    }
    return out;
  }
}
