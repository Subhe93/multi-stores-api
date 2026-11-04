import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators';
import { AuthService } from './auth.service';
import { TwoFactorService } from '../security/two-factor.service';
import {
  TwoFactorConfirmDto,
  TwoFactorEnableDto,
  TwoFactorLoginDto,
  TwoFactorSetupDto,
} from '../security/dto/security.dto';
import { ReqMeta, type RequestMeta } from '../security/request-meta';
import { RefreshCookieInterceptor } from './refresh-cookie';

// Contract: plans/security-hardening/API-CONTRACT.md
@Controller('auth/2fa')
@UseInterceptors(RefreshCookieInterceptor)
@Throttle({ default: { limit: 10, ttl: 60000 } })
export class TwoFactorController {
  constructor(
    private readonly auth: AuthService,
    private readonly twoFactor: TwoFactorService,
  ) {}

  // Public: second sign-in step after a password or magic-link login.
  @Post('verify-login')
  @HttpCode(HttpStatus.OK)
  verifyLogin(@Body() dto: TwoFactorLoginDto, @ReqMeta() meta: RequestMeta) {
    return this.auth.verifyTwoFactorLogin(dto.challenge_token, dto.code, meta);
  }

  @Get()
  @UseGuards(AuthGuard('jwt'))
  status(@CurrentUser('id') userId: string) {
    return this.twoFactor.status(userId);
  }

  @Post('setup')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard('jwt'))
  setup(
    @CurrentUser('id') userId: string,
    @Body() dto: TwoFactorSetupDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.twoFactor.beginSetup(userId, dto.current_password, meta);
  }

  @Post('enable')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard('jwt'))
  async enable(
    @CurrentUser('id') userId: string,
    @Body() dto: TwoFactorEnableDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    const { recovery_codes, user } = await this.twoFactor.enable(
      userId,
      dto.code,
      meta,
    );
    // Older tokens were just revoked; hand this session a fresh pair.
    const tokens = await this.auth.issueTokens(user);
    return { recovery_codes, ...tokens };
  }

  @Post('disable')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard('jwt'))
  disable(
    @CurrentUser('id') userId: string,
    @Body() dto: TwoFactorConfirmDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.twoFactor.disable(userId, dto.current_password, dto.code, meta);
  }

  @Post('recovery-codes')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard('jwt'))
  regenerate(
    @CurrentUser('id') userId: string,
    @Body() dto: TwoFactorConfirmDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.twoFactor.regenerateRecoveryCodes(
      userId,
      dto.current_password,
      dto.code,
      meta,
    );
  }
}
