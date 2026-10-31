import { htmlVars, substitute } from './notification-templates.service';

// An `html:<name>` variable overrides `<name>` for the HTML body only, so a
// caller can hand over an escaped copy of a shopper-typed value without
// changing how any other variable (or the text / subject) renders.
describe('htmlVars', () => {
  const vars = {
    company_name: 'Bob & <Sons>',
    'html:company_name': 'Bob &amp; &lt;Sons&gt;',
    customer_name: 'Anna',
  };

  it('applies the html override to the HTML body only', () => {
    const tpl = '{{company_name}} / {{customer_name}}';
    expect(substitute(tpl, htmlVars(vars))).toBe(
      'Bob &amp; &lt;Sons&gt; / Anna',
    );
    expect(substitute(tpl, vars)).toBe('Bob & <Sons> / Anna');
  });

  it('is a no-op without overrides and keeps conditions working', () => {
    expect(htmlVars({ a: '1' })).toEqual({ a: '1' });
    expect(substitute('{{#if company_name}}x{{/if}}', htmlVars(vars))).toBe(
      'x',
    );
  });
});

// account_created carries a platform-wide account's password and magic link:
// a store may neither see nor override its template.
describe('platform-only events (store overrides)', () => {
  const { NotificationTemplatesService, PLATFORM_ONLY_EVENTS } =
    jest.requireActual<typeof import('./notification-templates.service')>(
      './notification-templates.service',
    );
  function build() {
    const prisma = {
      creator: { findUnique: jest.fn().mockResolvedValue({ id: 'c1' }) },
      store: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 's1', store_type: 'INDEPENDENT' }),
      },
      storeNotificationTemplate: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn(),
      },
      notificationTemplate: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };
    const service = new NotificationTemplatesService(prisma as never);
    return { service, prisma };
  }

  it('lists account_created as platform-only', () => {
    expect(PLATFORM_ONLY_EVENTS.has('account_created')).toBe(true);
  });

  it('hides it from the store list and refuses to read or save an override', async () => {
    const { service, prisma } = build();
    const events = (await service.listForStore('u1')).map((r) => r.event);
    expect(events).not.toContain('account_created');
    expect(events).toContain('order_confirmation');
    await expect(service.getForStore('u1', 'account_created')).rejects.toThrow(
      'Unknown event',
    );
    await expect(
      service.updateForStore('u1', 'account_created', { enabled: true }),
    ).rejects.toThrow('Unknown event');
    expect(prisma.storeNotificationTemplate.upsert).not.toHaveBeenCalled();
  });
});
