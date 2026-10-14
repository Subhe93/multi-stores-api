import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { StoreDomainStatus, UserRole } from '@prisma/client';
import { Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { FxService } from './fx.service';
import { DomainsService } from './domains.service';
import { SetDomainStatusDto, UpsertFxRatesDto } from './dto/market.dto';

// Admin side of the markets app: the platform FX table (L3) and the domain
// activation step (L6). Registered before the creator controller so the
// literal "admin" segment is never swallowed by ":id".
@Controller('markets/admin')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.ADMIN)
export class MarketsAdminController {
  constructor(
    private readonly fx: FxService,
    private readonly domains: DomainsService,
  ) {}

  @Get('fx-rates')
  listFxRates() {
    return this.fx.listRates();
  }

  @Put('fx-rates')
  upsertFxRates(@Body() dto: UpsertFxRatesDto) {
    return this.fx.upsertRates(dto.rates);
  }

  // Remove one rate; answers the refreshed list.
  @Delete('fx-rates/:base/:quote')
  deleteFxRate(@Param('base') base: string, @Param('quote') quote: string) {
    return this.fx.deleteRate(base, quote);
  }

  // Every domain of a creator's store (all markets), for the activation page.
  @Get('stores/by-creator/:creatorId/domains')
  listDomainsByCreator(@Param('creatorId') creatorId: string) {
    return this.domains.adminListByCreator(creatorId);
  }

  // Promote a verified hostname to ACTIVE (or back) after the CDN step.
  @Put('domains/:id/status')
  setDomainStatus(@Param('id') id: string, @Body() dto: SetDomainStatusDto) {
    return this.domains.adminSetStatus(id, dto.status as StoreDomainStatus);
  }
}
