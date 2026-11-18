import {
  BadRequestException,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import {
  GUEST_TOKEN_INVALID,
  GuestOrderTokenService,
  type GuestOrderClaims,
} from '../auth/guest-order-token.service';
import { DesignerCartService } from '../designer/designer-cart.service';
import { normalizeOrgNumber } from '../b2b/org-number.util';
import type { PreLiveViewerCheck } from '../../common/stores/store-gate';
import type { TrackingContext } from '../meta-capi/tracking-context';
import { OrdersService } from './orders.service';
import type { CreateOrderDto } from './dto/order.dto';
import type {
  GuestOrderAddressDto,
  GuestOrderDto,
} from './dto/guest-order.dto';
import { forGuest } from './guest-order-view';

/**
 * Guest checkout (POST /orders/guest): one public call that places an order
 * without signing anyone in (the Shopify model).
 *
 * Why it exists: the storefront used to call POST /auth/guest-register for
 * a shopper who did not tick "create an account". That created a real
 * account, mailed its password and logged the shopper in, and it answered
 * 409 for an email that already had an account, which stopped a returning
 * guest at the checkout form.
 *
 * What it does instead:
 * - the customer record is found or created by (store, email) without any
 *   email about an account, magic link or session
 *   (AuthService.resolveGuestOrderCustomer);
 * - an existing customer is never updated, and its cart, profile and
 *   addresses are not read: the order is built from the lines and the
 *   address of the request only;
 * - the answer is the same for a new and for a known email: the guest view
 *   of the order (no `customer` object) plus a token bound to that order,
 *   good only for its payment and confirmation.
 */
@Injectable()
export class GuestOrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly orders: OrdersService,
    private readonly tokens: GuestOrderTokenService,
    // Designer app: verifies the design token of designer lines. Optional
    // like everywhere else; absent = a line with a design is refused by the
    // order path (no design is trusted).
    @Optional() private readonly designerCart?: DesignerCartService,
  ) {}

  async place(
    dto: GuestOrderDto,
    ctx: {
      ip?: string | null;
      preLiveViewer?: PreLiveViewerCheck;
      trackingContext?: TrackingContext | null;
    } = {},
  ) {
    const { store, userId, customerId } =
      await this.auth.resolveGuestOrderCustomer(dto, { ip: ctx.ip });
    // The store the checkout ran on must be the store the order names: the
    // customer record above belongs to the former, the order to the latter.
    if (store.id !== dto.store_id) {
      throw new BadRequestException({
        code: 'GUEST_ORDER_STORE_MISMATCH',
        message: 'The order does not belong to this store.',
      });
    }

    const addressId = await this.addressFor(customerId, dto.address);

    // Designer lines: ownership is proven by the design token only. The
    // customer id is deliberately not passed: knowing an email must not
    // open the designs that account owns, and nothing is claimed for it.
    const verified =
      this.designerCart && dto.lines.some((l) => !!l.design_id)
        ? await this.designerCart.verifySessionDesigns(
            store.id,
            dto.lines.map((l) => ({
              product_id: l.product_id ?? null,
              custom_product_id: l.custom_product_id ?? null,
              variant_id: l.variant_id ?? null,
              design_id: l.design_id ?? null,
              design_token: l.design_token ?? null,
            })),
            null,
          )
        : new Set<string>();

    // A snapshot order skips the pre-checkout release of the customer's own
    // expired unpaid orders (they still hold stock): do it here, so a guest
    // retrying after an abandoned attempt is not blocked by it.
    await this.orders.releaseStaleOrdersOfCustomer(customerId);

    const orderDto: CreateOrderDto = {
      address_id: addressId,
      store_id: dto.store_id,
      ...(dto.payment_method ? { payment_method: dto.payment_method } : {}),
      ...(dto.coupon_code ? { coupon_code: dto.coupon_code } : {}),
      ...(dto.notes ? { notes: dto.notes } : {}),
      ...(dto.shipping_method_id
        ? { shipping_method_id: dto.shipping_method_id }
        : {}),
      ...(dto.market_key ? { market_key: dto.market_key } : {}),
      ...(dto.hostname ? { hostname: dto.hostname } : {}),
      ...(dto.locale ? { locale: dto.locale } : {}),
      ...(dto.buyer_type ? { buyer_type: dto.buyer_type } : {}),
      ...(dto.company ? { company: dto.company } : {}),
      ...(dto.expect_reverse_charge !== undefined
        ? { expect_reverse_charge: dto.expect_reverse_charge }
        : {}),
    };
    const order = await this.orders.create(userId, orderDto, {
      lines: dto.lines,
      guestCheckout: true,
      verifiedDesignIds: [...verified],
      ...(ctx.preLiveViewer ? { preLiveViewer: ctx.preLiveViewer } : {}),
      ...(ctx.trackingContext ? { trackingContext: ctx.trackingContext } : {}),
    });

    const token = await this.tokens.sign({
      userId,
      orderId: (order as { id: string }).id,
      storeId: store.id,
    });
    return { order: forGuest(order), ...token };
  }

  /**
   * GET /orders/guest/:id: the token's own order in the guest view. A
   * different id, an order that is gone or no longer the customer's: the
   * same 401 as any token problem.
   */
  async read(claims: GuestOrderClaims, orderId: string) {
    const invalid = () => new UnauthorizedException(GUEST_TOKEN_INVALID);
    if (!orderId || claims.orderId !== orderId) throw invalid();
    try {
      return forGuest(
        await this.orders.findById(orderId, claims.userId, UserRole.CUSTOMER),
      );
    } catch {
      throw invalid();
    }
  }

  /**
   * The address row of the order: an identical row of this customer is
   * reused (a retry does not pile up copies), else a new one is created.
   * Never the default address, and no existing row is changed.
   */
  private async addressFor(
    customerId: string,
    address: GuestOrderAddressDto,
  ): Promise<string> {
    const text = (value: string | undefined | null) =>
      typeof value === 'string' && value.trim() ? value.trim() : null;
    const country = address.country_code.trim().toUpperCase();
    const org = text(address.org_number);
    const data = {
      customer_id: customerId,
      full_name: address.full_name.trim(),
      line1: address.line1.trim(),
      line2: text(address.line2),
      city: address.city.trim(),
      // Part of the match: the order is taxed from the row's state.
      state: text(address.state),
      postal_code: address.postal_code.trim(),
      country_code: country,
      phone: text(address.phone),
      company_name: text(address.company_name)?.replace(/\s+/g, ' ') ?? null,
      org_number: org ? normalizeOrgNumber(country, org) || null : null,
      buyer_reference: text(address.buyer_reference),
    };
    const existing = await this.prisma.address.findFirst({
      where: data,
      select: { id: true },
    });
    if (existing) return existing.id;
    const created = await this.prisma.address.create({
      data: { ...data, is_default: false },
      select: { id: true },
    });
    return created.id;
  }
}
