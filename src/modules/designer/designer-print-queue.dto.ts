import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { DesignPrintStatus } from '@prisma/client';

/** Query of `GET designer/my/print-queue`. */
export class PrintQueueQueryDto {
  @IsOptional()
  @IsIn(Object.values(DesignPrintStatus))
  status?: DesignPrintStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
