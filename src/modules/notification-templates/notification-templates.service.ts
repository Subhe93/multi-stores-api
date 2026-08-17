import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateNotificationTemplateDto } from './dto/notification-template.dto';

type Localized = Record<string, string>;

/** `{{var}}` placeholder substitution. Missing vars resolve to ''. */
function substitute(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => vars[key] ?? '');
}

/**
 * Admin-managed transactional notification templates. One row per event
 * (order_confirmation, password_reset, …). The MailService calls `render()` to
 * compose the actual email; the admin controller exposes CRUD for the editor.
 */
@Injectable()
export class NotificationTemplatesService {
  constructor(private prisma: PrismaService) {}

  private pickLocale(json: unknown, locale?: string): string {
    const obj = (json || {}) as Localized;
    if (locale && obj[locale]) return obj[locale];
    if (obj.en) return obj.en;
    const first = Object.values(obj)[0];
    return typeof first === 'string' ? first : '';
  }

  /**
   * Render an event into { subject, html, text } for the requested locale.
   * Returns null when no template applies — callers fall back to the bundled
   * default rather than skipping the email.
   *
   * An independent store may override any event with its own template; that
   * override wins over the platform's. The store's type is checked here so a
   * store switched back to marketplace stops using its overrides at once,
   * without anyone having to delete them.
   */
  async render(
    event: string,
    locale: string | undefined,
    vars: Record<string, string>,
    storeId?: string,
  ): Promise<{ subject: string; html: string; text: string } | null> {
    if (storeId) {
      const store = await this.prisma.store.findUnique({
        where: { id: storeId },
        select: { store_type: true },
      });
      if (store?.store_type === 'INDEPENDENT') {
        const own = await this.prisma.storeNotificationTemplate.findUnique({
          where: { store_id_event: { store_id: storeId, event } },
        });
        if (own?.enabled) return this.compose(own, locale, vars);
      }
    }

    const tpl = await this.prisma.notificationTemplate.findUnique({
      where: { event },
    });
    if (!tpl || !tpl.enabled) return null;
    return this.compose(tpl, locale, vars);
  }

  private compose(
    tpl: { subject: unknown; body_html: unknown; body_text: unknown },
    locale: string | undefined,
    vars: Record<string, string>,
  ) {
    return {
      subject: substitute(this.pickLocale(tpl.subject, locale), vars),
      html: substitute(this.pickLocale(tpl.body_html, locale), vars),
      text: substitute(this.pickLocale(tpl.body_text, locale), vars),
    };
  }

  // ── Admin ────────────────────────────────────────────────────────────────

  /**
   * Catalog of supported events with the placeholder variables each one
   * receives at send time. The dashboard reads this so adding a new event
   * doesn't require shipping a UI change.
   */
  static readonly EVENT_CATALOG: Array<{ event: string; variables: string[] }> = [
    {
      event: 'order_confirmation',
      variables: [
        'order_number',
        'total',
        'payment_line',
        'order_button',
        'order_url_text',
        'items_html',
        'items_text',
      ],
    },
    {
      event: 'order_shipped',
      variables: [
        'order_number',
        'tracking_number',
        'tracking_url',
        'order_button',
        'order_url_text',
        'items_html',
        'items_text',
      ],
    },
    {
      event: 'order_delivered',
      variables: [
        'order_number',
        'order_button',
        'order_url_text',
        'items_html',
        'items_text',
      ],
    },
    {
      event: 'order_cancelled',
      variables: [
        'order_number',
        'reason',
        'order_button',
        'order_url_text',
        'items_html',
        'items_text',
      ],
    },
    {
      event: 'order_refunded',
      variables: [
        'order_number',
        'refund_amount',
        'order_button',
        'order_url_text',
        'items_html',
        'items_text',
      ],
    },
    {
      event: 'new_order_owner',
      variables: [
        'order_number',
        'total',
        'store_name',
        'customer_name',
        'order_button',
        'order_url_text',
        'items_html',
        'items_text',
      ],
    },
    {
      event: 'welcome',
      variables: ['name', 'login_url'],
    },
    {
      event: 'password_reset',
      variables: ['reset_url'],
    },
  ];

  events() {
    return NotificationTemplatesService.EVENT_CATALOG;
  }

  /**
   * Catalog-driven list: every event in EVENT_CATALOG appears in the response,
   * even if no DB row exists yet. Events without a row show up as disabled
   * placeholders so the admin can open them and start editing — the editor's
   * update path upserts on save. Order matches the catalog for stable UI.
   */
  async list() {
    const rows = await this.prisma.notificationTemplate.findMany();
    const byEvent = new Map(rows.map((r) => [r.event, r]));
    return NotificationTemplatesService.EVENT_CATALOG.map(({ event }) => {
      const row = byEvent.get(event);
      if (row) return row;
      return {
        id: '',
        event,
        subject: {},
        body_html: {},
        body_text: {},
        enabled: false,
        created_at: new Date(0),
        updated_at: new Date(0),
      };
    });
  }

  /**
   * Returns the existing row OR a transient placeholder when the event is in
   * the catalog but hasn't been created yet. The editor opens placeholders so
   * the admin can start composing; the first save creates the real row.
   */
  async getByEvent(event: string) {
    const t = await this.prisma.notificationTemplate.findUnique({
      where: { event },
    });
    if (t) return t;
    const known = NotificationTemplatesService.EVENT_CATALOG.some((e) => e.event === event);
    if (!known) throw new NotFoundException('Template not found');
    return {
      id: '',
      event,
      subject: {},
      body_html: {},
      body_text: {},
      enabled: false,
      created_at: new Date(0),
      updated_at: new Date(0),
    };
  }

  /**
   * Upsert: the first save for an event creates the row, subsequent saves
   * merge per-locale fields into the stored JSON.
   */
  async update(event: string, dto: UpdateNotificationTemplateDto) {
    const known = NotificationTemplatesService.EVENT_CATALOG.some((e) => e.event === event);
    if (!known) throw new NotFoundException('Unknown event');

    const existing = await this.prisma.notificationTemplate.findUnique({
      where: { event },
    });

    const mergedSubject = {
      ...((existing?.subject as Localized) || {}),
      ...(dto.subject || {}),
    };
    const mergedHtml = {
      ...((existing?.body_html as Localized) || {}),
      ...(dto.body_html || {}),
    };
    const mergedText = {
      ...((existing?.body_text as Localized) || {}),
      ...(dto.body_text || {}),
    };
    const enabled = dto.enabled !== undefined ? dto.enabled : existing?.enabled ?? true;

    return this.prisma.notificationTemplate.upsert({
      where: { event },
      create: {
        event,
        subject: mergedSubject,
        body_html: mergedHtml,
        body_text: mergedText,
        enabled,
      },
      update: {
        subject: mergedSubject,
        body_html: mergedHtml,
        body_text: mergedText,
        enabled,
      },
    });
  }

  // ── Store overrides (CREATOR, independent stores only) ─────────────────────

  /**
   * Resolve the caller's own store. Only independent stores may override
   * templates — a marketplace store's customers get the platform's, so saving
   * overrides there would be writing rows that never render.
   */
  private async requireIndependentStore(userId: string) {
    const creator = await this.prisma.creator.findUnique({
      where: { user_id: userId },
      select: { id: true },
    });
    const store = creator
      ? await this.prisma.store.findUnique({
          where: { creator_id: creator.id },
          select: { id: true, store_type: true },
        })
      : null;
    if (!store) {
      throw new BadRequestException({
        code: 'STORE_TEMPLATE_NO_STORE',
        message: 'You need a store before you can customise emails.',
      });
    }
    if (store.store_type !== 'INDEPENDENT') {
      throw new BadRequestException({
        code: 'STORE_TEMPLATE_MARKETPLACE_ONLY',
        message:
          'Only independent stores can customise their emails. Marketplace stores use the platform templates.',
      });
    }
    return store;
  }

  /**
   * One entry per catalog event, flagged with whether this store overrides it.
   * `overridden: false` means the customer receives the platform template.
   */
  async listForStore(userId: string) {
    const store = await this.requireIndependentStore(userId);
    const [own, platform] = await Promise.all([
      this.prisma.storeNotificationTemplate.findMany({ where: { store_id: store.id } }),
      this.prisma.notificationTemplate.findMany(),
    ]);
    const byEvent = new Map(own.map((r) => [r.event, r]));
    const platformByEvent = new Map(platform.map((r) => [r.event, r]));

    return NotificationTemplatesService.EVENT_CATALOG.map(({ event }) => {
      const row = byEvent.get(event);
      return {
        event,
        overridden: Boolean(row),
        enabled: row?.enabled ?? false,
        updated_at: row?.updated_at ?? null,
        platformAvailable: Boolean(platformByEvent.get(event)?.enabled),
      };
    });
  }

  /**
   * The store's override if it has one, otherwise the platform template as a
   * starting point — so opening an un-overridden event shows what customers
   * actually receive today rather than a blank editor.
   */
  async getForStore(userId: string, event: string) {
    const store = await this.requireIndependentStore(userId);
    const known = NotificationTemplatesService.EVENT_CATALOG.some((e) => e.event === event);
    if (!known) throw new NotFoundException('Unknown event');

    const own = await this.prisma.storeNotificationTemplate.findUnique({
      where: { store_id_event: { store_id: store.id, event } },
    });
    if (own) return { ...own, overridden: true };

    const platform = await this.prisma.notificationTemplate.findUnique({
      where: { event },
    });
    return {
      id: '',
      event,
      subject: platform?.subject ?? {},
      body_html: platform?.body_html ?? {},
      body_text: platform?.body_text ?? {},
      enabled: false,
      updated_at: null,
      overridden: false,
    };
  }

  async updateForStore(
    userId: string,
    event: string,
    dto: UpdateNotificationTemplateDto,
  ) {
    const store = await this.requireIndependentStore(userId);
    const known = NotificationTemplatesService.EVENT_CATALOG.some((e) => e.event === event);
    if (!known) throw new NotFoundException('Unknown event');

    const existing = await this.prisma.storeNotificationTemplate.findUnique({
      where: { store_id_event: { store_id: store.id, event } },
    });

    // Merge per locale so editing one language never drops the others.
    const mergedSubject = {
      ...((existing?.subject as Localized) || {}),
      ...(dto.subject || {}),
    };
    const mergedHtml = {
      ...((existing?.body_html as Localized) || {}),
      ...(dto.body_html || {}),
    };
    const mergedText = {
      ...((existing?.body_text as Localized) || {}),
      ...(dto.body_text || {}),
    };
    const enabled = dto.enabled !== undefined ? dto.enabled : existing?.enabled ?? true;

    return this.prisma.storeNotificationTemplate.upsert({
      where: { store_id_event: { store_id: store.id, event } },
      create: {
        store_id: store.id,
        event,
        subject: mergedSubject,
        body_html: mergedHtml,
        body_text: mergedText,
        enabled,
      },
      update: {
        subject: mergedSubject,
        body_html: mergedHtml,
        body_text: mergedText,
        enabled,
      },
    });
  }

  /** Drop the override so this event falls back to the platform template. */
  async resetForStore(userId: string, event: string) {
    const store = await this.requireIndependentStore(userId);
    await this.prisma.storeNotificationTemplate.deleteMany({
      where: { store_id: store.id, event },
    });
    return { reset: true };
  }
}
