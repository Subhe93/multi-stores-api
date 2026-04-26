import { BlockType } from '@prisma/client';
export declare class BlockTranslationDto {
    locale: string;
    content: any;
}
export declare class CreateBlockDto {
    type: BlockType;
    settings?: any;
    sort_order?: number;
    translations?: BlockTranslationDto[];
}
export declare class UpdateBlockDto {
    settings?: any;
    sort_order?: number;
    translations?: BlockTranslationDto[];
}
