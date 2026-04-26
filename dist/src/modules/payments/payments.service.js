"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PaymentsService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const stripe_1 = __importDefault(require("stripe"));
let PaymentsService = class PaymentsService {
    config;
    stripe = null;
    constructor(config) {
        this.config = config;
        const secretKey = this.config.get('STRIPE_SECRET_KEY');
        if (secretKey) {
            this.stripe = new stripe_1.default(secretKey);
        }
    }
    isStripeConfigured() {
        return this.stripe !== null;
    }
    getPublishableKey() {
        return this.config.get('STRIPE_PUBLISHABLE_KEY') || null;
    }
    async createPaymentIntent(amount, currency, metadata) {
        if (!this.stripe) {
            throw new common_1.BadRequestException('Stripe is not configured');
        }
        const paymentIntent = await this.stripe.paymentIntents.create({
            amount,
            currency: currency.toLowerCase(),
            metadata: metadata || {},
        });
        return {
            clientSecret: paymentIntent.client_secret,
            paymentIntentId: paymentIntent.id,
        };
    }
    async getPaymentIntent(paymentIntentId) {
        if (!this.stripe) {
            throw new common_1.BadRequestException('Stripe is not configured');
        }
        return this.stripe.paymentIntents.retrieve(paymentIntentId);
    }
};
exports.PaymentsService = PaymentsService;
exports.PaymentsService = PaymentsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [config_1.ConfigService])
], PaymentsService);
//# sourceMappingURL=payments.service.js.map