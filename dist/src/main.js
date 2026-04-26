"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const core_1 = require("@nestjs/core");
const common_1 = require("@nestjs/common");
const path_1 = require("path");
const app_module_1 = require("./app.module");
const http_exception_filter_1 = require("./common/filters/http-exception.filter");
const transform_interceptor_1 = require("./common/interceptors/transform.interceptor");
const logging_interceptor_1 = require("./common/interceptors/logging.interceptor");
async function bootstrap() {
    const app = await core_1.NestFactory.create(app_module_1.AppModule);
    app.useStaticAssets((0, path_1.join)(process.cwd(), 'uploads'), { prefix: '/uploads/' });
    app.setGlobalPrefix('api');
    app.useGlobalInterceptors(new logging_interceptor_1.LoggingInterceptor(), new transform_interceptor_1.TransformInterceptor());
    app.useGlobalPipes(new common_1.ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
    }));
    app.useGlobalFilters(new http_exception_filter_1.AllExceptionsFilter());
    app.enableCors({
        origin: (origin, callback) => {
            if (!origin)
                return callback(null, true);
            if (origin.startsWith('http://localhost:'))
                return callback(null, true);
            callback(null, true);
        },
        credentials: true,
    });
    const port = process.env.PORT || 3001;
    await app.listen(port);
    console.log(`API running on http://localhost:${port}/api`);
}
bootstrap();
//# sourceMappingURL=main.js.map