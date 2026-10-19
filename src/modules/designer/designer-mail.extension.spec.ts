import type { PrismaService } from '../../prisma/prisma.service';
import type { MailService } from '../mail/mail.service';
import type { OrderForEmail } from '../mail/order-mail.helpers';
import { DesignerMailExtension } from './designer-mail.extension';
import { DEFAULT_DESIGNER_SETTINGS } from './designer-settings';
import type { DesignerRetentionService } from './designer-retention.service';
import { DesignerUrlsService, DESIGNER_FILES_PATH } from './designer-urls';

// WP10 (M4.2 §8.5): the order proof replaces the product image of a
// designed line through a signed `oid_proof` link that lives until the
// files purge date (at least 7 days). Orders without designs get nothing.

const DAY = 24 * 60 * 60 * 1000;
const OID = '11111111-1111-4111-8111-111111111111';
const STORE = '22222222-2222-4222-8222-222222222222';

function build(rows: unknown[], presence?: { storeHasDesigns: jest.Mock }) {
  const prisma = {
    orderItemDesign: { findMany: jest.fn(() => Promise.resolve(rows)) },
  };
  const mail = { registerOrderMailExtension: jest.fn() };
  const retention = {
    settingsOf: jest.fn(() =>
      Promise.resolve({ ...DEFAULT_DESIGNER_SETTINGS }),
    ),
  };
  const urls = new DesignerUrlsService();
  const ext = new DesignerMailExtension(
    mail as unknown as MailService,
    prisma as unknown as PrismaService,
    urls,
    retention as unknown as DesignerRetentionService,
    presence as never,
  );
  return { ext, prisma, mail, urls };
}

const order = (items: unknown[] = [{ id: 'i1' }]) =>
  ({ id: 'o1', store_id: STORE, items }) as unknown as OrderForEmail;

function expOf(urls: DesignerUrlsService, url: string): number {
  const token = url.slice(
    url.indexOf(DESIGNER_FILES_PATH) + DESIGNER_FILES_PATH.length,
  );
  const check = urls.verify(token);
  if (!check.ok) throw new Error('invalid token');
  return check.payload.exp * 1000;
}

describe('DesignerMailExtension', () => {
  it('registers itself with the mail service', () => {
    const { ext, mail } = build([]);
    ext.onModuleInit();
    expect(mail.registerOrderMailExtension).toHaveBeenCalledWith(ext);
  });

  it('no designs (or no items): no overrides', async () => {
    const t = build([]);
    expect(await t.ext.itemImages(order(), 'order_confirmation')).toEqual({});
    expect(await t.ext.itemImages(order([]), 'order_confirmation')).toEqual({});
    expect(t.prisma.orderItemDesign.findMany).toHaveBeenCalledTimes(1);
  });

  it('a designed line gets a signed oid_proof link valid until the purge date', async () => {
    const created = new Date(Date.now() - DAY);
    const t = build([
      {
        id: OID,
        order_item_id: 'i1',
        store_id: STORE,
        shipped_at: null,
        terminal_at: null,
        created_at: created,
      },
    ]);
    const out = await t.ext.itemImages(order(), 'order_confirmation');
    expect(Object.keys(out)).toEqual(['i1']);
    expect(out.i1).toContain(DESIGNER_FILES_PATH);
    const token = out.i1.slice(
      out.i1.indexOf(DESIGNER_FILES_PATH) + DESIGNER_FILES_PATH.length,
    );
    const check = t.urls.verify(token);
    expect(check.ok && check.payload).toMatchObject({
      k: 'oid_proof',
      id: OID,
      s: STORE,
    });
    // Not shipped yet: the hard cap is far away, so the mail-link cap
    // (30 days by default) applies.
    const exp = expOf(t.urls, out.i1);
    expect(Math.abs(exp - (Date.now() + 30 * DAY))).toBeLessThan(2000);
    const where = (
      t.prisma.orderItemDesign.findMany.mock.calls[0] as unknown[]
    )[0] as {
      where: Record<string, unknown>;
    };
    expect(where.where).toMatchObject({
      order_id: 'o1',
      files_purged_at: null,
    });
  });

  it('M5.6: a double-sided line adds `<item>:back` (oid_proof_back, same expiry); no back proof: front key only', async () => {
    const created = new Date(Date.now() - DAY);
    const t = build([
      {
        id: OID,
        order_item_id: 'i1',
        store_id: STORE,
        shipped_at: null,
        terminal_at: null,
        created_at: created,
        back_mode: 'other',
        proof_back_key: 'designer/s/proof/x-back.webp',
      },
      {
        id: '33333333-3333-4333-8333-333333333333',
        order_item_id: 'i2',
        store_id: STORE,
        shipped_at: null,
        terminal_at: null,
        created_at: created,
        back_mode: 'same',
        proof_back_key: null,
      },
    ]);
    const out = await t.ext.itemImages(order(), 'order_confirmation');
    expect(Object.keys(out).sort()).toEqual(['i1', 'i1:back', 'i2']);
    const token = out['i1:back'].slice(
      out['i1:back'].indexOf(DESIGNER_FILES_PATH) + DESIGNER_FILES_PATH.length,
    );
    const check = t.urls.verify(token);
    expect(check.ok && check.payload).toMatchObject({
      k: 'oid_proof_back',
      id: OID,
      s: STORE,
    });
    expect(expOf(t.urls, out['i1:back'])).toBe(expOf(t.urls, out.i1));
  });

  it('shipped long ago: the link still lives at least 7 days', async () => {
    const t = build([
      {
        id: OID,
        order_item_id: 'i1',
        store_id: STORE,
        shipped_at: new Date(Date.now() - 29 * DAY),
        terminal_at: null,
        created_at: new Date(Date.now() - 40 * DAY),
      },
    ]);
    const out = await t.ext.itemImages(order(), 'order_shipped');
    const exp = expOf(t.urls, out.i1);
    expect(exp).toBeGreaterThanOrEqual(Date.now() + 7 * DAY - 2000);
    expect(exp).toBeLessThan(Date.now() + 8 * DAY);
  });

  it('a store that never had designs (app off): no query at all', async () => {
    const presence = { storeHasDesigns: jest.fn(() => Promise.resolve(false)) };
    const t = build([{ id: OID }], presence);
    expect(await t.ext.itemImages(order(), 'order_confirmation')).toEqual({});
    expect(presence.storeHasDesigns).toHaveBeenCalledWith(STORE);
    expect(t.prisma.orderItemDesign.findMany).not.toHaveBeenCalled();
  });
});
