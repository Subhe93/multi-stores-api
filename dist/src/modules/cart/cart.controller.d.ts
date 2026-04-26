import { CartService } from './cart.service';
import { AddCartItemDto, UpdateCartItemDto } from './dto/cart.dto';
export declare class CartController {
    private cartService;
    constructor(cartService: CartService);
    getCart(userId: string): Promise<{
        id: string | undefined;
        items: any[];
    }>;
    addItem(userId: string, dto: AddCartItemDto): Promise<{
        id: string | undefined;
        items: any[];
    }>;
    updateItem(userId: string, itemId: string, dto: UpdateCartItemDto): Promise<{
        id: string | undefined;
        items: any[];
    }>;
    removeItem(userId: string, itemId: string): Promise<{
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
