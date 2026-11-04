import {
  Controller,
  Post,
  Put,
  Get,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  Req,
  Res,
  UseInterceptors,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  clearRefreshCookie,
  readRefreshCookie,
  RefreshCookieInterceptor,
} from './refresh-cookie';
import { clientIp } from '../../common/security/signup-rate-limit';
import { AuthGuard } from '@nestjs/passport';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import {
  RegisterDto,
  LoginDto,
  ChangePasswordDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  MagicLoginDto,
  GuestRegisterDto,
  VerifyEmailDto,
} from './dto';
import { CurrentUser } from '../../common/decorators';

@Controller('auth')
@UseInterceptors(RefreshCookieInterceptor)
export class AuthController {
  constructor(private authService: AuthService) {}

  // Tighter than the global default: these are the credential-stuffing and
  // mass-signup targets, and the checkout auto-registers guests through them.
  // Staff sign-ups are additionally capped at 5 per IP per hour inside the
  // service (SPEC §2), so storefront customers behind one NAT are not.
  @Post('register')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  register(@Body() dto: RegisterDto, @Req() req: Request) {
    return this.authService.register(dto, { ip: clientIp(req) });
  }

  // Email verification link (dashboard /auth/verify#token=): activates a
  // PENDING account and returns a session. 401 EMAIL_VERIFY_INVALID.
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  verifyEmail(@Body() dto: VerifyEmailDto) {
    return this.authService.verifyEmail(dto.token);
  }

  // New verification link for a PENDING account (3/hour/user in the service).
  @Post('resend-verification')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard('jwt'))
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  resendVerification(@CurrentUser('id') userId: string) {
    return this.authService.resendVerification(userId);
  }

  // Storefront guest checkout: the server generates the password and mails
  // it with a magic login link. Same body as register.
  @Post('guest-register')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  guestRegister(@Body() dto: GuestRegisterDto, @Req() req: Request) {
    return this.authService.guestRegister(dto, { ip: clientIp(req) });
  }

  // One-click login from an emailed link; same body as login.
  @Post('magic-login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  magicLogin(@Body() dto: MagicLoginDto) {
    return this.authService.magicLogin(dto.token, {
      store_slug: dto.store_slug,
      hostname: dto.hostname,
    });
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Body('refresh_token') refreshToken: string, @Req() req: Request) {
    // Body token (storefronts, old dashboard tabs) or the httpOnly cookie
    // (dashboard, origin-checked in readRefreshCookie).
    return this.authService.refreshToken(
      refreshToken || readRefreshCookie(req) || '',
    );
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard('jwt'))
  logout(
    @CurrentUser('id') userId: string,
    @Body('refresh_token') refreshToken: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const cookieToken = readRefreshCookie(req);
    if (cookieToken) clearRefreshCookie(req, res);
    return this.authService.logout(
      userId,
      refreshToken || cookieToken || undefined,
    );
  }

  // Rate-limited to curb user-enumeration timing probes and email-bombing.
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(
      dto.email,
      dto.store_slug,
      dto.hostname,
    );
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto.token, dto.password);
  }

  @Put('change-password')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard('jwt'))
  changePassword(
    @CurrentUser('id') userId: string,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.authService.changePassword(
      userId,
      dto.current_password,
      dto.new_password,
    );
  }

  @Get('me')
  @UseGuards(AuthGuard('jwt'))
  getProfile(@CurrentUser('id') userId: string) {
    return this.authService.getProfile(userId);
  }
}
