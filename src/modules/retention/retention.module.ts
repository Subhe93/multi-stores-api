import { Global, Module } from '@nestjs/common';
import { RetentionController } from './retention.controller';
import { RetentionScheduler } from './retention.scheduler';
import { RetentionService } from './retention.service';

/**
 * Generic retention job (M4.5 C22). Global so any module can register a task
 * with `RetentionService.registerTask` from its `onModuleInit`.
 */
@Global()
@Module({
  controllers: [RetentionController],
  providers: [RetentionService, RetentionScheduler],
  exports: [RetentionService],
})
export class RetentionModule {}
