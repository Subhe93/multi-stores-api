import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { SecurityAuditService } from './security-audit.service';
import { TwoFactorService } from './two-factor.service';
import { ReauthService } from './reauth.service';
import { SecurityEventsController } from './security-events.controller';
import { PaymentKeysGuardService } from './payment-keys-guard.service';
import { MagicLinkModule } from '../auth/magic-link.module';

// Global so payments, auth and future modules (restricted Stripe keys) can
// inject ReauthService / SecurityAuditService without re-importing.
@Global()
@Module({
  // Secrets are passed per call (sign/verify), so no default config here.
  imports: [JwtModule.register({}), MagicLinkModule],
  controllers: [SecurityEventsController],
  providers: [
    SecurityAuditService,
    TwoFactorService,
    ReauthService,
    PaymentKeysGuardService,
  ],
  exports: [
    SecurityAuditService,
    TwoFactorService,
    ReauthService,
    PaymentKeysGuardService,
  ],
})
export class SecurityModule {}
