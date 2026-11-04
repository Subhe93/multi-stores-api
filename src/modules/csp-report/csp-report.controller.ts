import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { parseCspReports } from './csp-report.parser';
import { CspReportService } from './csp-report.service';

/**
 * `POST /api/csp-report`: collection point for Content-Security-Policy
 * violation reports from the dashboard and the storefront (`report-uri` and
 * `report-to`). Public by design (browsers send reports without
 * credentials), throttled per IP, always answers 204 and never echoes input.
 */
@Controller('csp-report')
export class CspReportController {
  constructor(private readonly reports: CspReportService) {}

  @Post()
  @HttpCode(204)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  collect(@Body() body: unknown): void {
    this.reports.record(parseCspReports(body));
  }
}
