import { PrismaService } from '../../prisma/prisma.service';
import { CreateProductFaqDto, UpdateProductFaqDto } from './dto/product-faq.dto';
export declare class ProductFaqsService {
    private prisma;
    constructor(prisma: PrismaService);
    create(productId: string, dto: CreateProductFaqDto): Promise<{
        translations: {
            id: string;
            locale: string;
            faq_id: string;
            question: string;
            answer: string;
        }[];
    } & {
        id: string;
        sort_order: number;
        product_id: string;
    }>;
    findByProduct(productId: string): Promise<({
        translations: {
            id: string;
            locale: string;
            faq_id: string;
            question: string;
            answer: string;
        }[];
    } & {
        id: string;
        sort_order: number;
        product_id: string;
    })[]>;
    update(id: string, dto: UpdateProductFaqDto): Promise<{
        translations: {
            id: string;
            locale: string;
            faq_id: string;
            question: string;
            answer: string;
        }[];
    } & {
        id: string;
        sort_order: number;
        product_id: string;
    }>;
    delete(id: string): Promise<{
        id: string;
        sort_order: number;
        product_id: string;
    }>;
    reorder(productId: string, faqIds: string[]): Promise<({
        translations: {
            id: string;
            locale: string;
            faq_id: string;
            question: string;
            answer: string;
        }[];
    } & {
        id: string;
        sort_order: number;
        product_id: string;
    })[]>;
}
