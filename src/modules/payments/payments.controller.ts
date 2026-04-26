import { Controller, Get, Post, Body, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { PaymentsService } from './payments.service';
import { CreatePaymentIntentDto } from './dto/payments.dto';

@Controller('payments')
export class PaymentsController {
  constructor(private paymentsService: PaymentsService) {}

  // Public - frontend checks if Stripe is available
  @Get('config')
  getConfig() {
    return {
      stripeConfigured: this.paymentsService.isStripeConfigured(),
      publishableKey: this.paymentsService.getPublishableKey(),
    };
  }

  // Authenticated - create a PaymentIntent for Stripe checkout
  @Post('create-intent')
  @UseGuards(AuthGuard('jwt'))
  async createIntent(@Body() dto: CreatePaymentIntentDto) {
    const { clientSecret, paymentIntentId } =
      await this.paymentsService.createPaymentIntent(
        dto.amount,
        dto.currency || 'EUR',
        dto.order_id ? { order_id: dto.order_id } : undefined,
      );

    return { clientSecret, paymentIntentId };
  }
}
