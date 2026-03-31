import { Request, Response, NextFunction } from "express";
export declare const securityHeaders: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, next: (err?: unknown) => void) => void;
export declare const generalLimiter: import("express-rate-limit").RateLimitRequestHandler;
export declare const registrationLimiter: import("express-rate-limit").RateLimitRequestHandler;
export declare const jsonRpcLimiter: import("express-rate-limit").RateLimitRequestHandler;
export declare const searchLimiter: import("express-rate-limit").RateLimitRequestHandler;
export declare function sanitizeInput(req: Request, _res: Response, next: NextFunction): void;
export declare const MAX_REQUEST_SIZE = "50kb";
export declare function requireApiKey(req: Request, res: Response, next: NextFunction): void;
export declare const corsOptions: {
    origin: string;
    methods: string[];
    allowedHeaders: string[];
    maxAge: number;
};
//# sourceMappingURL=security.d.ts.map