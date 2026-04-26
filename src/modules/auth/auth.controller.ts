import {
  Controller,
  Post,
  Put,
  Get,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { RegisterDto, LoginDto, ChangePasswordDto } from './dto';
import { CurrentUser } from '../../common/decorators';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Body('refresh_token') refreshToken: string) {
    return this.authService.refreshToken(refreshToken);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard('jwt'))
  logout(
    @CurrentUser('id') userId: string,
    @Body('refresh_token') refreshToken: string,
  ) {
    return this.authService.logout(userId, refreshToken);
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  forgotPassword(@Body('email') email: string) {
    return this.authService.forgotPassword(email);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  resetPassword(
    @Body('token') token: string,
    @Body('password') password: string,
  ) {
    return this.authService.resetPassword(token, password);
  }

  @Put('change-password')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard('jwt'))
  changePassword(
    @CurrentUser('id') userId: string,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.authService.changePassword(userId, dto.current_password, dto.new_password);
  }

  @Get('me')
  @UseGuards(AuthGuard('jwt'))
  getProfile(@CurrentUser('id') userId: string) {
    return this.authService.getProfile(userId);
  }
}
