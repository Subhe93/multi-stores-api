import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailLogStatus, Prisma, StoreType } from '@prisma/client';
import * as nodemailer from 'nodemailer';
import { PrismaService } from '../../prisma/prisma.service';
import { CryptoService } from '../../common/crypto/crypto.service';
import {
  NotificationTemplatesService,
  substitute,
} from '../notification-templates/notification-templates.service';
import {
  passwordResetEmail,
  orderConfirmationEmail,
  orderShippedEmail,
  orderDeliveredEmail,
  orderCancelledEmail,
  orderRefundedEmail,
  newOrderOwnerEmail,
  welcomeEmail,
  OrderConfirmationData,
  OrderShippedData,
  OrderDeliveredData,
  OrderCancelledData,
  OrderRefundedData,
  NewOrderOwnerData,
  WelcomeData,
} from './templates';
import {
  absoluteUrl,
  emailPhrases,
  formatMoney,
  formatTaxLines,
  formatShippingLine,
  renderOrderItems,
  renderOrderTotals,
  renderShippingAddress,
  formatOrderDate,
  formatPaymentMethod,
  emailSafeLogoPath,
  buildOrderUrl,
  buildStoreUrl,
  loadOrderForEmail,
  OrderForEmail,
} from './order-mail.helpers';

/** Delivery log retention. */
const EMAIL_LOG_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const EMAIL_LOG_PRUNE_EVERY_MS = 24 * 60 * 60 * 1000;

type OrderEmailEvent =
  | 'order_confirmation'
  | 'order_shipped'
  | 'order_delivered'
  | 'order_cancelled'
  | 'order_refunded'
  | 'new_order_owner';

/** Draft (or stored) template to render with sample data. */
interface TemplateSampleInput {
  event: string;
  locale?: string;
  subject?: string;
  body_html?: string;
  body_text?: string;
}

/** What the delivery log records about a message, besides the outcome. */
interface MailMeta {
  to: string;
  subject: string;
  storeId?: string;
  orderId?: string;
  event?: string;
}

interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
  /** Set on the PLATFORM config only — used for fallback-sender branding. */
  platformName?: string;
}

/**
 * Force a display name onto an RFC-5322 from value, keeping the address part.
 * "no-reply@x.com" or "Old Name <no-reply@x.com>" + "Acme" → "Acme" <no-reply@x.com>.
 */
function withDisplayName(from: string, name: string): string {
  const clean = name.replace(/[\r\n"<>\\]/g, '').trim();
  if (!clean) return from;
  const match = from.match(/<([^<>]+)>\s*$/);
  const address = (match ? match[1] : from).trim();
  if (!address) return from;
  return `"${clean}" <${address}>`;
}

/**
 * Localized platform-attribution footer, appended ONLY when a store's email
 * goes out through the PLATFORM sender (store has no SMTP of its own, or its
 * SMTP failed). Soft product marketing, Shopify-style — a store sending under
 * its own SMTP stays fully white-label.
 */
const FOOTER_PHRASES: Record<string, { sentTo: string; powered: string }> = {
  en: {
    sentTo: 'This email was sent to {email} on behalf of {store}.',
    powered: 'Delivered by {platform}',
  },
  ar: {
    sentTo: 'أُرسل هذا البريد إلى {email} بالنيابة عن متجر {store}.',
    powered: 'يُرسل عبر منصة {platform}',
  },
  tr: {
    sentTo: 'Bu e-posta {store} adına {email} adresine gönderildi.',
    powered: '{platform} tarafından iletildi',
  },
  de: {
    sentTo: 'Diese E-Mail wurde im Auftrag von {store} an {email} gesendet.',
    powered: 'Zugestellt über {platform}',
  },
  fr: {
    sentTo: 'Cet e-mail a été envoyé à {email} de la part de {store}.',
    powered: 'Distribué par {platform}',
  },
  sv: {
    sentTo: 'Det här mejlet skickades till {email} på uppdrag av {store}.',
    powered: 'Levereras av {platform}',
  },
};

function escapeHtml(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Token substitution via split/join — String.replace interprets `$&` / `$'`
// patterns in the replacement string, which user-controlled names/emails could
// contain and silently corrupt the output.
function sub(template: string, token: string, value: string): string {
  return template.split(token).join(value);
}

function appendPlatformFooter(
  html: string,
  platformName: string,
  footer: { storeName?: string; customerEmail?: string; locale?: string },
): string {
  const lang = (footer.locale || 'en').slice(0, 2).toLowerCase();
  const phrases = FOOTER_PHRASES[lang] || FOOTER_PHRASES.en;
  const lines: string[] = [];
  if (footer.customerEmail && footer.storeName) {
    lines.push(
      sub(
        sub(phrases.sentTo, '{email}', escapeHtml(footer.customerEmail)),
        '{store}',
        escapeHtml(footer.storeName),
      ),
    );
  }
  lines.push(
    sub(
      phrases.powered,
      '{platform}',
      `<strong>${escapeHtml(platformName)}</strong>`,
    ),
  );
  const block =
    `<div dir="${lang === 'ar' ? 'rtl' : 'ltr'}" style="max-width:560px;margin:16px auto 0;padding:12px 16px 20px;border-top:1px solid #e4e4e7;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.7;color:#a1a1aa;text-align:center;">` +
    lines.map((l) => `<p style="margin:2px 0;">${l}</p>`).join('') +
    `</div>`;
  // Keep the document valid when the template is a full HTML page. A replacer
  // FUNCTION sidesteps `$`-pattern interpretation in the block content.
  const closing = /<\/body>/i;
  if (closing.test(html)) return html.replace(closing, () => `${block}</body>`);
  return html + block;
}

/**
 * Central transactional email service (SMTP via nodemailer). Settings are
 * admin-managed in PlatformConfig (DB) and fall back to the SMTP_ / MAIL_FROM
 * environment variables when unset. The transporter is built lazily and rebuilt
 * only when the settings change. When SMTP is not configured the service
 * degrades gracefully: it logs what it would have sent instead of throwing, so
 * local/dev flows keep working. Sending failures are logged and never thrown
 * (email is best-effort) — except sendTest, which surfaces the error to the admin.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  // One transporter per distinct SMTP config: the platform's, plus one for each
  // independent store sending under its own domain.
  private transporters = new Map<string, nodemailer.Transporter>();

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
    private crypto: CryptoService,
    private templates: NotificationTemplatesService,
  ) {}

  /**
   * A store's own sender, when it has one. Only INDEPENDENT stores may send
   * under their own domain, and the check is re-run here at send time so a
   * store switched back to marketplace immediately reverts to the platform
   * sender without anyone having to clear its settings.
   */
  private async resolveStoreConfig(
    storeId: string,
  ): Promise<SmtpConfig | null> {
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { store_type: true, name: true, mail_settings: true },
    });
    if (!store || store.store_type !== StoreType.INDEPENDENT) return null;

    const s = store.mail_settings;
    if (!s || !s.enabled || !s.smtp_host) return null;

    return {
      host: s.smtp_host,
      port: s.smtp_port ?? 587,
      secure: s.smtp_secure,
      user: s.smtp_user || undefined,
      pass: this.crypto.decrypt(s.smtp_pass) || undefined,
      // Without an explicit from, use the SMTP account itself so the message
      // still has a plausible sender under the creator's own domain.
      from: s.mail_from || s.smtp_user || `${store.name} <no-reply@localhost>`,
    };
  }

  /** Resolve SMTP settings: DB (admin) first, then environment. */
  private async resolveConfig(): Promise<SmtpConfig | null> {
    const cfg = await this.prisma.platformConfig.findFirst({
      select: {
        smtp_host: true,
        smtp_port: true,
        smtp_secure: true,
        smtp_user: true,
        smtp_pass: true,
        mail_from: true,
        platform_name: true,
      },
    });

    // The admin-configurable platform name doubles as the sender display name
    // for every platform-sent email (Admin → Settings → Platform Info).
    const platformName = cfg?.platform_name?.trim() || 'Multi Stores';

    // Pick a single source so host/port/secure/user/pass never mix DB + env:
    // if the admin has saved a host in the DB, the whole SMTP config comes from
    // the DB; otherwise it all comes from the environment.
    const from = withDisplayName(
      cfg?.mail_from ||
        this.config.get<string>('MAIL_FROM') ||
        'no-reply@localhost',
      platformName,
    );

    if (cfg?.smtp_host) {
      return {
        host: cfg.smtp_host,
        port: cfg.smtp_port ?? 587,
        secure: cfg.smtp_secure,
        user: cfg.smtp_user || undefined,
        // Password is encrypted at rest; decrypt before handing it to nodemailer.
        pass: this.crypto.decrypt(cfg.smtp_pass) || undefined,
        from,
        platformName,
      };
    }

    const envHost = this.config.get<string>('SMTP_HOST');
    if (!envHost) return null;
    return {
      host: envHost,
      port: Number(this.config.get<string>('SMTP_PORT') || 587),
      secure: this.config.get<string>('SMTP_SECURE') === 'true',
      user: this.config.get<string>('SMTP_USER') || undefined,
      pass: this.config.get<string>('SMTP_PASS') || undefined,
      from,
      platformName,
    };
  }

  /**
   * Build (or reuse) a transporter for a resolved config. Keyed by the settings
   * themselves rather than kept in a single slot, because stores now send under
   * their own senders and alternating between them would otherwise rebuild the
   * transport on every message.
   */
  private transporterFor(cfg: SmtpConfig): nodemailer.Transporter {
    const signature = JSON.stringify([
      cfg.host,
      cfg.port,
      cfg.secure,
      cfg.user,
      cfg.pass,
    ]);
    const cached = this.transporters.get(signature);
    if (cached) return cached;
    const transporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
    });
    this.transporters.set(signature, transporter);
    return transporter;
  }

  private async getTransporter(): Promise<{
    transporter: nodemailer.Transporter;
    from: string;
  } | null> {
    const cfg = await this.resolveConfig();
    if (!cfg) return null;
    return { transporter: this.transporterFor(cfg), from: cfg.from };
  }

  async isConfigured(): Promise<boolean> {
    return (await this.resolveConfig()) !== null;
  }

  /**
   * Admin-configured platform name — the single source every email inherits
   * its platform branding from, independent of whether SMTP is configured.
   */
  private async platformDisplayName(): Promise<string> {
    const cfg = await this.prisma.platformConfig.findFirst({
      select: { platform_name: true },
    });
    return cfg?.platform_name?.trim() || 'Multi Stores';
  }

  async send(opts: {
    to: string;
    subject: string;
    html: string;
    text?: string;
    /** Send under this store's own sender when it has one configured. */
    storeId?: string;
    /**
     * Store/customer context for the platform-attribution footer. Applied ONLY
     * when the message actually goes out through the platform sender — a store
     * sending under its own SMTP stays fully white-label.
     */
    brandFooter?: {
      storeName?: string;
      customerEmail?: string;
      locale?: string;
    };
    /** Template/event key and order, recorded in the delivery log. */
    event?: string;
    orderId?: string;
  }): Promise<{ sent: boolean }> {
    const storeCfg = opts.storeId
      ? await this.resolveStoreConfig(opts.storeId)
      : null;

    if (storeCfg) {
      const ok = await this.trySend(storeCfg, opts, 'store');
      if (ok) return { sent: true };
      // A store's own sender failing must not cost the customer their email —
      // fall through to the platform sender for this message. The creator sees
      // the real error when they run a test from the dashboard.
      this.logger.warn(
        `Store ${opts.storeId} sender failed for "${opts.subject}" — retrying via the platform sender`,
      );
    }

    const platformCfg = await this.resolveConfig();
    if (!platformCfg) {
      this.logger.warn(
        `[mail:not-configured] Would send "${opts.subject}" to ${opts.to}`,
      );
      await this.logDelivery(opts, {
        status: EmailLogStatus.SKIPPED,
        error: 'Email (SMTP) is not configured',
      });
      return { sent: false };
    }
    const html =
      opts.brandFooter && platformCfg.platformName
        ? appendPlatformFooter(
            opts.html,
            platformCfg.platformName,
            opts.brandFooter,
          )
        : opts.html;
    return {
      sent: await this.trySend(platformCfg, { ...opts, html }, 'platform'),
    };
  }

  private async trySend(
    cfg: SmtpConfig,
    opts: MailMeta & { html: string; text?: string },
    via: 'store' | 'platform',
  ): Promise<boolean> {
    try {
      await this.transporterFor(cfg).sendMail({
        from: cfg.from,
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
        text: opts.text,
      });
      await this.logDelivery(opts, {
        status: EmailLogStatus.SENT,
        via,
        host: cfg.host,
      });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Failed to send "${opts.subject}" to ${opts.to} via ${cfg.host}: ${message}`,
      );
      await this.logDelivery(opts, {
        status: EmailLogStatus.FAILED,
        via,
        host: cfg.host,
        error: message,
      });
      return false;
    }
  }

  // ── Delivery log ───────────────────────────────────────────────────────────

  private lastLogPruneAt = 0;

  /**
   * Record one delivery attempt. Best-effort like the mail itself: a logging
   * failure must never cost anyone their email, so it is swallowed.
   */
  private async logDelivery(
    meta: MailMeta,
    outcome: {
      status: EmailLogStatus;
      via?: 'store' | 'platform';
      host?: string;
      error?: string;
    },
  ): Promise<void> {
    try {
      await this.prisma.emailLog.create({
        data: {
          store_id: meta.storeId ?? null,
          order_id: meta.orderId ?? null,
          event: meta.event ?? null,
          recipient: meta.to,
          subject: meta.subject.slice(0, 300),
          status: outcome.status,
          via: outcome.via ?? null,
          smtp_host: outcome.host ?? null,
          error: outcome.error ? outcome.error.slice(0, 1000) : null,
        },
      });
      const now = Date.now();
      if (now - this.lastLogPruneAt > EMAIL_LOG_PRUNE_EVERY_MS) {
        this.lastLogPruneAt = now;
        await this.prisma.emailLog.deleteMany({
          where: { created_at: { lt: new Date(now - EMAIL_LOG_RETENTION_MS) } },
        });
      }
    } catch (err) {
      this.logger.warn(
        `Could not write the email delivery log: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * One page of the delivery log, newest first. `storeId` pins the listing to
   * one store (the creator endpoint); without it the admin sees everything
   * and may filter by store.
   */
  async listLogs(
    query: {
      page?: string;
      limit?: string;
      status?: string;
      q?: string;
      store_id?: string;
    },
    storeId?: string,
  ) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 25));

    const where: Prisma.EmailLogWhereInput = {};
    if (storeId) where.store_id = storeId;
    else if (query.store_id) where.store_id = query.store_id;
    if (
      query.status === EmailLogStatus.SENT ||
      query.status === EmailLogStatus.FAILED ||
      query.status === EmailLogStatus.SKIPPED
    ) {
      where.status = query.status;
    }
    const q = query.q?.trim();
    if (q) {
      where.OR = [
        { recipient: { contains: q, mode: 'insensitive' } },
        { subject: { contains: q, mode: 'insensitive' } },
      ];
    }

    const [rows, total, failed] = await Promise.all([
      this.prisma.emailLog.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.emailLog.count({ where }),
      this.prisma.emailLog.count({
        where: {
          ...(storeId ? { store_id: storeId } : {}),
          status: { in: [EmailLogStatus.FAILED, EmailLogStatus.SKIPPED] },
          created_at: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
        },
      }),
    ]);

    const storeIds = [
      ...new Set(rows.map((r) => r.store_id).filter((v): v is string => !!v)),
    ];
    const stores = storeIds.length
      ? await this.prisma.store.findMany({
          where: { id: { in: storeIds } },
          select: { id: true, name: true, slug: true },
        })
      : [];
    const storeById = new Map(stores.map((st) => [st.id, st]));

    return {
      items: rows.map((r) => ({
        id: r.id,
        created_at: r.created_at,
        recipient: r.recipient,
        subject: r.subject,
        event: r.event,
        status: r.status,
        via: r.via,
        smtp_host: r.smtp_host,
        error: r.error,
        order_id: r.order_id,
        store: r.store_id ? (storeById.get(r.store_id) ?? null) : null,
      })),
      total,
      page,
      limit,
      // Failed or skipped in the last 7 days, for the page's warning line.
      failed_last_7_days: failed,
    };
  }

  async sendPasswordReset(to: string, resetUrl: string, locale?: string) {
    // Try the admin-managed template first; fall back to the bundled default
    // so a missing/disabled DB template never silently breaks password reset.
    const rendered = await this.templates.render('password_reset', locale, {
      platform_name: await this.platformDisplayName(),
      reset_url: resetUrl,
    });
    if (rendered)
      return this.send({ to, ...rendered, event: 'password_reset' });
    const fallback = passwordResetEmail(resetUrl, {
      platformName: await this.platformDisplayName(),
    });
    return this.send({ to, ...fallback, event: 'password_reset' });
  }

  /**
   * Build the `{{order_button}}` HTML and `{{order_url_text}}` plaintext snippet
   * shared by every order email. Returns empty strings when there's no URL so
   * the template can just include the placeholder unconditionally.
   */
  private orderCta(orderUrl: string | undefined, label: string) {
    if (!orderUrl) return { html: '', text: '' };
    return {
      html: `<p style="margin:20px 0;"><a href="${orderUrl}" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 20px;border-radius:8px;">${label}</a></p>`,
      text: `\n\n${label}: ${orderUrl}`,
    };
  }

  async sendOrderConfirmation(
    to: string,
    data: OrderConfirmationData,
    locale?: string,
  ) {
    const phrases = emailPhrases(locale);
    const paymentLine = data.paid ? phrases.paid : phrases.cod;
    const cta = this.orderCta(data.orderUrl, phrases.viewOrder);

    const rendered = await this.templates.render(
      'order_confirmation',
      locale,
      {
        ...(data.extraVars ?? {}),
        store_name: data.storeName ?? '',
        order_number: data.orderNumber,
        total: data.total,
        shipping_line: data.shippingLine ?? '',
        tax_line: data.taxLine ?? '',
        payment_line: paymentLine,
        order_button: cta.html,
        order_url_text: cta.text,
        items_html: data.itemsHtml ?? '',
        items_text: data.itemsText ?? '',
      },
      data.storeId,
    );
    const brandFooter = {
      storeName: data.storeName,
      customerEmail: to,
      locale,
    };
    if (rendered)
      return this.send({
        to,
        ...rendered,
        storeId: data.storeId,
        brandFooter,
        event: 'order_confirmation',
        orderId: data.orderId,
      });
    return this.send({
      to,
      ...orderConfirmationEmail(data),
      storeId: data.storeId,
      brandFooter,
      event: 'order_confirmation',
      orderId: data.orderId,
    });
  }

  async sendOrderShipped(to: string, data: OrderShippedData, locale?: string) {
    const phrases = emailPhrases(locale);
    const cta = this.orderCta(data.orderUrl, phrases.viewOrder);

    const rendered = await this.templates.render(
      'order_shipped',
      locale,
      {
        ...(data.extraVars ?? {}),
        store_name: data.storeName ?? '',
        order_number: data.orderNumber,
        tracking_number: data.trackingNumber ?? '',
        tracking_url: data.trackingUrl ?? '',
        order_button: cta.html,
        order_url_text: cta.text,
        items_html: data.itemsHtml ?? '',
        items_text: data.itemsText ?? '',
      },
      data.storeId,
    );
    const brandFooter = {
      storeName: data.storeName,
      customerEmail: to,
      locale,
    };
    if (rendered)
      return this.send({
        to,
        ...rendered,
        storeId: data.storeId,
        brandFooter,
        event: 'order_shipped',
        orderId: data.orderId,
      });
    return this.send({
      to,
      ...orderShippedEmail(data),
      storeId: data.storeId,
      brandFooter,
      event: 'order_shipped',
      orderId: data.orderId,
    });
  }

  async sendOrderDelivered(
    to: string,
    data: OrderDeliveredData,
    locale?: string,
  ) {
    const phrases = emailPhrases(locale);
    const cta = this.orderCta(data.orderUrl, phrases.viewOrder);

    const rendered = await this.templates.render(
      'order_delivered',
      locale,
      {
        ...(data.extraVars ?? {}),
        store_name: data.storeName ?? '',
        order_number: data.orderNumber,
        order_button: cta.html,
        order_url_text: cta.text,
        items_html: data.itemsHtml ?? '',
        items_text: data.itemsText ?? '',
      },
      data.storeId,
    );
    const brandFooter = {
      storeName: data.storeName,
      customerEmail: to,
      locale,
    };
    if (rendered)
      return this.send({
        to,
        ...rendered,
        storeId: data.storeId,
        brandFooter,
        event: 'order_delivered',
        orderId: data.orderId,
      });
    return this.send({
      to,
      ...orderDeliveredEmail(data),
      storeId: data.storeId,
      brandFooter,
      event: 'order_delivered',
      orderId: data.orderId,
    });
  }

  async sendOrderCancelled(
    to: string,
    data: OrderCancelledData,
    locale?: string,
  ) {
    const phrases = emailPhrases(locale);
    const cta = this.orderCta(data.orderUrl, phrases.viewOrder);

    const rendered = await this.templates.render(
      'order_cancelled',
      locale,
      {
        ...(data.extraVars ?? {}),
        store_name: data.storeName ?? '',
        order_number: data.orderNumber,
        reason: data.reason ?? '',
        order_button: cta.html,
        order_url_text: cta.text,
        items_html: data.itemsHtml ?? '',
        items_text: data.itemsText ?? '',
      },
      data.storeId,
    );
    const brandFooter = {
      storeName: data.storeName,
      customerEmail: to,
      locale,
    };
    if (rendered)
      return this.send({
        to,
        ...rendered,
        storeId: data.storeId,
        brandFooter,
        event: 'order_cancelled',
        orderId: data.orderId,
      });
    return this.send({
      to,
      ...orderCancelledEmail(data),
      storeId: data.storeId,
      brandFooter,
      event: 'order_cancelled',
      orderId: data.orderId,
    });
  }

  async sendOrderRefunded(
    to: string,
    data: OrderRefundedData,
    locale?: string,
  ) {
    const phrases = emailPhrases(locale);
    const cta = this.orderCta(data.orderUrl, phrases.viewOrder);

    const rendered = await this.templates.render(
      'order_refunded',
      locale,
      {
        ...(data.extraVars ?? {}),
        store_name: data.storeName ?? '',
        order_number: data.orderNumber,
        refund_amount: data.refundAmount ?? '',
        order_button: cta.html,
        order_url_text: cta.text,
        items_html: data.itemsHtml ?? '',
        items_text: data.itemsText ?? '',
      },
      data.storeId,
    );
    const brandFooter = {
      storeName: data.storeName,
      customerEmail: to,
      locale,
    };
    if (rendered)
      return this.send({
        to,
        ...rendered,
        storeId: data.storeId,
        brandFooter,
        event: 'order_refunded',
        orderId: data.orderId,
      });
    return this.send({
      to,
      ...orderRefundedEmail(data),
      storeId: data.storeId,
      brandFooter,
      event: 'order_refunded',
      orderId: data.orderId,
    });
  }

  async sendNewOrderToOwner(
    to: string,
    data: NewOrderOwnerData,
    locale?: string,
  ) {
    const cta = this.orderCta(data.orderAdminUrl, 'Open order');

    const rendered = await this.templates.render(
      'new_order_owner',
      locale,
      {
        ...(data.extraVars ?? {}),
        order_number: data.orderNumber,
        total: data.total,
        shipping_line: data.shippingLine ?? '',
        tax_line: data.taxLine ?? '',
        store_name: data.storeName ?? '',
        customer_name: data.customerName ?? data.extraVars?.customer_name ?? '',
        order_button: cta.html,
        order_url_text: cta.text,
        items_html: data.itemsHtml ?? '',
        items_text: data.itemsText ?? '',
      },
      data.storeId,
    );
    // Owner notification: platform attribution only (no "sent to" line — the
    // recipient is the store owner, not a customer).
    const brandFooter = { locale };
    if (rendered)
      return this.send({
        to,
        ...rendered,
        storeId: data.storeId,
        brandFooter,
        event: 'new_order_owner',
        orderId: data.orderId,
      });
    return this.send({
      to,
      ...newOrderOwnerEmail(data),
      storeId: data.storeId,
      brandFooter,
      event: 'new_order_owner',
      orderId: data.orderId,
    });
  }

  // Signup is a platform event, not a store one — it goes out under the
  // platform sender with the platform template.
  async sendWelcome(to: string, data: WelcomeData, locale?: string) {
    const rendered = await this.templates.render('welcome', locale, {
      platform_name: await this.platformDisplayName(),
      name: data.name ?? '',
      login_url: data.loginUrl ?? '',
    });
    if (rendered) return this.send({ to, ...rendered, event: 'welcome' });
    return this.send({
      to,
      ...welcomeEmail(data, { platformName: await this.platformDisplayName() }),
      event: 'welcome',
    });
  }

  // ── Order-event dispatcher ─────────────────────────────────────────────────
  // Single entry-point used by orders/payments/auth modules. Loads the order
  // with items + store + customer once, renders the items block, and calls the
  // right sendX method. Best-effort: failures are swallowed by the underlying
  // send() so a mail outage never blocks the order flow.

  async dispatchOrderEmail(
    orderId: string,
    event: OrderEmailEvent,
    extra: {
      trackingNumber?: string;
      trackingUrl?: string;
      reason?: string;
      refundAmount?: number;
    } = {},
  ): Promise<void> {
    const order = await loadOrderForEmail(this.prisma, orderId);
    if (!order) return;

    const {
      customerEmail,
      ownerEmail,
      locale,
      currency,
      orderUrl,
      orderAdminUrl,
      items_html,
      items_text,
      orderNumber,
      totalStr,
      shippingLine,
      taxLine,
      taxLines,
      logoUrl,
      extraVars,
    } = await this.orderTemplateContext(order, event);

    const brand = {
      orderId: order.id,
      storeId: order.storeCtx?.id,
      storeName: order.storeCtx?.name,
      storeLogoUrl: logoUrl,
      extraVars,
    };

    // Pick the recipient + payload per event.
    switch (event) {
      case 'order_confirmation': {
        if (!customerEmail) return;
        await this.sendOrderConfirmation(
          customerEmail,
          {
            ...brand,
            orderNumber,
            total: totalStr,
            shippingLine,
            taxLine,
            taxLines,
            paid: order.payment_status === 'paid',
            orderUrl,
            itemsHtml: items_html,
            itemsText: items_text,
          },
          locale,
        );
        return;
      }
      case 'order_shipped': {
        if (!customerEmail) return;
        await this.sendOrderShipped(
          customerEmail,
          {
            ...brand,
            orderNumber,
            trackingNumber: extra.trackingNumber,
            trackingUrl: extra.trackingUrl,
            orderUrl,
            itemsHtml: items_html,
            itemsText: items_text,
          },
          locale,
        );
        return;
      }
      case 'order_delivered': {
        if (!customerEmail) return;
        await this.sendOrderDelivered(
          customerEmail,
          {
            ...brand,
            orderNumber,
            orderUrl,
            itemsHtml: items_html,
            itemsText: items_text,
          },
          locale,
        );
        return;
      }
      case 'order_cancelled': {
        if (!customerEmail) return;
        await this.sendOrderCancelled(
          customerEmail,
          {
            ...brand,
            orderNumber,
            reason: extra.reason,
            orderUrl,
            itemsHtml: items_html,
            itemsText: items_text,
          },
          locale,
        );
        return;
      }
      case 'order_refunded': {
        if (!customerEmail) return;
        await this.sendOrderRefunded(
          customerEmail,
          {
            ...brand,
            orderNumber,
            refundAmount:
              extra.refundAmount !== undefined
                ? formatMoney(extra.refundAmount, currency)
                : undefined,
            orderUrl,
            itemsHtml: items_html,
            itemsText: items_text,
          },
          locale,
        );
        return;
      }
      case 'new_order_owner': {
        if (!ownerEmail) return;
        // Customer name comes from the customer profile (first/last). Best-effort.
        let customerName: string | undefined;
        if (order.customer) {
          const c = await this.prisma.customer.findUnique({
            where: { id: order.customer.id },
            select: { first_name: true, last_name: true },
          });
          const full = [c?.first_name, c?.last_name]
            .filter(Boolean)
            .join(' ')
            .trim();
          customerName = full || undefined;
        }
        await this.sendNewOrderToOwner(
          ownerEmail,
          {
            ...brand,
            orderNumber,
            total: totalStr,
            shippingLine,
            taxLine,
            taxLines,
            storeName: order.storeCtx?.name,
            customerName,
            orderAdminUrl,
            itemsHtml: items_html,
            itemsText: items_text,
          },
          locale,
        );
        return;
      }
    }
  }

  /**
   * Everything an order template can show, computed once from the loaded
   * order: links, the rendered items / totals / address blocks and the shared
   * `extraVars`. Used by the dispatcher and by the template preview.
   */
  private async orderTemplateContext(
    order: OrderForEmail,
    event: OrderEmailEvent,
    localeOverride?: string,
  ) {
    const customerEmail = order.customer?.user?.email;
    const ownerEmail = order.storeCtx?.ownerEmail;
    const locale = localeOverride || order.storeCtx?.primaryLocale;
    const currency = order.currency;

    const storefrontBase =
      this.config.get<string>('STOREFRONT_URL') || 'http://localhost:3003';
    const dashboardBase =
      this.config.get<string>('DASHBOARD_URL') || 'http://localhost:3002';
    const publicBase =
      this.config.get<string>('PUBLIC_API_URL') || 'http://localhost:3001';

    const orderUrl = buildOrderUrl(
      order.storeCtx?.slug,
      order.id,
      storefrontBase,
      order.storeCtx?.customDomain,
    );
    const storeUrl = buildStoreUrl(
      order.storeCtx?.slug,
      storefrontBase,
      order.storeCtx?.customDomain,
    );
    const orderAdminUrl = `${dashboardBase.replace(/\/$/, '')}/creator/orders/${order.id}`;

    const { items_html, items_text } = renderOrderItems(
      order.items as Parameters<typeof renderOrderItems>[0],
      currency,
      locale,
      publicBase,
    );

    const orderNumber = order.order_number;
    const totalStr = formatMoney(Number(order.total), currency);
    // "Shipping (<method>): <amount>" — the method name is the order snapshot.
    const shippingLine = formatShippingLine(
      Number(order.shipping_cost ?? 0),
      order.shipping_method_name,
      currency,
      locale,
    );
    // Itemized under the total, one row per rate; `taxLine` is the joined
    // text for the {{tax_line}} template variable.
    const taxLines = formatTaxLines(order, currency, locale);
    const taxLine = taxLines.join('\n');

    // Identity of the shop the customer actually bought from: it selects the
    // sender and template overrides, and brands the message itself.
    // SVG logos do not render in most mail clients; use a PNG rendition.
    const logoUrl = order.storeCtx?.logoUrl
      ? absoluteUrl(await emailSafeLogoPath(order.storeCtx.logoUrl), publicBase)
      : undefined;

    const { totals_html, totals_text } = renderOrderTotals(
      {
        subtotal: Number(order.subtotal ?? 0),
        discount: Number(order.discount_amount ?? 0),
        shipping: Number(order.shipping_cost ?? 0),
        shippingMethod: order.shipping_method_name,
        total: Number(order.total),
        taxLines,
      },
      currency,
      locale,
    );
    const address = renderShippingAddress(order.address, locale);
    const firstName = order.customer?.first_name?.trim() || '';
    const fullName = [firstName, order.customer?.last_name?.trim()]
      .filter(Boolean)
      .join(' ');
    const discount = Number(order.discount_amount ?? 0);

    // Shared by every order template; the owner notification overrides
    // order_url with the dashboard link.
    const extraVars: Record<string, string> = {
      platform_name: await this.platformDisplayName(),
      store_url: storeUrl,
      store_logo_url: logoUrl ?? '',
      customer_name: fullName,
      customer_first_name: firstName,
      customer_email: customerEmail ?? '',
      order_date: formatOrderDate(order.created_at, locale),
      order_url: event === 'new_order_owner' ? orderAdminUrl : orderUrl,
      payment_method: formatPaymentMethod(order, locale),
      subtotal: formatMoney(Number(order.subtotal ?? 0), currency),
      discount: discount > 0 ? formatMoney(discount, currency) : '',
      shipping_cost: formatMoney(Number(order.shipping_cost ?? 0), currency),
      shipping_method: order.shipping_method_name ?? '',
      tax_line: taxLine,
      total: totalStr,
      totals_html,
      totals_text,
      shipping_address_html: address.html,
      shipping_address_text: address.text,
    };

    return {
      customerEmail,
      ownerEmail,
      locale,
      currency,
      orderUrl,
      orderAdminUrl,
      storeUrl,
      items_html,
      items_text,
      orderNumber,
      totalStr,
      shippingLine,
      taxLine,
      taxLines,
      logoUrl,
      extraVars,
    };
  }

  // ── Template preview + test send ───────────────────────────────────────────

  /**
   * Sample variables for a template: real products, prices and totals from
   * the newest order (the store's own, or any order for a platform template)
   * with a placeholder customer, so no customer data leaves in a test. With
   * no order to borrow from, a small made-up one is used.
   */
  private async sampleTemplateVars(
    event: string,
    locale: string,
    storeId?: string,
  ): Promise<Record<string, string>> {
    const platformName = await this.platformDisplayName();
    const phrases = emailPhrases(locale);
    const storefrontBase =
      this.config.get<string>('STOREFRONT_URL') || 'http://localhost:3003';
    const dashboardBase =
      this.config.get<string>('DASHBOARD_URL') || 'http://localhost:3002';
    const publicBase =
      this.config.get<string>('PUBLIC_API_URL') || 'http://localhost:3001';
    const orderEvent: OrderEmailEvent =
      event === 'new_order_owner' ? 'new_order_owner' : 'order_confirmation';

    const latest = await this.prisma.order.findFirst({
      where: storeId ? { store_id: storeId } : {},
      orderBy: { created_at: 'desc' },
      select: { id: true },
    });
    const order = latest
      ? await loadOrderForEmail(this.prisma, latest.id)
      : null;

    let vars: Record<string, string>;
    if (order) {
      const ctx = await this.orderTemplateContext(order, orderEvent, locale);
      vars = {
        ...ctx.extraVars,
        store_name: order.storeCtx?.name ?? platformName,
        order_number: ctx.orderNumber,
        shipping_line: ctx.shippingLine,
        items_html: ctx.items_html,
        items_text: ctx.items_text,
      };
    } else {
      const store = storeId
        ? await this.prisma.store.findUnique({
            where: { id: storeId },
            select: {
              name: true,
              slug: true,
              custom_domain: true,
              logo_url: true,
              currency: true,
            },
          })
        : null;
      const cfg = await this.prisma.platformConfig.findFirst({
        select: { default_currency: true },
      });
      const currency = store?.currency || cfg?.default_currency || 'EUR';
      const storeUrl = buildStoreUrl(
        store?.slug,
        storefrontBase,
        store?.custom_domain ?? undefined,
      );
      const { items_html, items_text } = renderOrderItems(
        [
          {
            quantity: 2,
            unit_price: 299,
            product: { translations: [{ locale, title: 'Sample product' }] },
          },
        ],
        currency,
        locale,
        publicBase,
      );
      const { totals_html, totals_text } = renderOrderTotals(
        { subtotal: 598, discount: 0, shipping: 49, total: 647, taxLines: [] },
        currency,
        locale,
      );
      vars = {
        platform_name: platformName,
        store_name: store?.name ?? platformName,
        store_url: storeUrl,
        store_logo_url: store?.logo_url
          ? absoluteUrl(await emailSafeLogoPath(store.logo_url), publicBase)
          : '',
        order_number: 'ORD-SAMPLE-0001',
        order_date: formatOrderDate(new Date(), locale),
        order_url:
          event === 'new_order_owner'
            ? `${dashboardBase.replace(/\/$/, '')}/creator/orders`
            : `${storeUrl}/account/orders`,
        payment_method: formatPaymentMethod(
          { payment_method: 'STRIPE' },
          locale,
        ),
        subtotal: formatMoney(598, currency),
        discount: '',
        shipping_cost: formatMoney(49, currency),
        shipping_method: '',
        shipping_line: `${phrases.shipping}: ${formatMoney(49, currency)}`,
        tax_line: '',
        total: formatMoney(647, currency),
        totals_html,
        totals_text,
        items_html,
        items_text,
      };
    }

    const cta = this.orderCta(
      vars.order_url,
      event === 'new_order_owner' ? 'Open order' : phrases.viewOrder,
    );
    return {
      ...vars,
      // Placeholder customer: a test must never carry a real customer's data.
      customer_name: 'Anna Lindqvist',
      customer_first_name: 'Anna',
      customer_email: 'anna@example.com',
      shipping_address_html:
        'Anna Lindqvist<br />Storgatan 12<br />111 23 Stockholm',
      shipping_address_text: 'Anna Lindqvist\nStorgatan 12\n111 23 Stockholm',
      payment_line: phrases.paid,
      order_button: cta.html,
      order_url_text: cta.text,
      tracking_number: 'SE123456789',
      tracking_url: 'https://example.com/track/SE123456789',
      reason: 'Sample reason',
      refund_amount: vars.total,
      name: 'Anna',
      login_url: `${dashboardBase.replace(/\/$/, '')}/login`,
      reset_url: `${storefrontBase.replace(/\/$/, '')}/reset-password?token=sample`,
    };
  }

  /**
   * Render a template with sample data. The editor's unsaved draft wins over
   * what is stored, so the preview shows what a save would send.
   */
  async renderTemplateSample(
    input: TemplateSampleInput,
    storeId?: string,
  ): Promise<{ subject: string; html: string; text: string; locale: string }> {
    const known = NotificationTemplatesService.EVENT_CATALOG.some(
      (e) => e.event === input.event,
    );
    if (!known) throw new BadRequestException('Unknown event');

    let locale = input.locale;
    if (!locale && storeId) {
      const cfg = await this.prisma.storeLanguageConfig.findUnique({
        where: { store_id: storeId },
        select: { primary_locale: true },
      });
      locale = cfg?.primary_locale;
    }
    locale = locale || 'en';

    const vars = await this.sampleTemplateVars(input.event, locale, storeId);
    const hasDraft =
      input.subject !== undefined ||
      input.body_html !== undefined ||
      input.body_text !== undefined;
    const rendered = hasDraft
      ? {
          subject: substitute(input.subject ?? '', vars),
          html: substitute(input.body_html ?? '', vars),
          text: substitute(input.body_text ?? '', vars),
        }
      : await this.templates.render(input.event, locale, vars, storeId);

    if (!rendered || !rendered.html.trim()) {
      throw new BadRequestException({
        code: 'TEMPLATE_EMPTY',
        message: 'This template has no content in the selected language yet.',
      });
    }
    return { ...rendered, locale };
  }

  async sendTemplateTest(
    input: TemplateSampleInput,
    to: string,
    storeId?: string,
  ): Promise<{ sent: true; to: string }> {
    const rendered = await this.renderTemplateSample(input, storeId);
    if (!rendered.subject.trim()) {
      throw new BadRequestException({
        code: 'TEMPLATE_NO_SUBJECT',
        message: 'Enter a subject before sending a test.',
      });
    }
    const store = storeId
      ? await this.prisma.store.findUnique({
          where: { id: storeId },
          select: { name: true },
        })
      : null;
    const { sent } = await this.send({
      to,
      subject: `[Test] ${rendered.subject}`,
      html: rendered.html,
      text: rendered.text || undefined,
      storeId,
      event: 'test',
      // Same footer a real message gets when it leaves via the platform.
      brandFooter: storeId
        ? { storeName: store?.name, customerEmail: to, locale: rendered.locale }
        : undefined,
    });
    if (!sent) {
      throw new BadRequestException({
        code: 'TEMPLATE_TEST_FAILED',
        message:
          'The test email could not be sent. Open the email log to see the reason.',
      });
    }
    return { sent: true, to };
  }

  async renderStoreTemplateSample(userId: string, input: TemplateSampleInput) {
    const store = await this.requireIndependentStore(userId);
    return this.renderTemplateSample(input, store.id);
  }

  /**
   * A creator's test goes where their order notifications go: the store's
   * notification email, or the login email when none is set. Never to an
   * address from the request, since the content is free HTML.
   */
  async sendStoreTemplateTest(userId: string, input: TemplateSampleInput) {
    const store = await this.requireIndependentStore(userId);
    const own = await this.requireOwnStore(userId);
    const to = own.notification_email || own.loginEmail;
    return this.sendTemplateTest(input, to, store.id);
  }

  // ── Admin settings (ADMIN only; never returns the password) ─────────────────

  async getAdminSettings() {
    const cfg = await this.prisma.platformConfig.findFirst({
      select: {
        smtp_host: true,
        smtp_port: true,
        smtp_secure: true,
        smtp_user: true,
        smtp_pass: true,
        mail_from: true,
      },
    });
    const envHost = Boolean(this.config.get<string>('SMTP_HOST'));
    return {
      host: cfg?.smtp_host || null,
      port: cfg?.smtp_port ?? null,
      secure: cfg?.smtp_secure ?? false,
      user: cfg?.smtp_user || null,
      from: cfg?.mail_from || null,
      passwordSet: Boolean(cfg?.smtp_pass),
      configured: await this.isConfigured(),
      usingEnvFallback: !cfg?.smtp_host && envHost,
    };
  }

  async updateAdminSettings(dto: {
    host?: string;
    port?: number | null;
    secure?: boolean;
    user?: string;
    password?: string;
    from?: string;
  }) {
    let config = await this.prisma.platformConfig.findFirst();
    if (!config) config = await this.prisma.platformConfig.create({ data: {} });

    const data: {
      smtp_host?: string | null;
      smtp_port?: number | null;
      smtp_secure?: boolean;
      smtp_user?: string | null;
      smtp_pass?: string | null;
      mail_from?: string | null;
    } = {};
    if (dto.host !== undefined) data.smtp_host = dto.host.trim() || null;
    if (dto.port !== undefined) data.smtp_port = dto.port ?? null;
    if (dto.secure !== undefined) data.smtp_secure = dto.secure;
    if (dto.user !== undefined) data.smtp_user = dto.user.trim() || null;
    // Only overwrite the password when a non-empty value is provided. Encrypt
    // it at rest so the DB never holds the plaintext SMTP password.
    if (dto.password) data.smtp_pass = this.crypto.encrypt(dto.password);
    if (dto.from !== undefined) data.mail_from = dto.from.trim() || null;

    await this.prisma.platformConfig.update({
      where: { id: config.id },
      data,
    });
    // Drop the cached transporters so the next send picks up the change.
    this.transporters.clear();
    return this.getAdminSettings();
  }

  /** Send a test email; surfaces the real SMTP error so the admin can fix it. */
  async sendTest(to: string): Promise<{ sent: true }> {
    const resolved = await this.getTransporter();
    if (!resolved) {
      throw new BadRequestException('Email is not configured');
    }
    const platform = await this.platformDisplayName();
    try {
      await resolved.transporter.sendMail({
        from: resolved.from,
        to,
        subject: `${platform} — test email`,
        html: `<p>This is a test email from your ${escapeHtml(platform)} admin settings. SMTP is working. ✅</p>`,
        text: `This is a test email from your ${platform} admin settings. SMTP is working.`,
      });
      await this.logDelivery(
        { to, subject: `${platform} — test email`, event: 'test' },
        { status: EmailLogStatus.SENT, via: 'platform' },
      );
      return { sent: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Test email to ${to} failed: ${message}`);
      await this.logDelivery(
        { to, subject: `${platform} — test email`, event: 'test' },
        { status: EmailLogStatus.FAILED, via: 'platform', error: message },
      );
      throw new BadRequestException(`SMTP error: ${message}`);
    }
  }

  // ── Store sender (CREATOR, independent stores only) ────────────────────────

  /**
   * Resolve the caller's own store and confirm it may have its own sender.
   * Marketplace stores send through the platform, so they are refused here
   * rather than being allowed to save settings that would never be used.
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
        code: 'STORE_MAIL_NO_STORE',
        message: 'You need a store before you can configure email.',
      });
    }
    if (store.store_type !== StoreType.INDEPENDENT) {
      throw new BadRequestException({
        code: 'STORE_MAIL_MARKETPLACE_ONLY',
        message:
          'Only independent stores can send from their own address. Marketplace stores use the platform sender.',
      });
    }
    return store;
  }

  async getStoreSettings(userId: string) {
    const store = await this.requireIndependentStore(userId);
    const s = await this.prisma.storeMailSettings.findUnique({
      where: { store_id: store.id },
    });
    return {
      host: s?.smtp_host || null,
      port: s?.smtp_port ?? null,
      secure: s?.smtp_secure ?? false,
      user: s?.smtp_user || null,
      from: s?.mail_from || null,
      enabled: s?.enabled ?? false,
      // Never return the password itself — only whether one is stored.
      passwordSet: Boolean(s?.smtp_pass),
      verifiedAt: s?.verified_at ?? null,
    };
  }

  async updateStoreSettings(
    userId: string,
    dto: {
      host?: string;
      port?: number | null;
      secure?: boolean;
      user?: string;
      password?: string;
      from?: string;
      enabled?: boolean;
    },
  ) {
    const store = await this.requireIndependentStore(userId);

    const data: Record<string, unknown> = {};
    if (dto.host !== undefined) data.smtp_host = dto.host.trim() || null;
    if (dto.port !== undefined) data.smtp_port = dto.port ?? null;
    if (dto.secure !== undefined) data.smtp_secure = dto.secure;
    if (dto.user !== undefined) data.smtp_user = dto.user.trim() || null;
    if (dto.from !== undefined) data.mail_from = dto.from.trim() || null;
    if (dto.enabled !== undefined) data.enabled = dto.enabled;
    // Same rule as the platform settings: an empty password means "keep the
    // stored one", so the dashboard never has to round-trip the secret.
    if (dto.password) {
      data.smtp_pass = this.crypto.encrypt(dto.password);
      // Credentials changed — the previous successful test no longer proves
      // anything about the current config.
      data.verified_at = null;
    }

    await this.prisma.storeMailSettings.upsert({
      where: { store_id: store.id },
      create: { store_id: store.id, ...data },
      update: data,
    });

    this.transporters.clear();
    return this.getStoreSettings(userId);
  }

  /**
   * Send a test through the store's own sender. This is the only place the
   * creator sees the real SMTP error — order mail silently falls back to the
   * platform sender rather than failing, so without this a broken config
   * would go unnoticed.
   */
  async sendStoreTest(userId: string, to: string): Promise<{ sent: true }> {
    const store = await this.requireIndependentStore(userId);
    const cfg = await this.resolveStoreConfig(store.id);
    if (!cfg) {
      throw new BadRequestException({
        code: 'STORE_MAIL_NOT_CONFIGURED',
        message: 'Enter your SMTP details and enable the sender first.',
      });
    }
    try {
      await this.transporterFor(cfg).sendMail({
        from: cfg.from,
        to,
        subject: 'Test email from your store',
        html: "<p>Your store's email sender is working. ✅</p>",
        text: "Your store's email sender is working.",
      });
      await this.prisma.storeMailSettings.update({
        where: { store_id: store.id },
        data: { verified_at: new Date() },
      });
      await this.logDelivery(
        {
          to,
          subject: 'Test email from your store',
          event: 'test',
          storeId: store.id,
        },
        { status: EmailLogStatus.SENT, via: 'store', host: cfg.host },
      );
      return { sent: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Store ${store.id} test email to ${to} failed: ${message}`,
      );
      await this.logDelivery(
        {
          to,
          subject: 'Test email from your store',
          event: 'test',
          storeId: store.id,
        },
        {
          status: EmailLogStatus.FAILED,
          via: 'store',
          host: cfg.host,
          error: message,
        },
      );
      throw new BadRequestException(`SMTP error: ${message}`);
    }
  }

  // ── Store notifications + log (CREATOR, every store type) ──────────────────

  /** The caller's own store; no store id is ever accepted from the client. */
  private async requireOwnStore(userId: string) {
    const creator = await this.prisma.creator.findUnique({
      where: { user_id: userId },
      select: { id: true, user: { select: { email: true } } },
    });
    const store = creator
      ? await this.prisma.store.findUnique({
          where: { creator_id: creator.id },
          select: { id: true, notification_email: true },
        })
      : null;
    if (!creator || !store) {
      throw new BadRequestException({
        code: 'STORE_MAIL_NO_STORE',
        message: 'You need a store before you can configure email.',
      });
    }
    return { ...store, loginEmail: creator.user.email };
  }

  async listStoreLogs(
    userId: string,
    query: { page?: string; limit?: string; status?: string; q?: string },
  ) {
    const store = await this.requireOwnStore(userId);
    return this.listLogs(query, store.id);
  }

  async getStoreNotifications(userId: string) {
    const store = await this.requireOwnStore(userId);
    return {
      notification_email: store.notification_email || null,
      login_email: store.loginEmail,
      // The address order notifications actually go to right now.
      effective_email: store.notification_email || store.loginEmail,
    };
  }

  async updateStoreNotifications(
    userId: string,
    dto: { notification_email?: string },
  ) {
    const store = await this.requireOwnStore(userId);
    if (dto.notification_email !== undefined) {
      await this.prisma.store.update({
        where: { id: store.id },
        data: {
          notification_email:
            dto.notification_email.trim().toLowerCase() || null,
        },
      });
    }
    return this.getStoreNotifications(userId);
  }
}
