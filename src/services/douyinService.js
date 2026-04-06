import { chromium } from "playwright";

import { config } from "../config.js";

const WEBPACK_CHUNK_PREFIX = "webpackChunkdouyin_web";
const COMMENT_LIST_PATH = "/aweme/v1/web/comment/list/";
const COMMENT_REPLY_LIST_PATH = "/aweme/v1/web/comment/list/reply/";
const MAX_TOP_LEVEL_COMMENTS = 400;
const COMMENT_PAGE_SIZE = 20;
const COMMENT_STEP_TIMEOUT_MS = 30000;
const GET_COMMENTS_TIMEOUT_MS = 90000;
const DOUYIN_CLIENT_READY_TIMEOUT_MS = 15000;
const MIN_RUNTIME_READY_WAIT_MS = 2000;
const INTERNAL_COMMENT_REQUEST_TIMEOUT_MS = 12000;
const BLOCKED_RESOURCE_TYPES = new Set(["font", "image", "manifest", "media"]);
const BROWSER_LAUNCH_OPTIONS =
{
    headless: config.playwrightHeadless,
    timeout: config.playwrightLaunchTimeoutMs,
    chromiumSandbox: false,
    args:
    [
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-setuid-sandbox",
        "--no-sandbox",
    ],
};
const CONTEXT_OPTIONS =
{
    viewport:
    {
        width: 1440,
        height: 1200,
    },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    locale: "zh-CN",
};

let sharedBrowserPromise = null;
let sharedContextPromise = null;
let latestCommentApiTemplateUrl = "";

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
        likeCount: comment.diggCount ?? comment.digg_count ?? 0,
        replyCount: comment.replyTotal ?? comment.reply_comment_total ?? 0,
        ipLocation: comment.ipLabel ?? comment.ip_label ?? "",
        createTime: comment.createTime ?? comment.create_time ?? 0,
        replies: [],
    };
}

function ResetSharedPlaywrightState()
{
    sharedBrowserPromise = null;
    sharedContextPromise = null;
}

async function CloseSharedPlaywrightAsync()
{
    const browserPromise = sharedBrowserPromise;

    ResetSharedPlaywrightState();

    if (!browserPromise)
    {
        return;
    }

    try
    {
        const browser = await browserPromise;
        await browser.close();
    }
    catch
    {
        return;
    }
}

function WithTimeoutAsync(promise, timeoutMs, errorMessage)
{
    return Promise.race([
        promise,
        new Promise((_, reject) =>
        {
            setTimeout(() =>
            {
                reject(new Error(errorMessage));
            }, timeoutMs);
        }),
    ]);
}

async function GetSharedBrowserAsync()
{
    if (!sharedBrowserPromise)
    {
        sharedBrowserPromise = chromium.launch(BROWSER_LAUNCH_OPTIONS).then((browser) =>
        {
            browser.on("disconnected", () =>
            {
                ResetSharedPlaywrightState();
            });

            return browser;
        }).catch((error) =>
        {
            ResetSharedPlaywrightState();
            throw error;
        });
    }

    return sharedBrowserPromise;
}

async function GetSharedContextAsync()
{
    if (!sharedContextPromise)
    {
        sharedContextPromise = GetSharedBrowserAsync().then(async (browser) =>
        {
            const context = await browser.newContext(CONTEXT_OPTIONS);

            context.on("close", () =>
            {
                sharedContextPromise = null;
            });

            await context.route("**/*", async (route) =>
            {
                const request = route.request();

                if (BLOCKED_RESOURCE_TYPES.has(request.resourceType()))
                {
                    await route.abort();
                    return;
                }

                await route.continue();
            });

            return context;
        }).catch((error) =>
        {
            sharedContextPromise = null;
            throw error;
        });
    }

    return sharedContextPromise;
}

async function BuildCookieHeaderAsync(context, requestUrl)
{
    const cookies = await context.cookies(requestUrl);

    return cookies.map((cookie) =>
    {
        return `${cookie.name}=${cookie.value}`;
    }).join("; ");
}

async function WaitForDouyinClientReadyAsync(page, commentApiBootstrap)
{
    const startedAt = Date.now();

    while (Date.now() - startedAt < DOUYIN_CLIENT_READY_TIMEOUT_MS)
    {
        if (commentApiBootstrap.value)
        {
            return;
        }

        const clientState = await page.evaluate((webpackChunkPrefix) =>
        {
            return {
                hasWebpackRuntime: Object.keys(window).some((key) =>
                {
                    return key.startsWith(webpackChunkPrefix) || key.startsWith("webpackChunk");
                }),
                readyState: document.readyState,
            };
        }, WEBPACK_CHUNK_PREFIX).catch(() =>
        {
            return {
                hasWebpackRuntime: false,
                readyState: "loading",
            };
        });

        if (
            clientState.hasWebpackRuntime
            && clientState.readyState !== "loading"
            && Date.now() - startedAt >= MIN_RUNTIME_READY_WAIT_MS
        )
        {
            return;
        }

        await page.waitForTimeout(250);
    }
}

async function GetDouyinPageDebugInfoAsync(page)
{
    return page.evaluate((commentListPath) =>
    {
        const windowKeys = Object.keys(window);

        return {
            href: location.href,
            title: document.title,
            webpackKeys: windowKeys.filter((key) => key.startsWith("webpackChunk")).slice(0, 10),
            commentRequestEntries: performance
                .getEntriesByType("resource")
                .filter((entry) => entry.name.includes(commentListPath))
                .slice(0, 3)
                .map((entry) => entry.name),
            bodyTextPreview: document.body?.innerText?.replace(/\s+/g, " ").slice(0, 240) ?? "",
        };
    }, COMMENT_LIST_PATH).catch(() =>
    {
        return null;
    });
}

async function FetchTopLevelCommentsViaWebpackAsync(page, videoId, maxComments, startCursor = 0)
{
    return page.evaluate(async ({
        commentListPath,
        commentReplyListPath,
        pageSize,
        videoId,
        maxTopLevelComments,
        webpackChunkPrefix,
        startCursor,
        requestTimeoutMs,
    }) =>
    {
        function GetWebpackRequire()
        {
            const chunkName = Object.keys(window).find((key) =>
            {
                return key.startsWith(webpackChunkPrefix) || key.startsWith("webpackChunk");
            });

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
                    source.includes(commentListPath)
                    && source.includes(commentReplyListPath)
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
            const pageResult = await Promise.race([
                fetchCommentList({
                    awemeId: videoId,
                    cursor,
                    count: pageSize,
                }),
                new Promise((_, reject) =>
                {
                    setTimeout(() =>
                    {
                        reject(new Error("Douyin webpack comment request timeout."));
                    }, requestTimeoutMs);
                }),
            ]);

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
            source: "douyin-webpack-client",
        };
    },
    {
        pageSize: COMMENT_PAGE_SIZE,
        videoId,
        maxTopLevelComments: maxComments > 0 ? maxComments : MAX_TOP_LEVEL_COMMENTS,
        webpackChunkPrefix: WEBPACK_CHUNK_PREFIX,
        startCursor,
        commentListPath: COMMENT_LIST_PATH,
        commentReplyListPath: COMMENT_REPLY_LIST_PATH,
        requestTimeoutMs: INTERNAL_COMMENT_REQUEST_TIMEOUT_MS,
    });
}

async function FetchTopLevelCommentsViaCapturedApiAsync(page, videoId, maxComments, startCursor, bootstrapApiUrl)
{
    return page.evaluate(async ({ bootstrapApiUrl, pageSize, videoId, maxTopLevelComments, startCursor, requestTimeoutMs }) =>
    {
        const commentsById = new Map();
        let cursor = startCursor;
        let hasMore = true;
        let pageCount = 0;
        let reportedTotal = 0;

        while (hasMore && commentsById.size < maxTopLevelComments && pageCount < 40)
        {
            const requestUrl = new URL(bootstrapApiUrl);

            requestUrl.searchParams.set("aweme_id", videoId);
            requestUrl.searchParams.set("cursor", String(cursor));
            requestUrl.searchParams.set("count", String(pageSize));

            const controller = new AbortController();
            const timeoutId = setTimeout(() =>
            {
                controller.abort();
            }, requestTimeoutMs);
            let response;

            try
            {
                response = await fetch(requestUrl.toString(),
                {
                    credentials: "include",
                    headers:
                    {
                        accept: "application/json, text/plain, */*",
                    },
                    signal: controller.signal,
                });
            }
            finally
            {
                clearTimeout(timeoutId);
            }

            if (!response.ok)
            {
                throw new Error(`Douyin API trả về HTTP ${response.status}.`);
            }

            const pageResult = await response.json();
            const statusCode = Number(pageResult?.status_code ?? 0);

            if (statusCode !== 0)
            {
                throw new Error(`Douyin API trả về status_code=${statusCode}.`);
            }

            const comments = Array.isArray(pageResult?.comments) ? pageResult.comments : [];

            for (const comment of comments)
            {
                if (comment?.cid)
                {
                    commentsById.set(comment.cid, comment);
                }
            }

            reportedTotal = Number(pageResult?.total ?? reportedTotal ?? 0);

            const nextCursor = Number(pageResult?.cursor ?? cursor);
            const nextHasMore = Boolean(pageResult?.has_more ?? pageResult?.hasMore);

            if (!nextHasMore || nextCursor === cursor || comments.length === 0)
            {
                hasMore = nextHasMore && nextCursor !== cursor && comments.length > 0;
                cursor = nextCursor;
                break;
            }

            cursor = nextCursor;
            hasMore = nextHasMore;
            pageCount += 1;
        }

        return {
            comments: [...commentsById.values()],
            reportedTotal,
            nextCursor: cursor,
            douyinHasMore: hasMore,
            source: "douyin-captured-api",
        };
    },
    {
        bootstrapApiUrl,
        pageSize: COMMENT_PAGE_SIZE,
        videoId,
        maxTopLevelComments: maxComments > 0 ? maxComments : MAX_TOP_LEVEL_COMMENTS,
        startCursor,
        requestTimeoutMs: INTERNAL_COMMENT_REQUEST_TIMEOUT_MS,
    });
}

async function FetchTopLevelCommentsViaNodeApiAsync(context, videoId, maxComments, startCursor, bootstrapApiUrl, refererUrl)
{
    const commentsById = new Map();
    const cookieHeader = await BuildCookieHeaderAsync(context, "https://www.douyin.com");
    let cursor = startCursor;
    let hasMore = true;
    let pageCount = 0;
    let reportedTotal = 0;

    while (hasMore && commentsById.size < (maxComments > 0 ? maxComments : MAX_TOP_LEVEL_COMMENTS) && pageCount < 40)
    {
        const requestUrl = new URL(bootstrapApiUrl);
        const controller = new AbortController();
        const timeoutId = setTimeout(() =>
        {
            controller.abort();
        }, INTERNAL_COMMENT_REQUEST_TIMEOUT_MS);

        requestUrl.searchParams.set("aweme_id", videoId);
        requestUrl.searchParams.set("cursor", String(cursor));
        requestUrl.searchParams.set("count", String(COMMENT_PAGE_SIZE));

        let response;

        try
        {
            response = await fetch(requestUrl.toString(),
            {
                headers:
                {
                    accept: "application/json, text/plain, */*",
                    cookie: cookieHeader,
                    referer: refererUrl,
                    "user-agent": CONTEXT_OPTIONS.userAgent,
                },
                signal: controller.signal,
            });
        }
        finally
        {
            clearTimeout(timeoutId);
        }

        if (!response.ok)
        {
            throw new Error(`Douyin direct API trả về HTTP ${response.status}.`);
        }

        const pageResult = await response.json();
        const statusCode = Number(pageResult?.status_code ?? 0);

        if (statusCode !== 0)
        {
            throw new Error(`Douyin direct API trả về status_code=${statusCode}.`);
        }

        const comments = Array.isArray(pageResult?.comments) ? pageResult.comments : [];

        for (const comment of comments)
        {
            if (comment?.cid)
            {
                commentsById.set(comment.cid, comment);
            }
        }

        reportedTotal = Number(pageResult?.total ?? reportedTotal ?? 0);

        const nextCursor = Number(pageResult?.cursor ?? cursor);
        const nextHasMore = Boolean(pageResult?.has_more ?? pageResult?.hasMore);

        if (!nextHasMore || nextCursor === cursor || comments.length === 0)
        {
            hasMore = nextHasMore && nextCursor !== cursor && comments.length > 0;
            cursor = nextCursor;
            break;
        }

        cursor = nextCursor;
        hasMore = nextHasMore;
        pageCount += 1;
    }

    return {
        comments: [...commentsById.values()],
        reportedTotal,
        nextCursor: cursor,
        douyinHasMore: hasMore,
        source: "douyin-direct-api",
    };
}

async function FetchTopLevelCommentsAsync(page, videoId, maxComments, startCursor = 0, commentApiBootstrap = null)
{
    let webpackError;

    try
    {
        return await FetchTopLevelCommentsViaWebpackAsync(page, videoId, maxComments, startCursor);
    }
    catch (firstWebpackError)
    {
        webpackError = firstWebpackError;
    }

    await page.waitForTimeout(750);

    try
    {
        return await FetchTopLevelCommentsViaWebpackAsync(page, videoId, maxComments, startCursor);
    }
    catch (secondWebpackError)
    {
        if (commentApiBootstrap?.value)
        {
            try
            {
                return await FetchTopLevelCommentsViaCapturedApiAsync(
                    page,
                    videoId,
                    maxComments,
                    startCursor,
                    commentApiBootstrap.value,
                );
            }
            catch (apiError)
            {
                const webpackMessage = webpackError instanceof Error ? webpackError.message : "Không rõ lý do.";
                const apiMessage = apiError instanceof Error ? apiError.message : "Không rõ lý do.";

                throw new Error(
                    `Không lấy được comment qua webpack (${webpackMessage}) và fallback API (${apiMessage}).`,
                );
            }
        }

        const debugInfo = await GetDouyinPageDebugInfoAsync(page);
        const debugMessage = debugInfo
            ? `Trang hiện tại: ${debugInfo.title || "(không có title)"} | ${debugInfo.href} | webpack keys: ${debugInfo.webpackKeys.join(", ") || "(trống)"} | request: ${debugInfo.commentRequestEntries.join(", ") || "(không có)"} | body: ${debugInfo.bodyTextPreview || "(trống)"}`
            : "";
        const effectiveWebpackError = secondWebpackError ?? webpackError;
        const webpackMessage = effectiveWebpackError instanceof Error ? effectiveWebpackError.message : "Không rõ lý do.";

        throw new Error(`${webpackMessage}${debugMessage ? ` ${debugMessage}` : ""}`);
    }
}

export class DouyinService
{
    async WarmupAsync()
    {
        await GetSharedContextAsync();

        if (config.douyinWarmupVideoUrl && !latestCommentApiTemplateUrl)
        {
            await this.GetCommentsAsync(config.douyinWarmupVideoUrl, 1, 0).catch(() =>
            {
                return null;
            });
        }
    }

    async CloseAsync()
    {
        await CloseSharedPlaywrightAsync();
    }

    async GetCommentsAsync(videoUrl, maxComments = 0, startCursor = 0)
    {
        const context = await GetSharedContextAsync();
        const resolvedUrl = await ResolveShortUrlAsync(videoUrl);
        const videoId = ExtractVideoId(resolvedUrl);
        const canonicalVideoUrl = BuildCanonicalVideoUrl(resolvedUrl);
        const normalizedMaxComments = maxComments > 0 ? maxComments : MAX_TOP_LEVEL_COMMENTS;

        if (latestCommentApiTemplateUrl)
        {
            try
            {
                const directApiResult = await WithTimeoutAsync(
                    FetchTopLevelCommentsViaNodeApiAsync(
                        context,
                        videoId,
                        normalizedMaxComments,
                        startCursor,
                        latestCommentApiTemplateUrl,
                        canonicalVideoUrl,
                    ),
                    GET_COMMENTS_TIMEOUT_MS,
                    "Lấy comment từ Douyin direct API bị quá thời gian chờ.",
                );
                const normalizedComments = directApiResult.comments.map((comment, index) =>
                {
                    return NormalizeTopLevelComment(comment, index);
                });

                return {
                    videoId,
                    comments: normalizedComments,
                    source: directApiResult.source,
                    topLevelCommentCount: normalizedComments.length,
                    reportedCommentCount: directApiResult.reportedTotal,
                    nextCursor: directApiResult.nextCursor,
                    douyinHasMore: directApiResult.douyinHasMore,
                    replyStatus: null,
                };
            }
            catch
            {
                latestCommentApiTemplateUrl = "";
            }
        }

        const page = await context.newPage();
        const commentApiBootstrap =
        {
            value: "",
        };
        const commentBootstrapResponseHandler = (response) =>
        {
            const url = response.url();

            if (
                commentApiBootstrap.value
                || !url.includes(COMMENT_LIST_PATH)
                || url.includes(COMMENT_REPLY_LIST_PATH)
            )
            {
                return;
            }

            commentApiBootstrap.value = url;
            latestCommentApiTemplateUrl = url;
        };

        page.on("response", commentBootstrapResponseHandler);

        try
        {
            await WithTimeoutAsync(
                page.goto(canonicalVideoUrl,
                {
                    waitUntil: "domcontentloaded",
                    timeout: 60000,
                }),
                COMMENT_STEP_TIMEOUT_MS,
                "Mở trang Douyin quá lâu.",
            );
            await WithTimeoutAsync(
                WaitForDouyinClientReadyAsync(page, commentApiBootstrap),
                COMMENT_STEP_TIMEOUT_MS,
                "Douyin tải client quá lâu.",
            );

            const topLevelResult = await WithTimeoutAsync(
                FetchTopLevelCommentsAsync(
                    page,
                    videoId,
                    normalizedMaxComments,
                    startCursor,
                    commentApiBootstrap,
                ),
                GET_COMMENTS_TIMEOUT_MS,
                "Lấy comment từ Douyin bị quá thời gian chờ.",
            );
            const normalizedComments = topLevelResult.comments.map((comment, index) =>
            {
                return NormalizeTopLevelComment(comment, index);
            });

            return {
                videoId,
                comments: normalizedComments,
                source: topLevelResult.source ?? "douyin-webpack-client",
                topLevelCommentCount: normalizedComments.length,
                reportedCommentCount: topLevelResult.reportedTotal,
                nextCursor: topLevelResult.nextCursor,
                douyinHasMore: topLevelResult.douyinHasMore,
                replyStatus: null,
            };
        }
        finally
        {
            page.off("response", commentBootstrapResponseHandler);
            await page.close().catch(() =>
            {
                return null;
            });
        }
    }
}
