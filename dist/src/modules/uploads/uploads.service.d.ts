export declare class UploadsService {
    private readonly uploadDir;
    constructor();
    uploadFile(file: Express.Multer.File, folder?: string): Promise<{
        url: string;
        file_type: string;
        file_size: number;
    }>;
    private processImage;
    deleteFile(fileUrl: string): Promise<void>;
}
