import { PrismaService } from '../../prisma/prisma.service';
import { AddCartItemDto, UpdateCartItemDto } from './dto/cart.dto';
export declare class CartService {
    private prisma;
    constructor(prisma: PrismaService);
    private getOrCreateCart;
    private pickTranslation;
    private enrichCartItems;
    private validateBundleOffer;
    private assertBundleQuantityValid;
    getCart(userId: string, locale?: string): Promise<{
        id: string | undefined;
        items: any[];
    }>;
    addItem(userId: string, dto: AddCartItemDto, locale?: string): Promise<{
        id: string | undefined;
        items: any[];
    }>;
    updateItem(userId: string, itemId: string, dto: UpdateCartItemDto, locale?: string): Promise<{
        id: string | undefined;
        items: any[];
    }>;
    removeItem(userId: string, itemId: string, locale?: string): Promise<{
        id: string | undefined;
        items: any[];
    }>;
    clearCart(userId: string): Promise<{
        message: string;
    }>;
    applyCoupon(userId: string, couponCode: string): Promise<{
        cart_id: string;
        coupon_code: string;
        message: string;
    }>;
    removeCoupon(userId: string): Promise<{
        message: string;
    }>;
}
