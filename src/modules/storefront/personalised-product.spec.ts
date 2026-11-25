import {
  BUYER_CONTENT_FIELD_TYPES,
  isBuyerPersonalisedProduct,
} from './personalised-product';

// M172: the one rule that decides "made to the buyer's specification".

describe('isBuyerPersonalisedProduct', () => {
  it('nothing to fill in: not personalised', () => {
    for (const input of [
      null,
      undefined,
      {},
      { fields: null },
      { fields: [] },
      { fields: [], designer: false },
      { designer: null },
    ]) {
      expect(isBuyerPersonalisedProduct(input)).toBe(false);
    }
  });

  it('a text or upload field makes the product personalised', () => {
    for (const type of ['TEXT', 'TEXTAREA', 'IMAGE', 'MULTI_IMAGE', 'FILE']) {
      expect(BUYER_CONTENT_FIELD_TYPES.has(type)).toBe(true);
      expect(isBuyerPersonalisedProduct({ fields: [{ type }] })).toBe(true);
    }
  });

  it('choice, number and date fields alone do not', () => {
    const types = [
      'SELECT',
      'COLOR',
      'FONT',
      'NUMBER',
      'DATE',
      'CHECKBOX_GROUP',
      'COLOR_PALETTE',
      'REPEATER',
      'SOMETHING_NEW',
    ];
    expect(
      isBuyerPersonalisedProduct({ fields: types.map((type) => ({ type })) }),
    ).toBe(false);
  });

  it('one content field among choices is enough', () => {
    expect(
      isBuyerPersonalisedProduct({
        fields: [{ type: 'SELECT' }, { type: 'FONT' }, { type: 'TEXT' }],
      }),
    ).toBe(true);
  });

  it('looks into repeater children', () => {
    expect(
      isBuyerPersonalisedProduct({
        fields: [
          {
            type: 'REPEATER',
            children: [{ type: 'SELECT' }, { type: 'TEXT' }],
          },
        ],
      }),
    ).toBe(true);
    expect(
      isBuyerPersonalisedProduct({
        fields: [{ type: 'REPEATER', children: [{ type: 'SELECT' }] }],
      }),
    ).toBe(false);
    expect(
      isBuyerPersonalisedProduct({
        fields: [{ type: 'REPEATER', children: null }],
      }),
    ).toBe(false);
  });

  it('a live designer link is enough on its own', () => {
    expect(isBuyerPersonalisedProduct({ designer: true })).toBe(true);
    expect(isBuyerPersonalisedProduct({ fields: [], designer: true })).toBe(
      true,
    );
  });

  it('a text field with an identity format is data about the buyer, not content', () => {
    const personnummer = { format: 'personnummer' };
    for (const type of ['TEXT', 'TEXTAREA']) {
      expect(
        isBuyerPersonalisedProduct({
          fields: [{ type, validation_rules: personnummer }],
        }),
      ).toBe(false);
    }
    // As a repeater child too.
    expect(
      isBuyerPersonalisedProduct({
        fields: [
          {
            type: 'REPEATER',
            children: [{ type: 'TEXT', validation_rules: personnummer }],
          },
        ],
      }),
    ).toBe(false);
    // Another content field next to it still makes the product personalised.
    expect(
      isBuyerPersonalisedProduct({
        fields: [
          { type: 'TEXT', validation_rules: personnummer },
          { type: 'TEXT', validation_rules: { max_length: 12 } },
        ],
      }),
    ).toBe(true);
    // The designer link is independent of the fields.
    expect(
      isBuyerPersonalisedProduct({
        fields: [{ type: 'TEXT', validation_rules: personnummer }],
        designer: true,
      }),
    ).toBe(true);
  });

  it('other validation rules, unknown formats and uploads keep counting', () => {
    for (const validation_rules of [
      null,
      undefined,
      {},
      { max_length: 10, pattern: '^[a-z]+$' },
      { format: 'something_new' },
      { format: 5 },
      ['personnummer'],
      'personnummer',
    ]) {
      expect(
        isBuyerPersonalisedProduct({
          fields: [{ type: 'TEXT', validation_rules }],
        }),
      ).toBe(true);
    }
    // The format only exists for text fields: an upload is always content.
    expect(
      isBuyerPersonalisedProduct({
        fields: [
          { type: 'IMAGE', validation_rules: { format: 'personnummer' } },
        ],
      }),
    ).toBe(true);
  });

  it('malformed rows never count', () => {
    const fields = [null, {}, { type: 5 }, 'TEXT'] as unknown as {
      type: string;
    }[];
    expect(isBuyerPersonalisedProduct({ fields })).toBe(false);
  });
});
