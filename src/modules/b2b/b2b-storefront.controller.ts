import {
  Body,
  Controller,
  HttpCode,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PrismaService } from '../../prisma/prisma.service';
import { TaxService, taxStoreSelect } from '../taxes/tax.service';
import { B2bService } from './b2b.service';
import { B2bTaxExemptionService } from './b2b-tax-exemption.service';
import type { VatCheckResponse } from './b2b.types';
import { VatCheckDto } from './dto/tax-exemption.dto';
import { normalizeVatNumber } from './vat-number.util';
import { whyOfVatStatus } from './reverse-charge';

/**
 * Public VAT-number check of the storefront (b2b app, M2.5). Deliberately
 * not decorated with @RequireApp: with the app or reverse charge off it
 * answers `status: 'disabled'` itself, without calling VIES. Throttled per
 * IP; the VIES answer is cached and deduplicated by ViesService. The
 * address VIES returns is never sent to the browser.
 */
@Controller('storefront')
export class B2bStorefrontController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly taxes: TaxService,
    private readonly b2b: B2bService,
    private readonly exemptions: B2bTaxExemptionService,
  ) {}

  @Post(':slug/b2b/vat-check')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async vatCheck(
    @Param('slug') slug: string,
    @Body() dto: VatCheckDto,
  ): Promise<VatCheckResponse> {
    const store = await this.prisma.store.findUnique({
      where: { slug },
      select: { ...taxStoreSelect, is_active: true },
    });
    if (!store || !store.is_active) {
      throw new NotFoundException({
        code: 'STORE_NOT_FOUND',
        message: 'Store not found',
      });
    }
    const destination = dto.country_code?.trim().toUpperCase() || null;
    const disabled: VatCheckResponse = {
      vat_number: normalizeVatNumber(dto.vat_number),
      country_code: destination,
      status: 'disabled',
      name: null,
      checked_at: null,
      reverse_charge: null,
      why: null,
    };
    if (!(await this.b2b.isEnabled(store.id))) return disabled;
    const settings = await this.b2b.getSettings(store.id);
    if (!settings.reverse_charge_enabled) return disabled;

    const evidence = await this.exemptions.checkVat(
      store.id,
      dto.vat_number,
      'storefront',
    );
    let reverseCharge: boolean | null = null;
    let why = whyOfVatStatus(evidence.status);
    if (destination) {
      const ctx = await this.taxes.contextFor(store);
      const decision = this.exemptions.decide(
        { settings, vat: evidence, customerExemption: null },
        ctx,
        destination,
        'COMPANY',
      );
      reverseCharge = decision.reason === 'REVERSE_CHARGE';
      why = decision.reason ? null : decision.why;
    }
    return {
      vat_number: evidence.vat_number,
      country_code: destination,
      status: evidence.status,
      name: evidence.valid ? evidence.name : null,
      checked_at: evidence.checked_at,
      reverse_charge: reverseCharge,
      why,
    };
  }
}
