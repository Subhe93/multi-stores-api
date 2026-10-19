import { BadRequestException } from '@nestjs/common';
import {
  PersonalizationCoreService,
  type CoreFieldDef,
  type LineContext,
} from './personalization-core.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CustomerUploadsService } from '../../modules/customer-uploads/customer-uploads.service';
import type { PLine } from '@multi-stores/core/personalization/types';
import {
  appFields,
  plainFields,
} from '../../modules/personalization/__fixtures__/app-fields';

// M4.1 seams of the core service (C19): `loadContexts` hands the M4.0 rules
// only top-level M4.0 fields (and every row as `allFields` when M4.1 rows
// exist), and `buildOrderValues(…, {lines})` writes one snapshot row per
// evaluator line with the M4.0 upload attach.

const UPLOAD_ID = '0b8f2c1e-1111-4222-8333-944445555666';
const PREVIEW = `/uploads/customer-previews/${UPLOAD_ID}.webp`;

function core(fields: unknown[]) {
  const prisma = {
    productCustomField: { findMany: jest.fn(() => Promise.resolve(fields)) },
    customProduct: { findMany: jest.fn(() => Promise.resolve([])) },
  };
  return new PersonalizationCoreService(
    prisma as unknown as PrismaService,
    {} as CustomerUploadsService,
  );
}

const fileLine = (): PLine => ({
  field_id: 'f-logo',
  field_name: 'logo',
  source: 'FIELD',
  type: 'IMAGE',
  label: 'Logo',
  value: PREVIEW,
  display_value: PREVIEW,
  is_file: true,
  group_key: null,
  group_index: null,
  group_label: null,
  price_delta: '10.00',
  price_delta_minor: 1000,
  meta: null,
  sort_order: 0,
  i18n: { label: { sv: 'Logo' }, display_value: null, group_label: null },
});

const logoCtx: LineContext = {
  productId: 'p1',
  fields: [
    {
      id: 'f-logo',
      name: 'logo',
      type: 'IMAGE',
      is_required: false,
      sort_order: 0,
      translations: [{ locale: 'sv', label: 'Logo' }],
    } as CoreFieldDef,
  ],
  prefilled: {},
};

describe('PersonalizationCoreService M4.1 seams', () => {
  it('loadContexts: M4.0 products unchanged (no allFields); M4.1 rows only in allFields', async () => {
    const [plain] = await core(plainFields()).loadContexts([
      { product_id: 'p1' },
    ]);
    expect(plain.fields).toHaveLength(1);
    expect(plain).not.toHaveProperty('allFields');
    const [app] = await core(appFields()).loadContexts([{ product_id: 'p1' }]);
    expect(app.fields.map((f) => f.name)).toEqual(['custom_name_v3']);
    expect(app.allFields).toHaveLength(4);
  });

  it('M5 A3: uploadRefsOf + uploadExpired name the field and the line of an unattachable upload', () => {
    const service = core([]);
    const rows = service.buildOrderValues(
      { line_id: 'row-7' },
      logoCtx,
      {},
      {
        lines: [fileLine()],
        uploads: new Map([[PREVIEW, { id: UPLOAD_ID, purged: false }]]),
      },
    );
    const refs = service.uploadRefsOf(rows, logoCtx, { line_id: 'row-7' });
    expect([...refs.keys()]).toEqual([UPLOAD_ID]);
    const err = service.uploadExpired(refs.get(UPLOAD_ID), 'sv');
    expect(err.getResponse()).toMatchObject({
      code: 'CUSTOMER_UPLOAD_EXPIRED',
      field_id: 'f-logo',
      field_name: 'logo',
      line_id: 'row-7',
      params: { label: 'Logo' },
    });
    // Unknown reference (defensive): still the coded error, no field.
    expect(service.uploadExpired(undefined).getResponse()).toMatchObject({
      code: 'CUSTOMER_UPLOAD_EXPIRED',
      field_id: '',
      field_name: '',
    });
  });

  it('buildOrderValues with lines: snapshot columns, file row with the upload attached', () => {
    const svc = core([]);
    const rows = svc.buildOrderValues(
      { line_index: 0 },
      logoCtx,
      {},
      {
        lines: [fileLine()],
        uploads: new Map([
          [PREVIEW, { id: UPLOAD_ID, purged: false } as never],
        ]),
      },
    );
    expect(rows).toEqual([
      {
        custom_field_id: 'f-logo',
        file_url: PREVIEW,
        field_name: 'logo',
        field_type: 'IMAGE',
        field_label: { sv: 'Logo' },
        sort_order: 0,
        source: 'FIELD',
        price_delta: '10.00',
        upload_id: UPLOAD_ID,
      },
    ]);
    expect(svc.uploadIdsOf(rows)).toEqual([UPLOAD_ID]);
  });

  it('buildOrderValues with lines: an expired upload is CUSTOMER_UPLOAD_EXPIRED', () => {
    const svc = core([]);
    expect(() =>
      svc.buildOrderValues(
        { line_id: 'ci1' },
        logoCtx,
        {},
        {
          lines: [fileLine()],
        },
      ),
    ).toThrow(BadRequestException);
  });
});
