import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { CustomProductsService } from './custom-products.service';
import { CreateCustomProductDto, UpdateCustomProductDto } from './dto/custom-product.dto';
import { CurrentUser, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '@prisma/client';
import { IsString, IsOptional, IsArray, ValidateNested, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';

class FaqTranslationDto {
  @IsString() locale: string;
  @IsString() question: string;
  @IsString() answer: string;
}

class CreateCustomProductFaqDto {
  @IsOptional() @IsInt() @Min(0) @Type(() => Number) sort_order?: number;
  @IsArray() @ValidateNested({ each: true }) @Type(() => FaqTranslationDto) translations: FaqTranslationDto[];
}

class UpdateCustomProductFaqDto {
  @IsOptional() @IsInt() @Min(0) @Type(() => Number) sort_order?: number;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => FaqTranslationDto) translations?: FaqTranslationDto[];
}

class RejectCustomProductDto {
  @IsString() reason: string;
}

@Controller('custom-products')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.CREATOR)
export class CustomProductsController {
  constructor(private customProductsService: CustomProductsService) {}

  @Post()
  create(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateCustomProductDto,
  ) {
    return this.customProductsService.create(userId, dto);
  }

  @Get()
  findMyCustomProducts(
    @CurrentUser('id') userId: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.customProductsService.findByCreator(
      userId,
      page ? +page : undefined,
      limit ? +limit : undefined,
    );
  }

  // Slug availability check across this creator's products + custom products.
  // Must come before @Get(':id') so the static path matches first.
  @Get('check-slug')
  checkSlug(
    @CurrentUser('id') userId: string,
    @Query('slug') slug: string,
    @Query('exclude_id') excludeId?: string,
  ) {
    return this.customProductsService.checkSlug(userId, slug, excludeId);
  }

  // ── Provider review endpoints (PROVIDER role) ─────────────
  // NOTE: This must come BEFORE @Get(':id') so the static path matches first.
  @Get('pending-reviews')
  @Roles(UserRole.PROVIDER)
  pendingReviews(
    @CurrentUser('id') userId: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.customProductsService.findPendingReviewsForProvider(
      userId,
      page ? +page : undefined,
      limit ? +limit : undefined,
    );
  }

  @Get(':id')
  @Roles(UserRole.CREATOR, UserRole.PROVIDER)
  findById(@Param('id') id: string) {
    return this.customProductsService.findById(id);
  }

  @Put(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateCustomProductDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.customProductsService.update(id, dto, userId);
  }

  @Delete(':id')
  delete(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.customProductsService.delete(id, userId);
  }

  @Post(':id/duplicate')
  duplicate(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.customProductsService.duplicate(id, userId);
  }

  // Creator submits for review (or auto-publish if no provider)
  @Post(':id/submit')
  submit(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.customProductsService.submitForReview(id, userId);
  }

  // Provider approves
  @Post(':id/approve')
  @Roles(UserRole.PROVIDER)
  approve(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.customProductsService.approve(id, userId);
  }

  // Provider rejects with reason
  @Post(':id/reject')
  @Roles(UserRole.PROVIDER)
  reject(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body() dto: RejectCustomProductDto,
  ) {
    return this.customProductsService.reject(id, userId, dto.reason);
  }

  // ── FAQs ────────────────────────────────────────────────

  @Get(':id/faqs')
  listFaqs(@Param('id') id: string) {
    return this.customProductsService.findFaqs(id);
  }

  @Post(':id/faqs')
  createFaq(@Param('id') id: string, @Body() dto: CreateCustomProductFaqDto) {
    return this.customProductsService.createFaq(id, dto);
  }

  @Put('faqs/:faqId')
  updateFaq(@Param('faqId') faqId: string, @Body() dto: UpdateCustomProductFaqDto) {
    return this.customProductsService.updateFaq(faqId, dto);
  }

  @Delete('faqs/:faqId')
  deleteFaq(@Param('faqId') faqId: string) {
    return this.customProductsService.deleteFaq(faqId);
  }
}
