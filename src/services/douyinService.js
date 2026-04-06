import { chromium } from "playwright";

import { config } from "../config.js";

const WEBPACK_CHUNK_PREFIX = "webpackChunkdouyin_web";
const MAX_TOP_LEVEL_COMMENTS = 400;
const COMMENT_PAGE_SIZE = 20;
const REPLY_PROBE_TIMEOUT_MS = 6000;

/// Trích video ID từ các dạng link Douyin:
/// - douyin.com/video/<id>
/// - douyin.com/jingxuan?modal_id=<id>
/// - iesdouyin.com/share/video/<id>/
/// - v.douyin.com/<shortcode> (cần resolve redirect trước)
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

/// Resolve link ngắn v.douyin.com bằng cách follow redirect.
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

function BuildCanonicalVideoUrl(videoUrl)
{
    const videoId = ExtractVideoId(videoUrl);

    if (!videoId)
    {
        return videoUrl;
    }

    return `https://www.douyin.com/video/${videoId}`;
}

function NormalizeTopLevelComment(comment, index)
{
    return {
        index: index + 1,
        commentId: comment.cid ?? "",
        text: comment.text ?? "",
        nickname: comment.user?.nickname ?? "Ẩn danh",
        likeCount: comment.diggCount ?? 0,
        replyCount: comment.replyTotal ?? 0,
        ipLocation: comment.ipLabel ?? "",
        createTime: comment.createTime ?? 0,
        replies: [],
    };
}

async function FetchTopLevelCommentsAsync(page, videoId, maxComments, startCursor = 0)
{
    return page.evaluate(async ({ pageSize, videoId, maxTopLevelComments, webpackChunkPrefix, startCursor }) =>
    {
        function GetWebpackRequire()
        {
            const chunkName = Object.keys(window).find((key) => key.startsWith(webpackChunkPrefix));

            if (!chunkName)
            {
                throw new Error("Không tìm thấy webpack runtime của Douyin.");
            }

            let webpackRequire;
            window[chunkName].push([[Symbol("dycomment")], {}, (currentRequire) =>
            {
                webpackRequire = currentRequire;
            }]);

            if (!webpackRequire)
            {
                throw new Error("Không truy cập được webpack require.");
            }

            return webpackRequire;
        }

        function GetCommentModule(webpackRequire)
        {
            for (const [moduleId, factory] of Object.entries(webpackRequire.m))
            {
                const source = String(factory);

                if (
                    source.includes("/aweme/v1/web/comment/list/")
                    && source.includes("/aweme/v1/web/comment/list/reply/")
                )
                {
                    const moduleExports = webpackRequire(moduleId);

                    if (
                        typeof moduleExports?.iq === "function"
                        && typeof moduleExports?.rs === "function"
                    )
                    {
                        return moduleExports;
                    }
                }
            }

            throw new Error("Không tìm thấy module comment nội bộ của Douyin.");
        }

        const webpackRequire = GetWebpackRequire();
        const commentModule = GetCommentModule(webpackRequire);
        const fetchCommentList = commentModule.iq;

        if (typeof fetchCommentList !== "function")
        {
            throw new Error("Douyin comment client đã thay đổi API nội bộ.");
        }

        const commentsById = new Map();
        let cursor = startCursor;
        let hasMore = true;
        let pageCount = 0;
        let reportedTotal = 0;

        while (hasMore && commentsById.size < maxTopLevelComments && pageCount < 40)
        {
            const pageResult = await fetchCommentList({
                awemeId: videoId,
                cursor,
                count: pageSize,
            });

            const comments = Array.isArray(pageResult?.comments) ? pageResult.comments : [];

            for (const comment of comments)
            {
                if (comment?.cid)
                {
                    commentsById.set(comment.cid, comment);
                }
            }

            reportedTotal = Number(pageResult?.total ?? reportedTotal ?? 0);

            if (!pageResult?.hasMore || pageResult?.cursor === cursor)
            {
                hasMore = false;
                break;
            }

            cursor = pageResult.cursor;
            hasMore = Boolean(pageResult.hasMore);
            pageCount += 1;
        }

        return {
            comments: [...commentsById.values()],
            reportedTotal,
            nextCursor: cursor,
            douyinHasMore: hasMore,
        };
    },
    {
        pageSize: COMMENT_PAGE_SIZE,
        videoId,
        maxTopLevelComments: maxComments > 0 ? maxComments : MAX_TOP_LEVEL_COMMENTS,
        webpackChunkPrefix: WEBPACK_CHUNK_PREFIX,
        startCursor,
    });
}

async function ProbeReplyStatusAsync(page, videoId, comments)
{
    const commentWithReplies = comments.find((comment) => (comment.replyTotal ?? 0) > 0);

    if (!commentWithReplies)
    {
        return {
            fetchedReplies: false,
            blockedByVerification: false,
            blockCode: "",
            blockDetails: "",
            attemptedCommentId: "",
        };
    }

    let blockedByVerification = false;
    let blockDetails = "";

    const responseHandler = async (response) =>
    {
        if (!response.url().includes("/aweme/v1/web/comment/list/reply/"))
        {
            return;
        }

        const verifyPayload = response.headers()["x-vc-bdturing-parameters"];

        if (verifyPayload)
        {
            blockedByVerification = true;
            blockDetails = verifyPayload;
        }
    };

    page.on("response", responseHandler);

    try
    {
        const replyProbe = await page.evaluate(async ({ commentId, pageSize, timeoutMs, videoId, webpackChunkPrefix }) =>
        {
            function GetWebpackRequire()
            {
                const chunkName = Object.keys(window).find((key) => key.startsWith(webpackChunkPrefix));

                if (!chunkName)
                {
                    throw new Error("Không tìm thấy webpack runtime của Douyin.");
                }

                let webpackRequire;
                window[chunkName].push([[Symbol("dycomment-reply")], {}, (currentRequire) =>
                {
                    webpackRequire = currentRequire;
                }]);

                if (!webpackRequire)
                {
                    throw new Error("Không truy cập được webpack require.");
                }

                return webpackRequire;
            }

        function GetCommentModule(webpackRequire)
        {
            for (const [moduleId, factory] of Object.entries(webpackRequire.m))
            {
                const source = String(factory);

                    if (
                        source.includes("/aweme/v1/web/comment/list/")
                        && source.includes("/aweme/v1/web/comment/list/reply/")
                    )
                    {
                    const moduleExports = webpackRequire(moduleId);

                    if (
                        typeof moduleExports?.iq === "function"
                        && typeof moduleExports?.rs === "function"
                    )
                    {
                        return moduleExports;
                    }
                }
            }

                throw new Error("Không tìm thấy module comment nội bộ của Douyin.");
            }

            const webpackRequire = GetWebpackRequire();
            const commentModule = GetCommentModule(webpackRequire);
            const fetchReplyList = commentModule.rs;

            if (typeof fetchReplyList !== "function")
            {
                return {
                    status: "reply-client-not-found",
                };
            }

            const replyResult = await Promise.race([
                fetchReplyList({
                    awemeId: videoId,
                    commentId,
                    cursor: 0,
                    count: pageSize,
                }),
                new Promise((resolve) =>
                {
                    setTimeout(() =>
                    {
                        resolve({
                            __timeout: true,
                        });
                    }, timeoutMs);
                }),
            ]);

            if (replyResult?.__timeout)
            {
                return {
                    status: "timeout",
                };
            }

            return {
                status: "ok",
                replyCount: Array.isArray(replyResult?.comments) ? replyResult.comments.length : 0,
            };
        },
        {
            commentId: commentWithReplies.cid,
            pageSize: COMMENT_PAGE_SIZE,
            timeoutMs: REPLY_PROBE_TIMEOUT_MS,
            videoId,
            webpackChunkPrefix: WEBPACK_CHUNK_PREFIX,
        });

        return {
            fetchedReplies: replyProbe?.status === "ok" && Number(replyProbe.replyCount ?? 0) > 0,
            blockedByVerification,
            blockCode: blockedByVerification ? "bdturing" : "",
            blockDetails,
            attemptedCommentId: commentWithReplies.cid,
        };
    }
    finally
    {
        page.off("response", responseHandler);
    }
}

export class DouyinService
{
    async GetCommentsAsync(videoUrl, maxComments = 0, startCursor = 0)
    {
        const browser = await chromium.launch(
        {
            headless: config.playwrightHeadless,
        });

        const context = await browser.newContext(
        {
            viewport:
            {
                width: 1440,
                height: 1200,
            },
            userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            locale: "zh-CN",
        });

        const page = await context.newPage();
        const resolvedUrl = await ResolveShortUrlAsync(videoUrl);
        const videoId = ExtractVideoId(resolvedUrl);
        const canonicalVideoUrl = BuildCanonicalVideoUrl(resolvedUrl);

        try
        {
            await page.goto(canonicalVideoUrl,
            {
                waitUntil: "domcontentloaded",
                timeout: 60000,
            });
            await page.waitForTimeout(5000);

            const topLevelResult = await FetchTopLevelCommentsAsync(page, videoId, maxComments, startCursor);
            const replyStatus = startCursor === 0
                ? await ProbeReplyStatusAsync(page, videoId, topLevelResult.comments)
                : null;
            const normalizedComments = topLevelResult.comments.map((comment, index) =>
            {
                return NormalizeTopLevelComment(comment, index);
            });

            return {
                videoId,
                comments: normalizedComments,
                source: "douyin-webpack-client",
                topLevelCommentCount: normalizedComments.length,
                reportedCommentCount: topLevelResult.reportedTotal,
                nextCursor: topLevelResult.nextCursor,
                douyinHasMore: topLevelResult.douyinHasMore,
                replyStatus,
            };
        }
        finally
        {
            await context.close();
            await browser.close();
        }
    }
}
