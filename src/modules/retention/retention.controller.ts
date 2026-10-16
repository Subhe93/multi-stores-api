import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { UserRole } from '@prisma/client';
import { Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import {
  RetentionService,
  UnknownRetentionTaskError,
} from './retention.service';

/**
 * Admin trigger for the retention job (cron-safe): runs the same tasks as
 * the hourly scheduler, under the same lock.
 */
@Controller('admin/retention')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.ADMIN)
export class RetentionController {
  constructor(private readonly retention: RetentionService) {}

  @Get('tasks')
  tasks() {
    return { tasks: this.retention.taskKeys() };
  }

  /** `POST /admin/retention/run?dry_run=1&task=<key>&limit=<n>` */
  @Post('run')
  @HttpCode(200)
  async run(
    @Query('dry_run') dryRun?: string,
    @Query('task') task?: string,
    @Query('limit') limit?: string,
  ) {
    const dry = dryRun === '1' || dryRun === 'true';
    let parsedLimit: number | undefined;
    if (limit !== undefined && limit !== '') {
      parsedLimit = Number(limit);
      if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
        throw new BadRequestException({
          code: 'RETENTION_INVALID_LIMIT',
          message: 'limit must be a positive integer',
        });
      }
    }
    try {
      const outcome = await this.retention.run(new Date(), {
        dryRun: dry,
        task: task || undefined,
        limit: parsedLimit,
      });
      return { ...outcome, dry_run: dry };
    } catch (e) {
      if (e instanceof UnknownRetentionTaskError) {
        throw new BadRequestException({
          code: 'RETENTION_TASK_UNKNOWN',
          message: e.message,
          params: { task: e.task },
        });
      }
      throw e;
    }
  }
}
