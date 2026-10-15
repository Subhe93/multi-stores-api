import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, TaxExemptionKind } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { B2bService } from './b2b.service';
import type { BuyerType, VatEvidence } from './b2b.types';
import {
  decideTaxExemption,
  type CustomerExemptionRef,
  type ExemptionInputs,
  type TaxExemptionDecision,
  viesFormOf,
} from './reverse-charge';
import type { TaxContext } from '../taxes/tax.service';
import { isEuVatPrefix } from './vies/vies.parse';
import { ViesService } from './vies/vies.service';
import type { ViesCheckSource } from './vies/vies.types';

/** How prepare() obtains the VIES evidence. */
export type ExemptionPrepareMode = 'live' | 'cached' | 'stored';

export interface PrepareExemptionOptions {
  buyerType: BuyerType;
  vatNumber?: string | null;
  /** Customer.id known at pricing time (logged-in / Kustom session). */
  customerId?: string | null;
  /** User.id of a logged-in shopper; resolved to the Customer lazily. */
  userId?: string | null;
  /**
   * live: may call VIES (order create, Kustom create / update);
   * cached: caches only (quote); stored: `stored` only, never VIES (Kustom
   * callbacks, 3 s budget).
   */
  mode: ExemptionPrepareMode;
  stored?: VatEvidence | null;
  source?: ViesCheckSource;
}

/** An exemption as the dashboard lists it. */
export interface ExemptionView {
  id: string;
  customer: {
    id: string;
    first_name: string;
    last_name: string;
    email: string | null;
  };
  kind: TaxExemptionKind;
  vat_number: string | null;
  note: string | null;
  created_at: Date;
  created_by: string;
  revoked_at: Date | null;
}

export interface CreateExemptionInput {
  customer_id?: string | null;
  order_id?: string | null;
  kind: TaxExemptionKind;
  vat_number?: string | null;
  note?: string | null;
}

const exemptionInclude = {
  customer: {
    select: {
      id: true,
      first_name: true,
      last_name: true,
      user: { select: { email: true } },
    },
  },
} as const;

type ExemptionRow = Prisma.StoreCustomerTaxExemptionGetPayload<{
  include: typeof exemptionInclude;
}>;

function toView(row: ExemptionRow): ExemptionView {
  return {
    id: row.id,
    customer: {
      id: row.customer.id,
      first_name: row.customer.first_name,
      last_name: row.customer.last_name,
      email: row.customer.user?.email ?? null,
    },
    kind: row.kind,
    vat_number: row.vat_number,
    note: row.note,
    created_at: row.created_at,
    created_by: row.created_by,
    revoked_at: row.revoked_at,
  };
}

/**
 * Reverse charge and customer exemptions of the b2b app (M2.5). prepare()
 * loads what the pure decideTaxExemption() needs - null whenever the app or
 * `reverse_charge_enabled` is off, so those stores price exactly as before.
 * The CRUD half manages the merchant's "don't collect tax" exemptions.
 */
@Injectable()
export class B2bTaxExemptionService {
  private readonly logger = new Logger(B2bTaxExemptionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly b2b: B2bService,
    private readonly vies: ViesService,
  ) {}

  /** Inputs of the decision; null = app or reverse charge off. */
  async prepare(
    storeId: string,
    opts: PrepareExemptionOptions,
  ): Promise<ExemptionInputs | null> {
    if (!(await this.b2b.isEnabled(storeId))) return null;
    const settings = await this.b2b.getSettings(storeId);
    if (!settings.reverse_charge_enabled) return null;

    let vat: VatEvidence | null = null;
    const vatNumber = (opts.vatNumber ?? '').trim();
    if (opts.buyerType === 'COMPANY' && vatNumber) {
      if (opts.mode === 'stored') {
        const wanted = viesFormOf(vatNumber);
        vat =
          opts.stored && wanted && opts.stored.vat_number === wanted
            ? opts.stored
            : null;
      } else {
        vat = await this.vies.check(vatNumber, {
          storeId,
          source: opts.source ?? (opts.mode === 'live' ? 'order' : 'quote'),
          mode: opts.mode,
          requester: await this.vies.requesterFor(
            storeId,
            settings.vies_requester_vat,
          ),
        });
      }
    }

    let customerExemption: CustomerExemptionRef | null = null;
    let customerId = opts.customerId ?? null;
    if (!customerId && opts.userId) {
      const customer = await this.prisma.customer.findUnique({
        where: { user_id: opts.userId },
        select: { id: true },
      });
      customerId = customer?.id ?? null;
    }
    if (customerId) {
      customerExemption = await this.prisma.storeCustomerTaxExemption.findFirst(
        {
          where: {
            store_id: storeId,
            customer_id: customerId,
            revoked_at: null,
          },
          select: { id: true, kind: true, vat_number: true, created_at: true },
        },
      );
    }
    return { settings, vat, customerExemption };
  }

  /** decideTaxExemption() over prepared inputs (pure). */
  decide(
    inputs: ExemptionInputs | null,
    ctx: Pick<TaxContext, 'registrant' | 'taxCountry'>,
    destinationCountry: string | null | undefined,
    buyerType: BuyerType,
  ): TaxExemptionDecision {
    return decideTaxExemption({ ctx, destinationCountry, buyerType, inputs });
  }

  /** VIES check for a store with its requester (dashboard / storefront). */
  async checkVat(
    storeId: string,
    vatNumber: string,
    source: ViesCheckSource,
  ): Promise<VatEvidence> {
    const settings = await this.b2b.getSettings(storeId);
    return this.vies.check(vatNumber, {
      storeId,
      source,
      mode: 'live',
      requester: await this.vies.requesterFor(
        storeId,
        settings.vies_requester_vat,
      ),
    });
  }

  // ── Customer exemptions (dashboard) ───────────────────────────────────────

  async list(
    storeId: string,
    includeRevoked = false,
  ): Promise<ExemptionView[]> {
    const rows = await this.prisma.storeCustomerTaxExemption.findMany({
      where: {
        store_id: storeId,
        ...(includeRevoked ? {} : { revoked_at: null }),
      },
      include: exemptionInclude,
      orderBy: { created_at: 'desc' },
    });
    return rows.map(toView);
  }

  async byCustomer(
    storeId: string,
    customerId: string,
  ): Promise<ExemptionView | null> {
    const row = await this.prisma.storeCustomerTaxExemption.findFirst({
      where: { store_id: storeId, customer_id: customerId, revoked_at: null },
      include: exemptionInclude,
    });
    return row ? toView(row) : null;
  }

  /**
   * Grant an exemption. The customer comes from `order_id` (an order of
   * this store) or `customer_id`, which must have ordered from this store
   * (privacy: a merchant cannot address arbitrary platform customers).
   */
  async create(
    storeId: string,
    userId: string,
    input: CreateExemptionInput,
  ): Promise<ExemptionView> {
    const notFound = () =>
      new NotFoundException({
        code: 'B2B_EXEMPTION_CUSTOMER_NOT_FOUND',
        message: 'No customer with an order in this store was found.',
      });
    let customerId: string | null = null;
    let orderVat: string | null = null;
    if (input.order_id) {
      const order = await this.prisma.order.findFirst({
        where: { id: input.order_id, store_id: storeId },
        select: { customer_id: true, vat_number: true },
      });
      if (!order) throw notFound();
      if (input.customer_id && input.customer_id !== order.customer_id) {
        throw notFound();
      }
      customerId = order.customer_id;
      orderVat = order.vat_number;
    } else if (input.customer_id) {
      const order = await this.prisma.order.findFirst({
        where: { customer_id: input.customer_id, store_id: storeId },
        select: { customer_id: true },
      });
      if (!order) throw notFound();
      customerId = order.customer_id;
    }
    if (!customerId) throw notFound();

    const rawVat = (input.vat_number ?? '').trim() || orderVat || '';
    let vatNumber: string | null = null;
    if (rawVat) {
      const form = viesFormOf(rawVat);
      if (!form || !isEuVatPrefix(form.slice(0, 2))) {
        if (input.kind === TaxExemptionKind.REVERSE_CHARGE) {
          throw this.vatRequired();
        }
      } else {
        vatNumber = form;
      }
    }
    if (input.kind === TaxExemptionKind.REVERSE_CHARGE && !vatNumber) {
      throw this.vatRequired();
    }

    const existing = await this.prisma.storeCustomerTaxExemption.findFirst({
      where: { store_id: storeId, customer_id: customerId, revoked_at: null },
      select: { id: true },
    });
    if (existing) throw this.exists();
    try {
      const row = await this.prisma.storeCustomerTaxExemption.create({
        data: {
          store_id: storeId,
          customer_id: customerId,
          kind: input.kind,
          vat_number: vatNumber,
          note: input.note?.trim().slice(0, 500) || null,
          created_by: userId,
        },
        include: exemptionInclude,
      });
      return toView(row);
    } catch (err) {
      // The partial unique index closes the race between two creates.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw this.exists();
      }
      throw err;
    }
  }

  /** Soft revoke (the row stays as evidence for past orders). */
  async revoke(
    storeId: string,
    userId: string,
    id: string,
  ): Promise<ExemptionView> {
    const row = await this.prisma.storeCustomerTaxExemption.findFirst({
      where: { id, store_id: storeId, revoked_at: null },
      select: { id: true },
    });
    if (!row) {
      throw new NotFoundException({
        code: 'B2B_EXEMPTION_NOT_FOUND',
        message: 'Exemption not found.',
      });
    }
    const updated = await this.prisma.storeCustomerTaxExemption.update({
      where: { id: row.id },
      data: { revoked_at: new Date(), revoked_by: userId },
      include: exemptionInclude,
    });
    this.logger.log(`Tax exemption ${id} of store ${storeId} revoked`);
    return toView(updated);
  }

  private vatRequired() {
    return new BadRequestException({
      code: 'B2B_EXEMPTION_VAT_REQUIRED',
      message:
        'A reverse-charge exemption needs a valid EU VAT number with its country prefix.',
    });
  }

  private exists() {
    return new ConflictException({
      code: 'B2B_EXEMPTION_EXISTS',
      message: 'This customer already has an active tax exemption.',
    });
  }
}
