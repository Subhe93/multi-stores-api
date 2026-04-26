import { Controller, Get, Post, Body, UseGuards, Request } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { TranslationsService } from './translations.service';
import { AutoTranslateDto, BulkTranslateDto } from './dto/translation.dto';
import { Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '@prisma/client';
import { IsString } from 'class-validator';

class TranslateTextDto {
  @IsString()
  text: string;

  @IsString()
  source_locale: string;

  @IsString()
  target_locale: string;
}

@Controller('translations')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.CREATOR, UserRole.ADMIN)
export class TranslationsController {
  constructor(private translationsService: TranslationsService) {}

  // Full overview of translation status for all creator entities
  @Get('overview')
  getOverview(@Request() req: any) {
    return this.translationsService.getOverview(req.user.id);
  }

  // Translate a single entity (reads from DB and saves back)
  @Post('auto-translate')
  autoTranslate(@Body() dto: AutoTranslateDto) {
    return this.translationsService.autoTranslate(dto);
  }

  // Bulk translate all entities of given types for a store
  @Post('bulk-translate')
  bulkTranslate(@Body() dto: BulkTranslateDto) {
    return this.translationsService.bulkTranslate(dto);
  }

  // Translate raw text — used by dashboard forms before entity is saved
  @Post('translate-text')
  translateText(@Body() dto: TranslateTextDto) {
    return this.translationsService.translateSingleText(
      dto.text,
      dto.source_locale,
      dto.target_locale,
    );
  }
}
