import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StoreType } from '@prisma/client';
import * as nodemailer from 'nodemailer';
import { PrismaService } from '../../prisma/prisma.service';
import { CryptoService } from '../../common/crypto/crypto.service';
import { NotificationTemplatesService } from '../notification-templates/notification-templates.service';
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
  renderOrderItems,
  buildOrderUrl,
  loadOrderForEmail,
} from './order-mail.helpers';

interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
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
  private async resolveStoreConfig(storeId: string): Promise<SmtpConfig | null> {
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
      },
    });

    // Pick a single source so host/port/secure/user/pass never mix DB + env:
    // if the admin has saved a host in the DB, the whole SMTP config comes from
    // the DB; otherwise it all comes from the environment.
    const from =
      cfg?.mail_from ||
      this.config.get<string>('MAIL_FROM') ||
      'Multi Stores <no-reply@localhost>';

    if (cfg?.smtp_host) {
      return {
        host: cfg.smtp_host,
        port: cfg.smtp_port ?? 587,
        secure: cfg.smtp_secure,
        user: cfg.smtp_user || undefined,
        // Password is encrypted at rest; decrypt before handing it to nodemailer.
        pass: this.crypto.decrypt(cfg.smtp_pass) || undefined,
        from,
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
    };
  }

  /**
   * Build (or reuse) a transporter for a resolved config. Keyed by the settings
   * themselves rather than kept in a single slot, because stores now send under
   * their own senders and alternating between them would otherwise rebuild the
   * transport on every message.
   */
  private transporterFor(cfg: SmtpConfig): nodemailer.Transporter {
    const signature = JSON.stringify([cfg.host, cfg.port, cfg.secure, cfg.user, cfg.pass]);
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

  async send(opts: {
    to: string;
    subject: string;
    html: string;
    text?: string;
    /** Send under this store's own sender when it has one configured. */
    storeId?: string;
  }): Promise<{ sent: boolean }> {
    const storeCfg = opts.storeId ? await this.resolveStoreConfig(opts.storeId) : null;

    if (storeCfg) {
      const ok = await this.trySend(storeCfg, opts);
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
      return { sent: false };
    }
    return { sent: await this.trySend(platformCfg, opts) };
  }

  private async trySend(
    cfg: SmtpConfig,
    opts: { to: string; subject: string; html: string; text?: string },
  ): Promise<boolean> {
    try {
      await this.transporterFor(cfg).sendMail({
        from: cfg.from,
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
        text: opts.text,
      });
      return true;
    } catch (err) {
      this.logger.error(
        `Failed to send "${opts.subject}" to ${opts.to} via ${cfg.host}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }
  }

  async sendPasswordReset(to: string, resetUrl: string, locale?: string) {
    // Try the admin-managed template first; fall back to the bundled default
    // so a missing/disabled DB template never silently breaks password reset.
    const rendered = await this.templates.render('password_reset', locale, {
      reset_url: resetUrl,
    });
    if (rendered) return this.send({ to, ...rendered });
    const fallback = passwordResetEmail(resetUrl);
    return this.send({ to, ...fallback });
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

    const rendered = await this.templates.render('order_confirmation', locale, {
      store_name: data.storeName ?? '',
      order_number: data.orderNumber,
      total: data.total,
      payment_line: paymentLine,
      order_button: cta.html,
      order_url_text: cta.text,
      items_html: data.itemsHtml ?? '',
      items_text: data.itemsText ?? '',
    }, data.storeId);
    if (rendered) return this.send({ to, ...rendered, storeId: data.storeId });
    return this.send({ to, ...orderConfirmationEmail(data), storeId: data.storeId });
  }

  async sendOrderShipped(to: string, data: OrderShippedData, locale?: string) {
    const phrases = emailPhrases(locale);
    const cta = this.orderCta(data.orderUrl, phrases.viewOrder);

    const rendered = await this.templates.render('order_shipped', locale, {
      store_name: data.storeName ?? '',
      order_number: data.orderNumber,
      tracking_number: data.trackingNumber ?? '',
      tracking_url: data.trackingUrl ?? '',
      order_button: cta.html,
      order_url_text: cta.text,
      items_html: data.itemsHtml ?? '',
      items_text: data.itemsText ?? '',
    }, data.storeId);
    if (rendered) return this.send({ to, ...rendered, storeId: data.storeId });
    return this.send({ to, ...orderShippedEmail(data), storeId: data.storeId });
  }

  async sendOrderDelivered(to: string, data: OrderDeliveredData, locale?: string) {
    const phrases = emailPhrases(locale);
    const cta = this.orderCta(data.orderUrl, phrases.viewOrder);

    const rendered = await this.templates.render('order_delivered', locale, {
      store_name: data.storeName ?? '',
      order_number: data.orderNumber,
      order_button: cta.html,
      order_url_text: cta.text,
      items_html: data.itemsHtml ?? '',
      items_text: data.itemsText ?? '',
    }, data.storeId);
    if (rendered) return this.send({ to, ...rendered, storeId: data.storeId });
    return this.send({ to, ...orderDeliveredEmail(data), storeId: data.storeId });
  }

  async sendOrderCancelled(to: string, data: OrderCancelledData, locale?: string) {
    const phrases = emailPhrases(locale);
    const cta = this.orderCta(data.orderUrl, phrases.viewOrder);

    const rendered = await this.templates.render('order_cancelled', locale, {
      store_name: data.storeName ?? '',
      order_number: data.orderNumber,
      reason: data.reason ?? '',
      order_button: cta.html,
      order_url_text: cta.text,
      items_html: data.itemsHtml ?? '',
      items_text: data.itemsText ?? '',
    }, data.storeId);
    if (rendered) return this.send({ to, ...rendered, storeId: data.storeId });
    return this.send({ to, ...orderCancelledEmail(data), storeId: data.storeId });
  }

  async sendOrderRefunded(to: string, data: OrderRefundedData, locale?: string) {
    const phrases = emailPhrases(locale);
    const cta = this.orderCta(data.orderUrl, phrases.viewOrder);

    const rendered = await this.templates.render('order_refunded', locale, {
      store_name: data.storeName ?? '',
      order_number: data.orderNumber,
      refund_amount: data.refundAmount ?? '',
      order_button: cta.html,
      order_url_text: cta.text,
      items_html: data.itemsHtml ?? '',
      items_text: data.itemsText ?? '',
    }, data.storeId);
    if (rendered) return this.send({ to, ...rendered, storeId: data.storeId });
    return this.send({ to, ...orderRefundedEmail(data), storeId: data.storeId });
  }

  async sendNewOrderToOwner(to: string, data: NewOrderOwnerData, locale?: string) {
    const cta = this.orderCta(data.orderAdminUrl, 'Open order');

    const rendered = await this.templates.render('new_order_owner', locale, {
      order_number: data.orderNumber,
      total: data.total,
      store_name: data.storeName ?? '',
      customer_name: data.customerName ?? '',
      order_button: cta.html,
      order_url_text: cta.text,
      items_html: data.itemsHtml ?? '',
      items_text: data.itemsText ?? '',
    }, data.storeId);
    if (rendered) return this.send({ to, ...rendered, storeId: data.storeId });
    return this.send({ to, ...newOrderOwnerEmail(data), storeId: data.storeId });
  }

  // Signup is a platform event, not a store one — it goes out under the
  // platform sender with the platform template.
  async sendWelcome(to: string, data: WelcomeData, locale?: string) {
    const rendered = await this.templates.render('welcome', locale, {
      name: data.name ?? '',
      login_url: data.loginUrl ?? '',
    });
    if (rendered) return this.send({ to, ...rendered });
    return this.send({ to, ...welcomeEmail(data) });
  }

  // ── Order-event dispatcher ─────────────────────────────────────────────────
  // Single entry-point used by orders/payments/auth modules. Loads the order
  // with items + store + customer once, renders the items block, and calls the
  // right sendX method. Best-effort: failures are swallowed by the underlying
  // send() so a mail outage never blocks the order flow.

  async dispatchOrderEmail(
    orderId: string,
    event:
      | 'order_confirmation'
      | 'order_shipped'
      | 'order_delivered'
      | 'order_cancelled'
      | 'order_refunded'
      | 'new_order_owner',
    extra: {
      trackingNumber?: string;
      trackingUrl?: string;
      reason?: string;
      refundAmount?: number;
    } = {},
  ): Promise<void> {
    const order = await loadOrderForEmail(this.prisma, orderId);
    if (!order) return;

    const customerEmail = order.customer?.user?.email;
    const ownerEmail = order.storeCtx?.ownerEmail;
    const locale = order.storeCtx?.primaryLocale;
    const currency = order.currency;

    const storefrontBase =
      this.config.get<string>('STOREFRONT_URL') || 'http://localhost:3003';
    const dashboardBase =
      this.config.get<string>('DASHBOARD_URL') || 'http://localhost:3002';
    const publicBase =
      this.config.get<string>('PUBLIC_API_URL') || 'http://localhost:3001';

    const orderUrl = buildOrderUrl(order.storeCtx?.slug, order.id, storefrontBase);
    const orderAdminUrl = `${dashboardBase.replace(/\/$/, '')}/creator/orders/${order.id}`;

    const { items_html, items_text } = renderOrderItems(
      order.items as Parameters<typeof renderOrderItems>[0],
      currency,
      locale,
      publicBase,
    );

    const orderNumber = order.order_number;
    const totalStr = formatMoney(Number(order.total), currency);

    // Identity of the shop the customer actually bought from: it selects the
    // sender and template overrides, and brands the message itself.
    const brand = {
      storeId: order.storeCtx?.id,
      storeName: order.storeCtx?.name,
      storeLogoUrl: order.storeCtx?.logoUrl
        ? absoluteUrl(order.storeCtx.logoUrl, publicBase)
        : undefined,
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
          { orderNumber, orderUrl, itemsHtml: items_html, itemsText: items_text },
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
          const full = [c?.first_name, c?.last_name].filter(Boolean).join(' ').trim();
          customerName = full || undefined;
        }
        await this.sendNewOrderToOwner(
          ownerEmail,
          {
            ...brand,
            orderNumber,
            total: totalStr,
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
    try {
      await resolved.transporter.sendMail({
        from: resolved.from,
        to,
        subject: 'Multi Stores — test email',
        html: '<p>This is a test email from your Multi Stores admin settings. SMTP is working. ✅</p>',
        text: 'This is a test email from your Multi Stores admin settings. SMTP is working.',
      });
      return { sent: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Test email to ${to} failed: ${message}`);
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
        html: '<p>Your store\'s email sender is working. ✅</p>',
        text: "Your store's email sender is working.",
      });
      await this.prisma.storeMailSettings.update({
        where: { store_id: store.id },
        data: { verified_at: new Date() },
      });
      return { sent: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Store ${store.id} test email to ${to} failed: ${message}`);
      throw new BadRequestException(`SMTP error: ${message}`);
    }
  }
}
