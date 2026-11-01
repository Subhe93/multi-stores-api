import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { IsBuyerType } from '../../b2b/dto/b2b.dto';
import type { BuyerType } from '../../b2b/b2b.types';

/** Sort keys of the customers list. */
export const CUSTOMER_SORT_KEYS = [
  'name',
  'email',
  'orders_count',
  'total_spent',
  'last_order_at',
  'created_at',
] as const;
export type CustomerSortKey = (typeof CUSTOMER_SORT_KEYS)[number];

/**
 * Statuses a store owner may set. BANNED is reserved for the platform admin
 * (users admin), and a BANNED customer cannot be changed by the owner.
 */
export const CUSTOMER_SETTABLE_STATUSES = ['ACTIVE', 'SUSPENDED'] as const;
export type CustomerSettableStatus =
  (typeof CUSTOMER_SETTABLE_STATUSES)[number];

export const CUSTOMER_BULK_ACTIONS = [
  'block',
  'unblock',
  'send-login-link',
] as const;
export type CustomerBulkAction = (typeof CUSTOMER_BULK_ACTIONS)[number];

/** YYYY-MM-DD or a full ISO-8601 instant. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}([T ][0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;

const trimmed = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** Query of the list and the CSV export (same filters). */
export class ListCustomersQueryDto {
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

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(trimmed)
  search?: string;

  @IsOptional()
  @IsIn(CUSTOMER_SORT_KEYS as readonly string[])
  sort?: CustomerSortKey;

  @IsOptional()
  @IsIn(['asc', 'desc'])
  dir?: 'asc' | 'desc';

  /** 'true' = at least one counted order in the store, 'false' = none. */
  @IsOptional()
  @IsIn(['true', 'false'])
  has_orders?: 'true' | 'false';

  @IsOptional()
  @IsBuyerType()
  customer_type?: BuyerType;

  @IsOptional()
  @IsIn(['PENDING', 'ACTIVE', 'SUSPENDED', 'BANNED'])
  status?: string;

  /** Account created on or after (YYYY-MM-DD = start of that UTC day). */
  @IsOptional()
  @Matches(DATE_RE, { message: 'from must be YYYY-MM-DD or ISO-8601' })
  from?: string;

  /** Account created on or before (YYYY-MM-DD = the whole UTC day). */
  @IsOptional()
  @Matches(DATE_RE, { message: 'to must be YYYY-MM-DD or ISO-8601' })
  to?: string;
}

/** Admin list: the same filters plus an optional store. */
export class AdminListCustomersQueryDto extends ListCustomersQueryDto {
  @IsOptional()
  @IsUUID()
  store_id?: string;
}

export class CreateStoreCustomerDto {
  @IsEmail()
  @MaxLength(254)
  @Transform(trimmed)
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  @Transform(trimmed)
  first_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  @Transform(trimmed)
  last_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  @Transform(trimmed)
  phone?: string;

  /** Mail the password + a one-click login link (default true). */
  @IsOptional()
  @IsBoolean()
  send_credentials?: boolean;

  /** Language of that email; the store's primary locale when absent. */
  @IsOptional()
  @IsString()
  @Matches(/^[a-z]{2}$/i)
  locale?: string;
}

export class AdminCreateCustomerDto extends CreateStoreCustomerDto {
  @IsUUID()
  store_id!: string;
}

export class UpdateStoreCustomerDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  @Transform(trimmed)
  first_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  @Transform(trimmed)
  last_name?: string;

  /** `null` or '' clears it. */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  @Transform(trimmed)
  phone?: string | null;

  @IsOptional()
  @IsBuyerType()
  customer_type?: BuyerType | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  company_name?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  org_number?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  vat_number?: string | null;
}

export class UpdateCustomerStatusDto {
  @IsIn(CUSTOMER_SETTABLE_STATUSES as readonly string[])
  status!: CustomerSettableStatus;
}

export class BulkCustomersDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsUUID('all', { each: true })
  ids!: string[];

  @IsIn(CUSTOMER_BULK_ACTIONS as readonly string[])
  action!: CustomerBulkAction;
}
