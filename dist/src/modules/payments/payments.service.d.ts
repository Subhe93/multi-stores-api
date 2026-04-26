import { ConfigService } from '@nestjs/config';
export declare class PaymentsService {
    private config;
    private stripe;
    constructor(config: ConfigService);
    isStripeConfigured(): boolean;
    getPublishableKey(): string | null;
    createPaymentIntent(amount: number, currency: string, metadata?: Record<string, string>): Promise<{
        clientSecret: string;
        paymentIntentId: string;
    }>;
    getPaymentIntent(paymentIntentId: string): Promise<import("node_modules/stripe/cjs/lib").Response<import("node_modules/stripe/cjs/resources/PaymentIntents").PaymentIntent>>;
}
