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

/** Task keys are short slugs; anything else is refused before it is echoed. */
const TASK_KEY_RE = /^[a-z0-9_-]{1,64}$/;

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
    // M5 A16: the task key is echoed in the error body; only a plain slug
    // of bounded length is accepted (never arbitrary query text).
    if (task !== undefined && task !== '' && !TASK_KEY_RE.test(task)) {
      throw new BadRequestException({
        code: 'RETENTION_TASK_UNKNOWN',
        message: 'Unknown retention task',
        params: { task: task.slice(0, 64).replace(/[^a-z0-9_-]/gi, '?') },
      });
    }
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
          message: 'Unknown retention task',
          params: { task: e.task.slice(0, 64) },
        });
      }
      throw e;
    }
  }
}
