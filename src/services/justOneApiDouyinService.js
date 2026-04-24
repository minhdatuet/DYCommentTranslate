import { config } from "../config.js";

const DEFAULT_BASE_URL = "https://api.justoneapi.com";
const DEFAULT_TIMEOUT_MS = 90000;
const MAX_PAGE_COUNT = 40;

// Trích video ID từ các dạng link Douyin:
// - douyin.com/video/<id>
// - douyin.com/jingxuan?modal_id=<id>
// - iesdouyin.com/share/video/<id>/
// - v.douyin.com/<shortcode> (cần resolve redirect trước)
function ExtractVideoId(videoUrl)
{
    const parsedUrl = new URL(videoUrl);
    const modalId = parsedUrl.searchParams.get("modal_id");

    if (modalId)
    {
        return modalId;
    }

    const pathSegments = parsedUrl.pathname.split("/").filter(Boolean);
    const videoSegmentIndex = pathSegments.indexOf("video");

    if (videoSegmentIndex !== -1 && pathSegments[videoSegmentIndex + 1])
    {
        return pathSegments[videoSegmentIndex + 1];
    }

    return pathSegments.at(-1) ?? "";
}

// Resolve link ngắn v.douyin.com bằng cách follow redirect.
async function ResolveShortUrlAsync(videoUrl)
{
    const parsedUrl = new URL(videoUrl);

    if (parsedUrl.hostname !== "v.douyin.com")
    {
        return videoUrl;
    }

    try
    {
        const response = await fetch(videoUrl,
        {
            method: "GET",
            redirect: "follow",
            headers:
            {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            },
        });

        return response.url || videoUrl;
    }
    catch
    {
        return videoUrl;
    }
}

function NormalizeTopLevelComment(comment, index)
{
    return {
        index: index + 1,
        commentId: comment.cid ?? "",
        text: comment.text ?? "",
        nickname: comment.user?.nickname ?? "Ẩn danh",
        likeCount: comment.diggCount ?? comment.digg_count ?? 0,
        replyCount: comment.replyTotal ?? comment.reply_comment_total ?? 0,
        ipLocation: comment.ipLabel ?? comment.ip_label ?? "",
        createTime: comment.createTime ?? comment.create_time ?? 0,
        replies: [],
    };
}

function NormalizeReplyComment(reply, index)
{
    return {
        index: index + 1,
        commentId: reply.cid ?? "",
        text: reply.text ?? "",
        nickname: reply.user?.nickname ?? "Ẩn danh",
        likeCount: reply.diggCount ?? reply.digg_count ?? 0,
        replyCount: reply.replyTotal ?? reply.reply_comment_total ?? 0,
        ipLocation: reply.ipLabel ?? reply.ip_label ?? "",
        createTime: reply.createTime ?? reply.create_time ?? 0,
    };
}

function NormalizeBaseUrl(baseUrl)
{
    const normalized = String(baseUrl ?? "").trim();

    if (!normalized)
    {
        return DEFAULT_BASE_URL;
    }

    return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

async function FetchJsonWithTimeoutAsync(url, timeoutMs)
{
    const controller = new AbortController();
    const timeoutId = setTimeout(() =>
    {
        controller.abort();
    }, timeoutMs);

    try
    {
        const response = await fetch(url,
        {
            method: "GET",
            headers:
            {
                accept: "application/json",
            },
            signal: controller.signal,
        });

        const responseText = await response.text();
        let responseJson;

        try
        {
            responseJson = responseText ? JSON.parse(responseText) : null;
        }
        catch
        {
            responseJson = null;
        }

        if (!response.ok)
        {
            const message = responseJson?.message
                ? String(responseJson.message)
                : `JustOneApi trả về HTTP ${response.status}.`;
            throw new Error(message);
        }

        return responseJson;
    }
    catch (error)
    {
        if (error instanceof DOMException && error.name === "AbortError")
        {
            throw new Error("JustOneApi bị quá thời gian chờ.");
        }

        throw error;
    }
    finally
    {
        clearTimeout(timeoutId);
    }
}

function EnsureOkBusinessCodeOrThrow(responseJson)
{
    const businessCode = Number(responseJson?.code ?? -1);

    if (businessCode === 0)
    {
        return;
    }

    const message = String(responseJson?.message ?? "").trim();
    const fallback = message ? message : `JustOneApi trả về code=${businessCode}.`;
    throw new Error(fallback);
}

export class JustOneApiDouyinService
{
    constructor(
        baseUrl = config.justOneApiBaseUrl,
        token = config.justOneApiToken,
        timeoutMs = config.justOneApiTimeoutMs,
    )
    {
        this._baseUrl = NormalizeBaseUrl(baseUrl);
        this._token = String(token ?? "").trim();
        this._timeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
    }

    get IsConfigured()
    {
        return Boolean(this._token);
    }

    // Lấy comment cấp 1 theo videoUrl (aweme_id), có hỗ trợ phân trang theo page.
    async GetCommentsAsync(videoUrl, maxComments = 0, startCursor = 0)
    {
        if (!this._token)
        {
            throw new Error("Chưa cấu hình JUSTONEAPI_TOKEN.");
        }

        const resolvedUrl = await ResolveShortUrlAsync(videoUrl);
        const videoId = ExtractVideoId(resolvedUrl);

        if (!videoId)
        {
            throw new Error("Không trích được videoId (aweme_id) từ link Douyin.");
        }

        const normalizedMaxComments = Number(maxComments) > 0 ? Number(maxComments) : 0;
        const commentsById = new Map();
        const startPage = Number(startCursor) > 0 ? Number(startCursor) : 1;
        let currentPage = startPage;
        let lastFetchedPage = 0;
        let hasMore = true;
        let pageCount = 0;
        let reportedTotal = 0;

        while (hasMore && pageCount < MAX_PAGE_COUNT)
        {
            const requestUrl = new URL(`${this._baseUrl}/api/douyin/get-video-comment/v1`);
            requestUrl.searchParams.set("token", this._token);
            requestUrl.searchParams.set("awemeId", videoId);
            requestUrl.searchParams.set("page", String(currentPage));

            const responseJson = await FetchJsonWithTimeoutAsync(requestUrl.toString(), this._timeoutMs);
            EnsureOkBusinessCodeOrThrow(responseJson);

            const data = responseJson?.data ?? {};
            const statusCode = Number(data?.status_code ?? 0);

            if (statusCode !== 0)
            {
                throw new Error(`JustOneApi/Douyin trả về status_code=${statusCode}.`);
            }

            const comments = Array.isArray(data?.comments) ? data.comments : [];

            for (const comment of comments)
            {
                if (comment?.cid)
                {
                    commentsById.set(comment.cid, comment);
                }
            }

            reportedTotal = Number(data?.total ?? reportedTotal ?? 0);
            hasMore = Boolean(Number(data?.has_more ?? 0));
            lastFetchedPage = currentPage;

            if (normalizedMaxComments > 0 && commentsById.size >= normalizedMaxComments)
            {
                break;
            }

            if (!hasMore || comments.length === 0)
            {
                break;
            }

            currentPage += 1;
            pageCount += 1;
        }

        const rawComments = [...commentsById.values()];
        const trimmedComments = normalizedMaxComments > 0 ? rawComments.slice(0, normalizedMaxComments) : rawComments;
        const normalizedComments = trimmedComments.map((comment, index) =>
        {
            return NormalizeTopLevelComment(comment, index);
        });

        const nextPage = hasMore ? lastFetchedPage + 1 : lastFetchedPage;

        return {
            videoId,
            comments: normalizedComments,
            source: "justoneapi-video-comments-v1",
            topLevelCommentCount: normalizedComments.length,
            reportedCommentCount: reportedTotal,
            nextCursor: nextPage,
            douyinHasMore: hasMore,
            replyStatus:
            {
                fetchedReplies: false,
                requiresLogin: false,
                blockedByVerification: false,
                fetchedReplyCommentCount: 0,
            },
        };
    }

    // Lấy reply theo commentId, không cần cookie Douyin.
    async GetRepliesAsync(_videoUrl, commentId, maxReplies = 0)
    {
        if (!this._token)
        {
            throw new Error("Chưa cấu hình JUSTONEAPI_TOKEN.");
        }

        const normalizedCommentId = String(commentId ?? "").trim();

        if (!normalizedCommentId)
        {
            throw new Error("Thiếu commentId.");
        }

        const normalizedMaxReplies = Number(maxReplies) > 0 ? Number(maxReplies) : 0;
        const repliesById = new Map();
        let currentPage = 1;
        let hasMore = true;
        let pageCount = 0;

        while (hasMore && pageCount < MAX_PAGE_COUNT)
        {
            const requestUrl = new URL(`${this._baseUrl}/api/douyin/get-video-sub-comment/v1`);
            requestUrl.searchParams.set("token", this._token);
            requestUrl.searchParams.set("commentId", normalizedCommentId);
            requestUrl.searchParams.set("page", String(currentPage));

            const responseJson = await FetchJsonWithTimeoutAsync(requestUrl.toString(), this._timeoutMs);
            EnsureOkBusinessCodeOrThrow(responseJson);

            const data = responseJson?.data ?? {};
            const statusCode = Number(data?.status_code ?? 0);

            if (statusCode !== 0)
            {
                throw new Error(`JustOneApi/Douyin trả về status_code=${statusCode}.`);
            }

            const comments = Array.isArray(data?.comments) ? data.comments : [];

            for (const reply of comments)
            {
                if (reply?.cid)
                {
                    repliesById.set(reply.cid, reply);
                }
            }

            hasMore = Boolean(Number(data?.has_more ?? 0));

            if (normalizedMaxReplies > 0 && repliesById.size >= normalizedMaxReplies)
            {
                break;
            }

            if (!hasMore || comments.length === 0)
            {
                break;
            }

            currentPage += 1;
            pageCount += 1;
        }

        const rawReplies = [...repliesById.values()];
        const trimmedReplies = normalizedMaxReplies > 0 ? rawReplies.slice(0, normalizedMaxReplies) : rawReplies;
        const normalizedReplies = trimmedReplies.map((reply, index) =>
        {
            return NormalizeReplyComment(reply, index);
        });

        return {
            replies: normalizedReplies,
            replyStatus:
            {
                fetchedReplies: normalizedReplies.length > 0,
                requiresLogin: false,
                blockedByVerification: false,
                fetchedReplyCommentCount: normalizedReplies.length,
            },
        };
    }
}

