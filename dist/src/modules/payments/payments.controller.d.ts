import { PaymentsService } from './payments.service';
import { CreatePaymentIntentDto } from './dto/payments.dto';
export declare class PaymentsController {
    private paymentsService;
    constructor(paymentsService: PaymentsService);
    getConfig(): {
        stripeConfigured: boolean;
        publishableKey: string | null;
    };
    createIntent(dto: CreatePaymentIntentDto): Promise<{
        clientSecret: string;
        paymentIntentId: string;
    }>;
}
