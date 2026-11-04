import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { cspReportBodyParser } from './csp-report.body-parser';
import { CspReportController } from './csp-report.controller';
import { CspReportService } from './csp-report.service';

/**
 * CSP violation report collection (security audit M6). Reports are
 * aggregated in memory and flushed to the `CspReport` logger; no table.
 */
@Module({
  controllers: [CspReportController],
  providers: [CspReportService],
})
export class CspReportModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(cspReportBodyParser).forRoutes(CspReportController);
  }
}
