import { UploadsService } from './uploads.service';
export declare class UploadsController {
    private uploadsService;
    constructor(uploadsService: UploadsService);
    upload(file: Express.Multer.File, folder?: string): Promise<{
        url: string;
        file_type: string;
        file_size: number;
    }>;
    delete(fileUrl: string): Promise<void>;
}
