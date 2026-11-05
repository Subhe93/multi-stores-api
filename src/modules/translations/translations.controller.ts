import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  Request,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { TranslationsService } from './translations.service';
import { AutoTranslateDto, BulkTranslateDto } from './dto/translation.dto';
import { Roles } from '../../common/decorators';
import type { RequestUser } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '@prisma/client';
import { IsIn, IsString, MaxLength } from 'class-validator';
import { Throttle } from '@nestjs/throttler';
import { UserThrottlerGuard } from '../../common/guards/user-throttler.guard';
import { SUPPORTED_LOCALES } from '../markets/market.types';

export class TranslateTextDto {
  // Long texts are split into provider-sized chunks by the service; the cap
  // bounds the provider quota one request can burn (store descriptions and
  // FAQ answers go through here, so it stays above a short field's size).
  @IsString()
  @MaxLength(5000)
  text: string;

  @IsIn(SUPPORTED_LOCALES)
  source_locale: string;

  @IsIn(SUPPORTED_LOCALES)
  target_locale: string;
}

@Controller('translations')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.CREATOR, UserRole.ADMIN)
export class TranslationsController {
  constructor(private translationsService: TranslationsService) {}

  // Full overview of translation status for all creator entities
  @Get('overview')
  getOverview(@Request() req: { user: RequestUser }) {
    return this.translationsService.getOverview(req.user.id);
  }

  // Translate a single entity (reads from DB and saves back)
  @Post('auto-translate')
  autoTranslate(
    @Body() dto: AutoTranslateDto,
    @Request() req: { user: RequestUser },
  ) {
    return this.translationsService.autoTranslate(
      dto,
      req.user.id,
      req.user.role,
    );
  }

  // Bulk translate all entities of given types for a store
  @Post('bulk-translate')
  bulkTranslate(
    @Body() dto: BulkTranslateDto,
    @Request() req: { user: RequestUser },
  ) {
    return this.translationsService.bulkTranslate(
      dto,
      req.user.id,
      req.user.role,
    );
  }

  // Translate raw text — used by dashboard forms before entity is saved.
  // Providers edit base-product content in every platform locale, so they may
  // use it too. It is stateless (no store data is read or written) and stays
  // under its own throttle; the other routes remain CREATOR/ADMIN.
  // The page builder's "translate page" fires one call per field (a small
  // pool), so the budget is per signed-in user (UserThrottlerGuard runs after
  // the JWT guard) and sized for a page; the global IP guard applies the same
  // limit per IP.
  @Post('translate-text')
  @Roles(UserRole.CREATOR, UserRole.ADMIN, UserRole.PROVIDER)
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @UseGuards(UserThrottlerGuard)
  translateText(@Body() dto: TranslateTextDto) {
    return this.translationsService.translateSingleText(
      dto.text,
      dto.source_locale,
      dto.target_locale,
    );
  }
}
