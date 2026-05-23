import { Injectable, NotFoundException } from '@nestjs/common';
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
   * Returns null when the template is missing or disabled — callers should
   * treat that as "do not send".
   */
  async render(
    event: string,
    locale: string | undefined,
    vars: Record<string, string>,
  ): Promise<{ subject: string; html: string; text: string } | null> {
    const tpl = await this.prisma.notificationTemplate.findUnique({
      where: { event },
    });
    if (!tpl || !tpl.enabled) return null;
    return {
      subject: substitute(this.pickLocale(tpl.subject, locale), vars),
      html: substitute(this.pickLocale(tpl.body_html, locale), vars),
      text: substitute(this.pickLocale(tpl.body_text, locale), vars),
    };
  }

  // ── Admin ────────────────────────────────────────────────────────────────

  async list() {
    return this.prisma.notificationTemplate.findMany({
      orderBy: { event: 'asc' },
    });
  }

  async getByEvent(event: string) {
    const t = await this.prisma.notificationTemplate.findUnique({
      where: { event },
    });
    if (!t) throw new NotFoundException('Template not found');
    return t;
  }

  async update(event: string, dto: UpdateNotificationTemplateDto) {
    const existing = await this.prisma.notificationTemplate.findUnique({
      where: { event },
    });
    if (!existing) throw new NotFoundException('Template not found');

    const data: {
      subject?: object;
      body_html?: object;
      body_text?: object;
      enabled?: boolean;
    } = {};
    if (dto.subject) {
      data.subject = { ...(existing.subject as Localized), ...dto.subject };
    }
    if (dto.body_html) {
      data.body_html = { ...(existing.body_html as Localized), ...dto.body_html };
    }
    if (dto.body_text) {
      data.body_text = { ...(existing.body_text as Localized), ...dto.body_text };
    }
    if (dto.enabled !== undefined) data.enabled = dto.enabled;

    return this.prisma.notificationTemplate.update({
      where: { event },
      data,
    });
  }
}
