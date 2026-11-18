import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { GuestOrderTokenModule } from '../auth/guest-order-token.module';
import { GuestOrderTokenService } from '../auth/guest-order-token.service';
import { GuestOrderGuard } from '../auth/guest-order.guard';
import { StorefrontGateService } from '../storefront/storefront-gate.service';
import { TransferReversalService } from '../payments/transfer-reversal.service';
import { GuestOrderService } from './guest-order.service';
import { OrdersGuestController } from './orders-guest.controller';
import { OrdersService } from './orders.service';

// Dependency injection of the new pieces, resolved by Nest itself (the unit
// specs build them by hand): a provider whose constructor token cannot be
// resolved would only fail when the application boots.

@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: {} },
    { provide: ConfigService, useValue: { get: () => 'secret' } },
  ],
  exports: [PrismaService, ConfigService],
})
class GlobalsStub {}

describe('guest checkout and transfer reversal wiring', () => {
  it('Nest resolves the guest controller, its service, the token module and the guard', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [GlobalsStub, GuestOrderTokenModule],
      controllers: [OrdersGuestController],
      providers: [
        GuestOrderService,
        TransferReversalService,
        { provide: AuthService, useValue: {} },
        { provide: OrdersService, useValue: {} },
        { provide: StorefrontGateService, useValue: {} },
      ],
    }).compile();

    expect(moduleRef.get(OrdersGuestController)).toBeInstanceOf(
      OrdersGuestController,
    );
    expect(moduleRef.get(GuestOrderService)).toBeInstanceOf(GuestOrderService);
    expect(moduleRef.get(TransferReversalService)).toBeInstanceOf(
      TransferReversalService,
    );
    // Exported by the token module, so a controller of the importing module
    // can use the guard.
    const tokens = moduleRef.get(GuestOrderTokenService, { strict: false });
    expect(moduleRef.get(GuestOrderGuard, { strict: false })).toBeInstanceOf(
      GuestOrderGuard,
    );
    // The token module signs with the secret passed per call.
    const signed = await tokens.sign({
      userId: 'u1',
      orderId: 'o1',
      storeId: 's1',
    });
    await expect(tokens.verify(signed.guest_token)).resolves.toMatchObject({
      orderId: 'o1',
    });
    await moduleRef.close();
  });
});
