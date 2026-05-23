import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationTemplatesService } from '../notification-templates/notification-templates.service';
import {
  passwordResetEmail,
  orderConfirmationEmail,
  OrderConfirmationData,
} from './templates';

// Localized snippets for the small dynamic fragments injected as template
// variables. The admin edits the surrounding body in NotificationTemplate;
// these phrases are kept here so the dynamic bit matches the email's locale.
const PAYMENT_LINE: Record<string, { paid: string; cod: string }> = {
  en: {
    paid: 'Your payment was received.',
    cod: 'You chose cash on delivery — please pay the courier on arrival.',
  },
  ar: {
    paid: 'تمّ استلام دفعتك.',
    cod: 'اخترتَ الدفع عند الاستلام — يُرجى الدفع للمندوب عند الوصول.',
  },
};
const VIEW_ORDER_LABEL: Record<string, string> = {
  en: 'View your order',
  ar: 'عرض طلبك',
};

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
  private transporter: nodemailer.Transporter | null = null;
  private signature: string | null = null;

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
    private templates: NotificationTemplatesService,
  ) {}

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
        pass: cfg.smtp_pass || undefined,
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

  private async getTransporter(): Promise<{
    transporter: nodemailer.Transporter;
    from: string;
  } | null> {
    const cfg = await this.resolveConfig();
    if (!cfg) {
      this.transporter = null;
      this.signature = null;
      return null;
    }
    const signature = JSON.stringify([cfg.host, cfg.port, cfg.secure, cfg.user, cfg.pass]);
    if (!this.transporter || this.signature !== signature) {
      this.transporter = nodemailer.createTransport({
        host: cfg.host,
        port: cfg.port,
        secure: cfg.secure,
        auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
      });
      this.signature = signature;
    }
    return { transporter: this.transporter, from: cfg.from };
  }

  async isConfigured(): Promise<boolean> {
    return (await this.resolveConfig()) !== null;
  }

  async send(opts: {
    to: string;
    subject: string;
    html: string;
    text?: string;
  }): Promise<{ sent: boolean }> {
    const resolved = await this.getTransporter();
    if (!resolved) {
      this.logger.warn(
        `[mail:not-configured] Would send "${opts.subject}" to ${opts.to}`,
      );
      return { sent: false };
    }
    try {
      await resolved.transporter.sendMail({
        from: resolved.from,
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
        text: opts.text,
      });
      return { sent: true };
    } catch (err) {
      this.logger.error(
        `Failed to send "${opts.subject}" to ${opts.to}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { sent: false };
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

  async sendOrderConfirmation(
    to: string,
    data: OrderConfirmationData,
    locale?: string,
  ) {
    const lang = (locale && PAYMENT_LINE[locale] ? locale : 'en');
    const paymentLine = PAYMENT_LINE[lang][data.paid ? 'paid' : 'cod'];
    const orderButton = data.orderUrl
      ? `<p style="margin:20px 0;"><a href="${data.orderUrl}" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 20px;border-radius:8px;">${VIEW_ORDER_LABEL[lang]}</a></p>`
      : '';
    const orderUrlText = data.orderUrl ? `\n\n${VIEW_ORDER_LABEL[lang]}: ${data.orderUrl}` : '';

    const rendered = await this.templates.render('order_confirmation', locale, {
      order_number: data.orderNumber,
      total: data.total,
      payment_line: paymentLine,
      order_button: orderButton,
      order_url_text: orderUrlText,
    });
    if (rendered) return this.send({ to, ...rendered });
    const fallback = orderConfirmationEmail(data);
    return this.send({ to, ...fallback });
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
    // Only overwrite the password when a non-empty value is provided.
    if (dto.password) data.smtp_pass = dto.password;
    if (dto.from !== undefined) data.mail_from = dto.from.trim() || null;

    await this.prisma.platformConfig.update({
      where: { id: config.id },
      data,
    });
    // Invalidate the cached transporter so the next send picks up the change.
    this.transporter = null;
    this.signature = null;
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
}
