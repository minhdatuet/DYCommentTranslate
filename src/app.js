import express from "express";

import { config } from "./config.js";
import { DouyinService } from "./services/douyinService.js";
import { GeminiTranslator } from "./services/geminiTranslator.js";
import { JustOneApiDouyinService } from "./services/justOneApiDouyinService.js";
import { OfflineTranslator } from "./services/offlineTranslator.js";
import { StvTranslator } from "./services/stvTranslator.js";
import { TranslationService } from "./services/translationService.js";

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 phút

const app = express();
const douyinService = new DouyinService();
const justOneApiService = new JustOneApiDouyinService();
const offlineTranslator = new OfflineTranslator(config.offlineDictDir);
const geminiTranslator = new GeminiTranslator();
const stvTranslator = new StvTranslator();
const translationService = new TranslationService(offlineTranslator, geminiTranslator, stvTranslator);

// Cache comment đã crawl theo videoId, tránh mở browser lại khi "Tải thêm"
const commentCache = new Map();

function IsAdminRequest(request)
{
    if (!config.douyinAdminToken)
    {
        return config.nodeEnv !== "production";
    }

    const headerToken = String(request.get("x-admin-token") ?? "").trim();
    const authorization = String(request.get("authorization") ?? "").trim();
    const bearerToken = authorization.toLowerCase().startsWith("bearer ")
        ? authorization.slice("bearer ".length).trim()
        : "";

    return headerToken === config.douyinAdminToken || bearerToken === config.douyinAdminToken;
}

function RejectAdminRequest(response)
{
    response.status(403).json(
    {
        ok: false,
        error: "Endpoint quản trị Douyin cần DOUYIN_ADMIN_TOKEN.",
    });
}

function DecodeStorageStateBase64(storageStateBase64)
{
    const normalized = String(storageStateBase64 ?? "").trim();

    if (!normalized)
    {
        return null;
    }

    return JSON.parse(Buffer.from(normalized, "base64").toString("utf8"));
}

offlineTranslator.EnsureLoaded();
void douyinService.WarmupAsync().catch((error) =>
{
    console.error("Warmup DouyinService thất bại:", error);
});

app.use(express.json(
{
    limit: "3mb",
}));
app.use(express.static(config.publicDir));

app.get("/api/health", (request, response) =>
{
    const douyinAuthStatus = douyinService.GetAuthStatus();

    response.json(
    {
        ok: true,
        geminiConfigured: geminiTranslator.IsConfigured,
        stvConfigured: stvTranslator.IsConfigured,
        offlineDictDir: config.offlineDictDir,
        justOneApiConfigured: justOneApiService.IsConfigured,
        defaultCommentSource: config.commentSource,
        douyinAdminConfigured: Boolean(config.douyinAdminToken),
        douyinAuthStatus,
    });
});

app.get("/api/douyin/auth-status", (request, response) =>
{
    response.json(
    {
        ok: true,
        ...douyinService.GetAuthStatus(),
    });
});

app.post("/api/douyin/sync-cookies", async (request, response) =>
{
    if (!IsAdminRequest(request))
    {
        RejectAdminRequest(response);
        return;
    }

    try
    {
        const authStatus = await douyinService.SyncCookiesAsync();
        commentCache.clear();

        response.json(
        {
            ok: true,
            ...authStatus,
        });
    }
    catch (error)
    {
        response.status(500).json(
        {
            ok: false,
            error: error instanceof Error ? error.message : "Đồng bộ cookie thất bại.",
        });
    }
});

app.post("/api/douyin/admin/session", async (request, response) =>
{
    if (!IsAdminRequest(request))
    {
        RejectAdminRequest(response);
        return;
    }

    try
    {
        const storageState = request.body?.storageState
            ?? DecodeStorageStateBase64(request.body?.storageStateBase64);
        const cookieText = String(
            request.body?.cookieHeader
            ?? request.body?.cookieText
            ?? "",
        ).trim();
        const commentApiTemplateUrl = String(request.body?.commentApiTemplateUrl ?? "").trim();
        const replyApiTemplateUrl = String(request.body?.replyApiTemplateUrl ?? "").trim();
        let authStatus = douyinService.GetAuthStatus();

        if (storageState)
        {
            authStatus = await douyinService.ImportStorageStateAsync(storageState);
        }
        else if (cookieText)
        {
            authStatus = await douyinService.ImportCookiesAsync(cookieText);
        }

        if (commentApiTemplateUrl || replyApiTemplateUrl)
        {
            authStatus = douyinService.ConfigureDirectApi(
                {
                    commentApiTemplateUrl,
                    replyApiTemplateUrl,
                },
            );
        }

        commentCache.clear();

        response.json(
        {
            ok: true,
            ...authStatus,
        });
    }
    catch (error)
    {
        response.status(400).json(
        {
            ok: false,
            error: error instanceof Error ? error.message : "Cập nhật phiên Douyin thất bại.",
        });
    }
});

app.post("/api/comments", async (request, response) =>
{
    const videoUrl = String(request.body?.videoUrl ?? "").trim();
    const translationMode = String(request.body?.translationMode ?? "offline").trim().toLowerCase();
    const requestedSource = String(request.body?.source ?? "").trim().toLowerCase();
    const limit = Number(request.body?.limit) || 0; // 0 = tải hết
    const offset = Number(request.body?.offset) || 0;
    const commentSource = requestedSource || config.commentSource || "douyin";

    if (!videoUrl)
    {
        response.status(400).json(
        {
            ok: false,
            error: "Thiếu link video Douyin.",
        });
        return;
    }

    try
    {
        let result;
        let cached = null;

        // Tìm cache theo videoUrl
        for (const [, entry] of commentCache)
        {
            if (entry.videoUrl === videoUrl && entry.commentSource === commentSource)
            {
                cached = entry;
                break;
            }
        }

        if (offset > 0 && cached && offset < cached.comments.length)
        {
            // Có sẵn trong cache → chỉ cần slice + dịch
            const slicedComments = limit > 0
                ? cached.comments.slice(offset, offset + limit)
                : cached.comments.slice(offset);

            const translatedComments = await translationService.TranslateCommentsAsync(
                slicedComments,
                translationMode,
            );

            const endIndex = limit > 0 ? offset + limit : cached.comments.length;
            const hasMore = slicedComments.length > 0
                && (cached.douyinHasMore || endIndex < cached.comments.length);

            response.json(
            {
                ok: true,
                videoId: cached.videoId,
                source: "douyin-webpack-client",
                totalFetched: cached.comments.length,
                reportedCommentCount: cached.reportedCommentCount,
                replyStatus: cached.replyStatus,
                offset,
                hasMore,
                comments: translatedComments,
            });
            return;
        }

        // Cần crawl từ Douyin (lần đầu hoặc tải thêm)
        const startCursor = cached?.nextCursor ?? 0;

        if (commentSource === "justoneapi")
        {
            result = await justOneApiService.GetCommentsAsync(videoUrl, limit, startCursor);
        }
        else
        {
            result = await douyinService.GetCommentsAsync(videoUrl, limit, startCursor);
        }

        // Trim kết quả đúng limit (để không trả thừa do page size Douyin)
        const trimmedComments = limit > 0
            ? result.comments.slice(0, limit)
            : result.comments;

        // Gộp vào cache (giữ nguyên tất cả comments đã crawl, kể cả phần thừa)
        const previousComments = cached?.comments ?? [];
        const allCrawled = [...previousComments, ...result.comments];

        const cacheEntry =
        {
            videoUrl,
            videoId: result.videoId,
            commentSource,
            comments: allCrawled,
            reportedCommentCount: result.reportedCommentCount,
            replyStatus: cached?.replyStatus ?? result.replyStatus,
            nextCursor: result.nextCursor,
            douyinHasMore: result.douyinHasMore,
            createdAt: cached?.createdAt ?? Date.now(),
        };

        commentCache.set(`${commentSource}:${result.videoId}`, cacheEntry);

        // Dọn cache cũ
        for (const [key, entry] of commentCache)
        {
            if (Date.now() - entry.createdAt > CACHE_TTL_MS)
            {
                commentCache.delete(key);
            }
        }

        const translatedComments = await translationService.TranslateCommentsAsync(
            trimmedComments,
            translationMode,
        );

        const hasMore = trimmedComments.length > 0
            && (result.douyinHasMore || trimmedComments.length < result.comments.length);

        response.json(
        {
            ok: true,
            videoId: result.videoId,
            source: result.source,
            totalFetched: allCrawled.length,
            reportedCommentCount: result.reportedCommentCount,
            replyStatus: cacheEntry.replyStatus,
            offset: previousComments.length,
            hasMore,
            comments: translatedComments,
        });
    }
    catch (error)
    {
        response.status(500).json(
        {
            ok: false,
            error: error instanceof Error ? error.message : "Lỗi không xác định.",
        });
    }
});

app.post("/api/comment-replies", async (request, response) =>
{
    const videoUrl = String(request.body?.videoUrl ?? "").trim();
    const commentId = String(request.body?.commentId ?? "").trim();
    const translationMode = String(request.body?.translationMode ?? "offline").trim().toLowerCase();
    const requestedSource = String(request.body?.source ?? "").trim().toLowerCase();
    const limit = Number(request.body?.limit) || 0;
    const commentSource = requestedSource || config.commentSource || "douyin";

    if (!videoUrl || !commentId)
    {
        response.status(400).json(
        {
            ok: false,
            error: "Thiếu videoUrl hoặc commentId.",
        });
        return;
    }

    try
    {
        const result = commentSource === "justoneapi"
            ? await justOneApiService.GetRepliesAsync(videoUrl, commentId, limit)
            : await douyinService.GetRepliesAsync(videoUrl, commentId, limit);
        const translatedReplies = await translationService.TranslateCommentsAsync(
            result.replies,
            translationMode,
        );

        response.json(
        {
            ok: true,
            commentId,
            source: commentSource,
            replyStatus: result.replyStatus,
            replies: translatedReplies,
        });
    }
    catch (error)
    {
        response.status(500).json(
        {
            ok: false,
            error: error instanceof Error ? error.message : "Lấy phản hồi thất bại.",
        });
    }
});

app.listen(config.port, () =>
{
    console.log(`DYComment đang chạy tại http://localhost:${config.port}`);
});
