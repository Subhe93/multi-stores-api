import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

/** PUT production/my/checks/:checkId — set (not toggle) one check. */
export class SetCheckDto {
  @IsBoolean()
  done!: boolean;
}

/** POST production/my/orders/:orderId/bulk — the whole order, or one line. */
export class BulkCheckDto {
  @IsOptional()
  @IsUUID()
  order_item_id?: string;

  @IsBoolean()
  done!: boolean;
}

/** POST production/my/orders/:orderId/items/:itemId/checks. */
export class AddCustomCheckDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  label!: string;
}

/** GET production/my/summaries?order_ids=a,b,c (≤ 50 UUIDs). */
export class SummariesQueryDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : value,
  )
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  order_ids!: string[];
}
