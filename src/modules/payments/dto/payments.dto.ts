import { IsNumber, IsString, IsOptional } from 'class-validator';

export class CreatePaymentIntentDto {
  @IsNumber()
  amount: number;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsString()
  order_id?: string;
}
