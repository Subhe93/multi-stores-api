import { Injectable } from '@nestjs/common';
import { InvoiceKind, type StoreLegalProfile } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { validateVatNumber } from '../b2b/vat-number.util';
import { invoiceErrors } from './invoice-errors';
import { InvoiceNumberingService } from './invoice-numbering.service';
import {
  isValidTimezone,
  profileCompleteness,
  validateBankgiro,
  validateBic,
  validateIban,
} from './legal-profile.util';
import type {
  InvoiceBankDetails,
  InvoiceSeller,
  LegalProfileInput,
  LegalProfileView,
  NumberingInput,
  NumberingSequenceView,
} from './invoices.types';

export const DEFAULT_PROFILE_KEY = 'default';
const DEFAULT_TIMEZONE = 'Europe/Stockholm';
const DEFAULT_DUE_DAYS = 30;

/** Initial prefixes of the two series created with the profile. */
const INITIAL_PREFIX: Record<InvoiceKind, string> = {
  INVOICE: '',
  CREDIT_NOTE: 'CN-',
};

/** Nullable text columns a PUT may set or clear. */
const TEXT_FIELDS = [
  'legal_name',
  'brand_name',
  'org_number',
  'vat_number',
  'address_line1',
  'address_line2',
  'postal_code',
  'city',
  'country_code',
  'registered_office',
  'email',
  'phone',
  'website',
  'bankgiro',
  'plusgiro',
  'iban',
  'bic',
  'bank_name',
  'logo_url',
  'footer_note',
] as const;

type TextField = (typeof TEXT_FIELDS)[number];

export type ProfileWithSequences = StoreLegalProfile & {
  sequences: {
    kind: InvoiceKind;
    prefix: string;
    padding: number;
    next_number: number;
    issued_count: number;
  }[];
};

/**
 * The seller's legal identity (D1): one 'default' StoreLegalProfile per
 * store, created on first save together with its two number series.
 */
@Injectable()
export class LegalProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: InvoiceNumberingService,
  ) {}

  /** The store's profile with its sequences, or null before the first save. */
  find(storeId: string): Promise<ProfileWithSequences | null> {
    return this.prisma.storeLegalProfile.findUnique({
      where: { store_id_key: { store_id: storeId, key: DEFAULT_PROFILE_KEY } },
      include: {
        sequences: {
          select: {
            kind: true,
            prefix: true,
            padding: true,
            next_number: true,
            issued_count: true,
          },
        },
      },
    });
  }

  async get(storeId: string): Promise<LegalProfileView> {
    return toView(await this.find(storeId));
  }

  async upsert(
    storeId: string,
    dto: LegalProfileInput,
  ): Promise<LegalProfileView> {
    const data = normalizeProfileInput(dto);
    const profile = await this.prisma.storeLegalProfile.upsert({
      where: { store_id_key: { store_id: storeId, key: DEFAULT_PROFILE_KEY } },
      create: { store_id: storeId, key: DEFAULT_PROFILE_KEY, ...data },
      update: data,
    });
    await this.ensureSequences(profile.id, storeId);
    return this.get(storeId);
  }

  async updateNumbering(
    storeId: string,
    dto: NumberingInput,
  ): Promise<LegalProfileView> {
    // Numbering may be configured before the identity is filled in.
    const profile = await this.prisma.storeLegalProfile.upsert({
      where: { store_id_key: { store_id: storeId, key: DEFAULT_PROFILE_KEY } },
      create: { store_id: storeId, key: DEFAULT_PROFILE_KEY },
      update: {},
    });
    await this.ensureSequences(profile.id, storeId);
    await this.numbering.updateNumbering(profile.id, dto);
    return this.get(storeId);
  }

  /** Both series exist (idempotent; safe against concurrent first saves). */
  async ensureSequences(profileId: string, storeId: string): Promise<void> {
    await this.prisma.invoiceSequence.createMany({
      data: [InvoiceKind.INVOICE, InvoiceKind.CREDIT_NOTE].map((kind) => ({
        legal_profile_id: profileId,
        store_id: storeId,
        kind,
        prefix: INITIAL_PREFIX[kind],
      })),
      skipDuplicates: true,
    });
  }
}

/** Validate + normalize a PUT body into column values (throws INVOICE_*). */
export function normalizeProfileInput(dto: LegalProfileInput): Partial<
  Record<TextField, string | null>
> & {
  f_tax_approved?: boolean;
  due_days?: number;
  timezone?: string;
} {
  const out: Partial<Record<TextField, string | null>> & {
    f_tax_approved?: boolean;
    due_days?: number;
    timezone?: string;
  } = {};
  for (const key of TEXT_FIELDS) {
    if (!(key in dto)) continue;
    const raw = dto[key];
    const trimmed = typeof raw === 'string' ? raw.trim() : null;
    out[key] = trimmed ? trimmed : null;
  }
  if (out.iban) {
    const r = validateIban(out.iban);
    if (!r.ok) throw invoiceErrors.ibanInvalid();
    out.iban = r.normalized;
  }
  if (out.bankgiro) {
    const r = validateBankgiro(out.bankgiro);
    if (!r.ok) throw invoiceErrors.bankgiroInvalid();
    out.bankgiro = r.normalized;
  }
  if (out.bic) {
    const r = validateBic(out.bic);
    if (!r.ok) throw invoiceErrors.bicInvalid();
    out.bic = r.normalized;
  }
  if (out.vat_number) {
    const r = validateVatNumber(out.vat_number);
    if (!r.ok) throw invoiceErrors.vatNumberInvalid();
    out.vat_number = r.normalized;
  }
  if (out.country_code) out.country_code = out.country_code.toUpperCase();
  if (dto.f_tax_approved !== undefined) out.f_tax_approved = dto.f_tax_approved;
  if (dto.due_days !== undefined) out.due_days = dto.due_days;
  if (dto.timezone !== undefined) {
    const tz = dto.timezone.trim();
    if (!tz || !isValidTimezone(tz)) throw invoiceErrors.timezoneInvalid();
    out.timezone = tz;
  }
  return out;
}

function sequenceView(
  profile: ProfileWithSequences | null,
  kind: InvoiceKind,
): NumberingSequenceView {
  const seq = profile?.sequences.find((s) => s.kind === kind);
  return {
    prefix: seq?.prefix ?? INITIAL_PREFIX[kind],
    padding: seq?.padding ?? 0,
    next_number: seq?.next_number ?? 1,
    issued_count: seq?.issued_count ?? 0,
    locked: (seq?.issued_count ?? 0) > 0,
  };
}

/**
 * The dashboard view. Completeness here assumes VAT is charged (the usual
 * case); issuing re-checks against the actual order (a zero-VAT order does
 * not need a VAT number).
 */
export function toView(profile: ProfileWithSequences | null): LegalProfileView {
  const p = profile;
  const { complete, missing } = profileCompleteness(p, { chargesVat: true });
  const text = (key: TextField) => (p ? p[key] : null);
  return {
    legal_name: text('legal_name'),
    brand_name: text('brand_name'),
    org_number: text('org_number'),
    vat_number: text('vat_number'),
    address_line1: text('address_line1'),
    address_line2: text('address_line2'),
    postal_code: text('postal_code'),
    city: text('city'),
    country_code: text('country_code'),
    registered_office: text('registered_office'),
    email: text('email'),
    phone: text('phone'),
    website: text('website'),
    bankgiro: text('bankgiro'),
    plusgiro: text('plusgiro'),
    iban: text('iban'),
    bic: text('bic'),
    bank_name: text('bank_name'),
    logo_url: text('logo_url'),
    f_tax_approved: p?.f_tax_approved ?? false,
    due_days: p?.due_days ?? DEFAULT_DUE_DAYS,
    footer_note: text('footer_note'),
    timezone: p?.timezone ?? DEFAULT_TIMEZONE,
    complete,
    missing,
    numbering: {
      invoice: sequenceView(p, InvoiceKind.INVOICE),
      credit_note: sequenceView(p, InvoiceKind.CREDIT_NOTE),
    },
  };
}

/** Seller block of a snapshot (profile logo, else the store's). */
export function sellerSnapshot(
  profile: StoreLegalProfile,
  store: { name: string; logo_url: string | null },
): InvoiceSeller {
  const brand = profile.brand_name || store.name || null;
  return {
    legal_name: profile.legal_name ?? '',
    brand_name: brand && brand !== profile.legal_name ? brand : null,
    org_number: profile.org_number,
    vat_number: profile.vat_number,
    address: {
      line1: profile.address_line1 ?? '',
      line2: profile.address_line2,
      postal_code: profile.postal_code ?? '',
      city: profile.city ?? '',
      country_code: profile.country_code ?? '',
    },
    registered_office: profile.registered_office,
    email: profile.email,
    phone: profile.phone,
    website: profile.website,
    f_tax_approved: profile.f_tax_approved,
    logo_url: profile.logo_url || store.logo_url || null,
    footer_note: profile.footer_note,
  };
}

/** Bank block (without the payment reference). */
export function bankSnapshot(
  profile: StoreLegalProfile,
): Omit<InvoiceBankDetails, 'reference'> {
  return {
    bankgiro: profile.bankgiro,
    plusgiro: profile.plusgiro,
    iban: profile.iban,
    bic: profile.bic,
    bank_name: profile.bank_name,
  };
}
