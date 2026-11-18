import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { GuestOrderTokenService } from './guest-order-token.service';
import { GuestOrderGuard } from './guest-order.guard';

// Guest order token (sign / verify) and its guard, for the orders and the
// payments modules. The secret is passed per call (rotation aware), so the
// JwtModule carries no options. ConfigModule and PrismaModule are global.
@Module({
  imports: [JwtModule.register({})],
  providers: [GuestOrderTokenService, GuestOrderGuard],
  exports: [GuestOrderTokenService, GuestOrderGuard],
})
export class GuestOrderTokenModule {}
