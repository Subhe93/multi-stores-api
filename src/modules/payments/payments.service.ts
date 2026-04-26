import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

@Injectable()
export class PaymentsService {
  private stripe: InstanceType<typeof Stripe> | null = null;

  constructor(private config: ConfigService) {
    const secretKey = this.config.get<string>('STRIPE_SECRET_KEY');
    if (secretKey) {
      this.stripe = new Stripe(secretKey);
    }
  }

  isStripeConfigured(): boolean {
    return this.stripe !== null;
  }

  getPublishableKey(): string | null {
    return this.config.get<string>('STRIPE_PUBLISHABLE_KEY') || null;
  }

  async createPaymentIntent(
    amount: number,
    currency: string,
    metadata?: Record<string, string>,
  ): Promise<{ clientSecret: string; paymentIntentId: string }> {
    if (!this.stripe) {
      throw new BadRequestException('Stripe is not configured');
    }

    const paymentIntent = await this.stripe.paymentIntents.create({
      amount,
      currency: currency.toLowerCase(),
      metadata: metadata || {},
    });

    return {
      clientSecret: paymentIntent.client_secret!,
      paymentIntentId: paymentIntent.id,
    };
  }

  async getPaymentIntent(paymentIntentId: string) {
    if (!this.stripe) {
      throw new BadRequestException('Stripe is not configured');
    }

    return this.stripe.paymentIntents.retrieve(paymentIntentId);
  }
}
