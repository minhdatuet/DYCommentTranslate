import fs from "node:fs";
import path from "node:path";

import { chromium } from "playwright";

import { config } from "../config.js";
import { BuildSignedCommentListUrl, BuildSignedReplyListUrl, GenerateVerifyFp } from "./douyinRequestSigner.js";

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
const COOKIE_SYNC_TIMEOUT_MS = 5 * 60 * 1000;
const COOKIE_POLL_INTERVAL_MS = 2000;
const TTwid_REGISTER_URL = "https://ttwid.bytedance.com/ttwid/union/register/";
const TTwid_REGISTER_PAYLOAD = JSON.stringify(
    {
        region: "cn",
        aid: 1768,
        needFid: false,
        service: "www.ixigua.com",
        migrate_info:
        {
            ticket: "",
            source: "node",
        },
        cbUrlProtocol: "https",
        union: true,
    },
);
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
const AUTH_STATE_PATH = config.douyinAuthStatePath;
const AUTH_USER_DATA_DIR = config.douyinAuthUserDataDir;
const DIRECT_API_STATE_PATH = config.douyinDirectApiStatePath;
const REQUIRED_AUTH_COOKIE_NAMES = new Set([
    "passport_auth_status",
    "passport_auth_mix_state",
    "passport_web_login_state",
    "sessionid",
    "sessionid_ss",
    "uid_tt",
    "sid_guard",
]);

let sharedBrowserPromise = null;
let sharedContextPromise = null;
let latestCommentApiTemplateUrl = "";
let latestReplyApiTemplateUrl = "";
let cookieSyncPromise = null;

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

function ResetSharedPlaywrightState()
{
    sharedBrowserPromise = null;
    sharedContextPromise = null;
}

function EnsureAuthDirectories()
{
    fs.mkdirSync(path.dirname(AUTH_STATE_PATH), { recursive: true });
    fs.mkdirSync(AUTH_USER_DATA_DIR, { recursive: true });
    fs.mkdirSync(path.dirname(DIRECT_API_STATE_PATH), { recursive: true });
}

function HasValidAuthCookies(cookies)
{
    const currentUnixTime = Math.floor(Date.now() / 1000);

    return cookies.some((cookie) =>
    {
        const hasRequiredName = REQUIRED_AUTH_COOKIE_NAMES.has(cookie.name);
        const notExpired = cookie.expires === -1 || cookie.expires > currentUnixTime;
        const hasValue = Boolean(cookie.value);

        return hasRequiredName && notExpired && hasValue;
    });
}

function HasAnyUsableCookies(cookies)
{
    const currentUnixTime = Math.floor(Date.now() / 1000);

    return cookies.some((cookie) =>
    {
        const notExpired = cookie.expires === -1 || cookie.expires > currentUnixTime;
        return Boolean(cookie.name) && Boolean(cookie.value) && notExpired;
    });
}

function ReadAuthState()
{
    if (!fs.existsSync(AUTH_STATE_PATH))
    {
        return null;
    }

    try
    {
        return JSON.parse(fs.readFileSync(AUTH_STATE_PATH, "utf8"));
    }
    catch
    {
        return null;
    }
}

function WriteAuthState(authState)
{
    EnsureAuthDirectories();
    fs.writeFileSync(
        AUTH_STATE_PATH,
        JSON.stringify(authState, null, 2),
        "utf8",
    );
}

function ReadDirectApiState()
{
    if (!fs.existsSync(DIRECT_API_STATE_PATH))
    {
        return null;
    }

    try
    {
        return JSON.parse(fs.readFileSync(DIRECT_API_STATE_PATH, "utf8"));
    }
    catch
    {
        return null;
    }
}

function GetConfiguredCommentApiTemplateUrl()
{
    if (latestCommentApiTemplateUrl)
    {
        return latestCommentApiTemplateUrl;
    }

    if (config.douyinCommentApiTemplateUrl)
    {
        latestCommentApiTemplateUrl = config.douyinCommentApiTemplateUrl;
        return latestCommentApiTemplateUrl;
    }

    const directApiState = ReadDirectApiState();
    const persistedUrl = String(directApiState?.commentApiTemplateUrl ?? "").trim();

    if (persistedUrl)
    {
        latestCommentApiTemplateUrl = persistedUrl;
    }

    return latestCommentApiTemplateUrl;
}

function GetConfiguredReplyApiTemplateUrl()
{
    if (latestReplyApiTemplateUrl)
    {
        return latestReplyApiTemplateUrl;
    }

    if (config.douyinReplyApiTemplateUrl)
    {
        latestReplyApiTemplateUrl = config.douyinReplyApiTemplateUrl;
        return latestReplyApiTemplateUrl;
    }

    const directApiState = ReadDirectApiState();
    const persistedUrl = String(directApiState?.replyApiTemplateUrl ?? "").trim();

    if (persistedUrl)
    {
        latestReplyApiTemplateUrl = persistedUrl;
    }

    return latestReplyApiTemplateUrl;
}

function PersistDirectApiState()
{
    EnsureAuthDirectories();

    const currentState = ReadDirectApiState() ?? {};
    const nextState =
    {
        ...currentState,
        updatedAt: new Date().toISOString(),
    };

    if (latestCommentApiTemplateUrl)
    {
        nextState.commentApiTemplateUrl = latestCommentApiTemplateUrl;
    }

    if (latestReplyApiTemplateUrl)
    {
        nextState.replyApiTemplateUrl = latestReplyApiTemplateUrl;
    }

    fs.writeFileSync(
        DIRECT_API_STATE_PATH,
        JSON.stringify(nextState, null, 2),
        "utf8",
    );
}

function SaveCommentApiTemplateUrl(templateUrl)
{
    latestCommentApiTemplateUrl = String(templateUrl ?? "").trim();

    if (latestCommentApiTemplateUrl)
    {
        PersistDirectApiState();
    }
}

function SaveReplyApiTemplateUrl(templateUrl)
{
    latestReplyApiTemplateUrl = String(templateUrl ?? "").trim();

    if (latestReplyApiTemplateUrl)
    {
        PersistDirectApiState();
    }
}

function ClearPersistedCommentApiTemplateUrl()
{
    latestCommentApiTemplateUrl = "";
    const currentState = ReadDirectApiState();

    if (!currentState)
    {
        return;
    }

    delete currentState.commentApiTemplateUrl;
    currentState.updatedAt = new Date().toISOString();
    fs.writeFileSync(
        DIRECT_API_STATE_PATH,
        JSON.stringify(currentState, null, 2),
        "utf8",
    );
}

function GetStoredCookies()
{
    const authState = ReadAuthState();
    return Array.isArray(authState?.cookies) ? authState.cookies : [];
}

function BuildCookieHeaderFromCookies(cookies)
{
    return cookies
        .filter((cookie) =>
        {
            return Boolean(cookie?.name) && Boolean(cookie?.value);
        })
        .map((cookie) =>
        {
            return `${cookie.name}=${cookie.value}`;
        })
        .join("; ");
}

function NormalizeCookieDomain(domain)
{
    const normalizedDomain = String(domain ?? "").trim();

    if (!normalizedDomain)
    {
        return ".douyin.com";
    }

    return normalizedDomain.startsWith(".")
        ? normalizedDomain
        : normalizedDomain;
}

function ParseCookieExpires(expiresValue)
{
    const normalizedValue = String(expiresValue ?? "").trim();

    if (!normalizedValue || normalizedValue.toLowerCase() === "session")
    {
        return -1;
    }

    const asNumber = Number(normalizedValue);

    if (Number.isFinite(asNumber) && asNumber > 0)
    {
        return asNumber;
    }

    const parsedTime = Date.parse(normalizedValue);
    return Number.isNaN(parsedTime) ? -1 : Math.floor(parsedTime / 1000);
}

function NormalizeSameSite(sameSiteValue)
{
    const normalizedValue = String(sameSiteValue ?? "").trim().toLowerCase();

    if (normalizedValue === "strict")
    {
        return "Strict";
    }

    if (normalizedValue === "none")
    {
        return "None";
    }

    return "Lax";
}

function ParseCookieRows(cookieText)
{
    const normalizedText = String(cookieText ?? "").trim();

    if (!normalizedText)
    {
        return [];
    }

    if (!normalizedText.includes("\n") && normalizedText.includes("=") && normalizedText.includes(";"))
    {
        return normalizedText
            .split(";")
            .map((entry) => entry.trim())
            .filter(Boolean)
            .map((entry) =>
            {
                const separatorIndex = entry.indexOf("=");

                if (separatorIndex <= 0)
                {
                    return null;
                }

                return {
                    name: entry.slice(0, separatorIndex).trim(),
                    value: entry.slice(separatorIndex + 1).trim(),
                    domain: ".douyin.com",
                    path: "/",
                    expires: -1,
                    httpOnly: false,
                    secure: true,
                    sameSite: "Lax",
                };
            })
            .filter(Boolean);
    }

    const cookies = [];
    const lines = normalizedText.split(/\r?\n/);

    for (const rawLine of lines)
    {
        const line = rawLine.trim();

        if (!line)
        {
            continue;
        }

        const columns = line.includes("\t")
            ? line.split(/\t+/).map((part) => part.trim()).filter(Boolean)
            : line.split(/\s{2,}/).map((part) => part.trim()).filter(Boolean);

        if (columns.length >= 7 && columns[0].includes("douyin.com") && columns[2].startsWith("/"))
        {
            cookies.push(
                {
                    domain: NormalizeCookieDomain(columns[0]),
                    path: columns[2] || "/",
                    secure: columns[3]?.toLowerCase?.() === "true",
                    expires: ParseCookieExpires(columns[4]),
                    name: columns[5],
                    value: columns[6] ?? "",
                    httpOnly: false,
                    sameSite: "Lax",
                },
            );
            continue;
        }

        if (columns.length >= 4 && columns[2].includes("douyin.com"))
        {
            cookies.push(
                {
                    name: columns[0],
                    value: columns[1] ?? "",
                    domain: NormalizeCookieDomain(columns[2]),
                    path: columns[3] || "/",
                    expires: ParseCookieExpires(columns[4]),
                    httpOnly: false,
                    secure: columns.includes("✓") || columns.some((column) => column.toLowerCase() === "none"),
                    sameSite: NormalizeSameSite(columns.find((column) =>
                    {
                        const normalizedColumn = column.toLowerCase();
                        return normalizedColumn === "lax" || normalizedColumn === "strict" || normalizedColumn === "none";
                    }) ?? "Lax"),
                },
            );
        }
    }

    return cookies.filter((cookie) =>
    {
        return Boolean(cookie.name) && Boolean(cookie.value) && cookie.domain.includes("douyin.com");
    });
}

function ParseSetCookieHeaders(setCookieHeaders, fallbackDomain)
{
    const parsedCookies = [];

    for (const rawHeader of setCookieHeaders)
    {
        const header = String(rawHeader ?? "").trim();

        if (!header)
        {
            continue;
        }

        const segments = header.split(";").map((part) => part.trim()).filter(Boolean);
        const [nameValue, ...attributes] = segments;
        const separatorIndex = nameValue.indexOf("=");

        if (separatorIndex <= 0)
        {
            continue;
        }

        const cookie =
        {
            name: nameValue.slice(0, separatorIndex).trim(),
            value: nameValue.slice(separatorIndex + 1).trim(),
            domain: NormalizeCookieDomain(fallbackDomain),
            path: "/",
            expires: -1,
            httpOnly: false,
            secure: false,
            sameSite: "Lax",
        };

        for (const attribute of attributes)
        {
            const [rawKey, ...rawValueParts] = attribute.split("=");
            const key = String(rawKey ?? "").trim().toLowerCase();
            const value = rawValueParts.join("=").trim();

            if (key === "domain")
            {
                cookie.domain = NormalizeCookieDomain(value);
                continue;
            }

            if (key === "path")
            {
                cookie.path = value || "/";
                continue;
            }

            if (key === "expires")
            {
                cookie.expires = ParseCookieExpires(value);
                continue;
            }

            if (key === "max-age")
            {
                const maxAgeSeconds = Number(value);

                if (Number.isFinite(maxAgeSeconds) && maxAgeSeconds > 0)
                {
                    cookie.expires = Math.floor(Date.now() / 1000) + maxAgeSeconds;
                }

                continue;
            }

            if (key === "samesite")
            {
                cookie.sameSite = NormalizeSameSite(value);
                continue;
            }

            if (key === "secure")
            {
                cookie.secure = true;
                continue;
            }

            if (key === "httponly")
            {
                cookie.httpOnly = true;
            }
        }

        parsedCookies.push(cookie);
    }

    return parsedCookies;
}

function DeduplicateCookies(cookies)
{
    const cookieMap = new Map();

    for (const cookie of cookies)
    {
        if (!cookie?.name || !cookie?.value)
        {
            continue;
        }

        const domain = String(cookie.domain ?? "").trim() || ".douyin.com";
        const path = String(cookie.path ?? "/").trim() || "/";
        const key = `${cookie.name}::${domain}::${path}`;
        cookieMap.set(key, { ...cookie, domain, path });
    }

    return [...cookieMap.values()];
}

function GetSetCookieHeaders(response)
{
    if (typeof response.headers.getSetCookie === "function")
    {
        return response.headers.getSetCookie();
    }

    const singleHeader = response.headers.get("set-cookie");
    return singleHeader ? [singleHeader] : [];
}

async function FetchGuestCookiesAsync(videoUrl)
{
    const guestCookies = [];
    const pageResponse = await fetch(videoUrl,
    {
        headers:
        {
            "User-Agent": CONTEXT_OPTIONS.userAgent,
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        },
        redirect: "follow",
    });

    guestCookies.push(
        ...ParseSetCookieHeaders(
            GetSetCookieHeaders(pageResponse),
            new URL(videoUrl).hostname,
        ),
    );

    const ttwidResponse = await fetch(TTwid_REGISTER_URL,
    {
        method: "POST",
        headers:
        {
            "Content-Type": "application/json",
            "User-Agent": CONTEXT_OPTIONS.userAgent,
        },
        body: TTwid_REGISTER_PAYLOAD,
    });

    guestCookies.push(
        ...ParseSetCookieHeaders(
            GetSetCookieHeaders(ttwidResponse),
            ".douyin.com",
        ),
    );

    guestCookies.push(
        {
            name: "s_v_web_id",
            value: GenerateVerifyFp(),
            domain: "www.douyin.com",
            path: "/",
            expires: Math.floor(Date.now() / 1000) + (60 * 60 * 24 * 30),
            httpOnly: false,
            secure: false,
            sameSite: "Lax",
        },
    );

    return DeduplicateCookies(guestCookies).filter((cookie) =>
    {
        return Boolean(cookie.name) && Boolean(cookie.value);
    });
}

async function EnsureUsableCookiesAsync(videoUrl)
{
    const storedCookies = GetStoredCookies();

    if (HasAnyUsableCookies(storedCookies))
    {
        return storedCookies;
    }

    const guestCookies = await FetchGuestCookiesAsync(videoUrl);

    if (guestCookies.length === 0)
    {
        return [];
    }

    WriteAuthState(
        {
            cookies: guestCookies,
            origins: [],
        },
    );

    return guestCookies;
}

function GetCachedAuthStatus()
{
    const authState = ReadAuthState();
    const cookies = Array.isArray(authState?.cookies) ? authState.cookies : [];
    const isLoggedIn = HasValidAuthCookies(cookies);
    const hasUsableCookies = HasAnyUsableCookies(cookies);
    const lastSyncedAt = fs.existsSync(AUTH_STATE_PATH)
        ? fs.statSync(AUTH_STATE_PATH).mtime.toISOString()
        : "";
    const directApiState = ReadDirectApiState();
    const hasCommentApiTemplateUrl = Boolean(GetConfiguredCommentApiTemplateUrl());
    const hasReplyApiTemplateUrl = Boolean(GetConfiguredReplyApiTemplateUrl());

    return {
        isLoggedIn,
        hasUsableCookies,
        hasCachedState: Boolean(authState),
        lastSyncedAt,
        hasCommentApiTemplateUrl,
        hasReplyApiTemplateUrl,
        supportsDirectApi: hasUsableCookies,
        directApiUpdatedAt: String(directApiState?.updatedAt ?? ""),
    };
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
            const authStatus = GetCachedAuthStatus();
            const contextOptions = authStatus.hasCachedState
                ? {
                    ...CONTEXT_OPTIONS,
                    storageState: AUTH_STATE_PATH,
                }
                : CONTEXT_OPTIONS;
            const context = await browser.newContext(contextOptions);

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

async function FetchTopLevelCommentsViaNodeApiAsync(cookieHeader, videoId, maxComments, startCursor, bootstrapApiUrl, refererUrl)
{
    const commentsById = new Map();
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

async function FetchTopLevelCommentsViaSignedNodeApiAsync(cookies, cookieHeader, videoId, maxComments, startCursor, refererUrl)
{
    const commentsById = new Map();
    let cursor = startCursor;
    let hasMore = true;
    let pageCount = 0;
    let reportedTotal = 0;

    while (hasMore && commentsById.size < (maxComments > 0 ? maxComments : MAX_TOP_LEVEL_COMMENTS) && pageCount < 40)
    {
        const requestUrl = BuildSignedCommentListUrl(
            videoId,
            cursor,
            COMMENT_PAGE_SIZE,
            cookies,
            CONTEXT_OPTIONS.userAgent,
        );
        const controller = new AbortController();
        const timeoutId = setTimeout(() =>
        {
            controller.abort();
        }, INTERNAL_COMMENT_REQUEST_TIMEOUT_MS);

        let response;

        try
        {
            response = await fetch(requestUrl,
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
            throw new Error(`Douyin signed API trả về HTTP ${response.status}.`);
        }

        const text = await response.text();

        if (!text.trim())
        {
            throw new Error("Douyin signed API trả về body rỗng.");
        }

        const pageResult = JSON.parse(text);
        const statusCode = Number(pageResult?.status_code ?? 0);

        if (statusCode !== 0)
        {
            throw new Error(`Douyin signed API trả về status_code=${statusCode}.`);
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
        source: "douyin-signed-api",
    };
}

function DeriveReplyApiTemplateUrlFromCommentTemplateUrl(commentApiTemplateUrl)
{
    const trimmedUrl = String(commentApiTemplateUrl ?? "").trim();

    if (!trimmedUrl)
    {
        return "";
    }

    try
    {
        const derivedUrl = new URL(trimmedUrl);
        derivedUrl.pathname = COMMENT_REPLY_LIST_PATH;
        return derivedUrl.toString();
    }
    catch
    {
        return "";
    }
}

async function FetchRepliesViaNodeApiAsync(cookieHeader, videoId, commentId, maxReplies, bootstrapApiUrl, refererUrl)
{
    const repliesById = new Map();
    let cursor = 0;
    let hasMore = true;
    let pageCount = 0;
    const normalizedMaxReplies = maxReplies > 0 ? maxReplies : MAX_TOP_LEVEL_COMMENTS;

    while (hasMore && repliesById.size < normalizedMaxReplies && pageCount < 40)
    {
        const requestUrl = new URL(bootstrapApiUrl);
        const controller = new AbortController();
        const timeoutId = setTimeout(() =>
        {
            controller.abort();
        }, INTERNAL_COMMENT_REQUEST_TIMEOUT_MS);

        requestUrl.searchParams.set("aweme_id", videoId);
        requestUrl.searchParams.set("comment_id", commentId);
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
                    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
                    cookie: cookieHeader,
                    referer: refererUrl,
                    "sec-fetch-dest": "empty",
                    "sec-fetch-mode": "cors",
                    "sec-fetch-site": "same-origin",
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
            throw new Error(`Douyin reply API trả về HTTP ${response.status}.`);
        }

        const text = await response.text();

        if (!text || !text.trim())
        {
            throw new Error("Douyin reply API trả về body rỗng (có thể bị block).");
        }

        const pageResult = JSON.parse(text);
        const statusCode = Number(pageResult?.status_code ?? 0);

        if (statusCode !== 0)
        {
            throw new Error(`Douyin reply API trả về status_code=${statusCode}.`);
        }

        const replies = Array.isArray(pageResult?.comments) ? pageResult.comments : [];

        for (const reply of replies)
        {
            if (reply?.cid)
            {
                repliesById.set(reply.cid, reply);
            }
        }

        const nextCursor = Number(pageResult?.cursor ?? cursor);
        const nextHasMore = Boolean(pageResult?.has_more ?? pageResult?.hasMore);

        if (!nextHasMore || nextCursor === cursor || replies.length === 0)
        {
            hasMore = nextHasMore && nextCursor !== cursor && replies.length > 0;
            cursor = nextCursor;
            break;
        }

        cursor = nextCursor;
        hasMore = nextHasMore;
        pageCount += 1;
    }

    return {
        replies: [...repliesById.values()],
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

async function FetchRepliesViaWebpackAsync(page, videoId, commentTargets)
{
    return page.evaluate(async ({
        commentReplyListPath,
        commentListPath,
        commentTargets,
        pageSize,
        videoId,
        webpackChunkPrefix,
        requestTimeoutMs,
        replyRequestTimeoutMs,
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
            window[chunkName].push([[Symbol("dycomment-replies")], {}, (currentRequire) =>
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

            throw new Error("Không tìm thấy module reply nội bộ của Douyin.");
        }

        const webpackRequire = GetWebpackRequire();
        const commentModule = GetCommentModule(webpackRequire);
        const fetchReplyList = commentModule.rs;
        const replyMap = {};

        // Cho Douyin client thêm thời gian khởi động trước khi gọi reply API
        await new Promise((resolve) => setTimeout(resolve, 1500));

        for (const target of commentTargets)
        {
            const repliesById = new Map();
            let cursor = 0;
            let hasMore = true;
            let pageCount = 0;

            while (hasMore && repliesById.size < target.replyTotal && pageCount < 40)
            {
                const pageResult = await Promise.race([
                    fetchReplyList({
                        awemeId: videoId,
                        commentId: target.commentId,
                        cursor,
                        count: pageSize,
                    }),
                    new Promise((_, reject) =>
                    {
                        setTimeout(() =>
                        {
                            reject(new Error(`Reply request timeout for ${target.commentId}`));
                        }, replyRequestTimeoutMs);
                    }),
                ]);

                const replies = Array.isArray(pageResult?.comments) ? pageResult.comments : [];

                for (const reply of replies)
                {
                    if (reply?.cid)
                    {
                        repliesById.set(reply.cid, reply);
                    }
                }

                const nextCursor = Number(pageResult?.cursor ?? cursor);
                const nextHasMore = Boolean(pageResult?.hasMore ?? pageResult?.has_more);

                if (!nextHasMore || nextCursor === cursor || replies.length === 0)
                {
                    hasMore = false;
                    break;
                }

                cursor = nextCursor;
                hasMore = nextHasMore;
                pageCount += 1;
            }

            replyMap[target.commentId] = [...repliesById.values()];
        }

        return replyMap;
    },
    {
        commentReplyListPath: COMMENT_REPLY_LIST_PATH,
        commentListPath: COMMENT_LIST_PATH,
        commentTargets,
        pageSize: COMMENT_PAGE_SIZE,
        videoId,
        webpackChunkPrefix: WEBPACK_CHUNK_PREFIX,
        requestTimeoutMs: INTERNAL_COMMENT_REQUEST_TIMEOUT_MS,
        replyRequestTimeoutMs: 25000,
    });
}

async function FetchRepliesViaCapturedApiAsync(page, videoId, commentId, maxReplies, bootstrapApiUrl)
{
    return page.evaluate(async ({ bootstrapApiUrl, replyPath, pageSize, videoId, commentId, maxReplies, requestTimeoutMs }) =>
    {
        const repliesById = new Map();
        let cursor = 0;
        let hasMore = true;
        let pageCount = 0;

        // Xây URL reply: ưu tiên dùng URL thực capture được, fallback sang URL thuần
        function BuildReplyUrl(cursor, count)
        {
            let base;

            if (bootstrapApiUrl && bootstrapApiUrl.includes(replyPath))
            {
                // URL thực từ Douyin response — có đầy đủ signed params
                base = new URL(bootstrapApiUrl);
            }
            else
            {
                // Build URL thuần từ origin Douyin
                base = new URL(replyPath, "https://www.douyin.com");
            }

            base.searchParams.set("aweme_id", videoId);
            base.searchParams.set("comment_id", commentId);
            base.searchParams.set("cursor", String(cursor));
            base.searchParams.set("count", String(count));
            return base.toString();
        }

        while (hasMore && repliesById.size < (maxReplies > 0 ? maxReplies : 400) && pageCount < 40)
        {
            const requestUrl = BuildReplyUrl(cursor, pageSize);
            const controller = new AbortController();
            const timeoutId = setTimeout(() =>
            {
                controller.abort();
            }, requestTimeoutMs);
            let response;

            try
            {
                response = await fetch(requestUrl,
                {
                    credentials: "include",
                    headers:
                    {
                        accept: "application/json, text/plain, */*",
                        referer: location.href,
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
                throw new Error(`Douyin reply API trả về HTTP ${response.status}.`);
            }

            const text = await response.text();

            if (!text || !text.trim())
            {
                throw new Error("Douyin reply API trả về body rỗng (có thể bị block).");
            }

            const pageResult = JSON.parse(text);
            const statusCode = Number(pageResult?.status_code ?? 0);

            if (statusCode !== 0)
            {
                throw new Error(`Douyin reply API trả về status_code=${statusCode}.`);
            }

            const replies = Array.isArray(pageResult?.comments) ? pageResult.comments : [];

            for (const reply of replies)
            {
                if (reply?.cid)
                {
                    repliesById.set(reply.cid, reply);
                }
            }

            const nextCursor = Number(pageResult?.cursor ?? cursor);
            const nextHasMore = Boolean(pageResult?.has_more ?? pageResult?.hasMore);

            if (!nextHasMore || nextCursor === cursor || replies.length === 0)
            {
                hasMore = nextHasMore && nextCursor !== cursor && replies.length > 0;
                cursor = nextCursor;
                break;
            }

            cursor = nextCursor;
            hasMore = nextHasMore;
            pageCount += 1;
        }

        return {
            replies: [...repliesById.values()],
        };
    },
    {
        bootstrapApiUrl,
        replyPath: COMMENT_REPLY_LIST_PATH,
        pageSize: COMMENT_PAGE_SIZE,
        videoId,
        commentId,
        maxReplies,
        requestTimeoutMs: INTERNAL_COMMENT_REQUEST_TIMEOUT_MS,
    });
}

async function FetchRepliesViaSignedNodeApiAsync(cookies, cookieHeader, videoId, commentId, maxReplies, refererUrl)
{
    const repliesById = new Map();
    let cursor = 0;
    let hasMore = true;
    let pageCount = 0;
    const normalizedMaxReplies = maxReplies > 0 ? maxReplies : MAX_TOP_LEVEL_COMMENTS;

    while (hasMore && repliesById.size < normalizedMaxReplies && pageCount < 40)
    {
        const requestUrl = BuildSignedReplyListUrl(
            videoId,
            commentId,
            cursor,
            COMMENT_PAGE_SIZE,
            cookies,
            CONTEXT_OPTIONS.userAgent,
        );
        const controller = new AbortController();
        const timeoutId = setTimeout(() =>
        {
            controller.abort();
        }, INTERNAL_COMMENT_REQUEST_TIMEOUT_MS);

        let response;

        try
        {
            response = await fetch(requestUrl,
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
            throw new Error(`Douyin signed reply API trả về HTTP ${response.status}.`);
        }

        const text = await response.text();

        if (!text.trim())
        {
            throw new Error("Douyin signed reply API trả về body rỗng.");
        }

        const pageResult = JSON.parse(text);
        const statusCode = Number(pageResult?.status_code ?? 0);

        if (statusCode !== 0)
        {
            throw new Error(`Douyin signed reply API trả về status_code=${statusCode}.`);
        }

        const replies = Array.isArray(pageResult?.comments) ? pageResult.comments : [];

        for (const reply of replies)
        {
            if (reply?.cid)
            {
                repliesById.set(reply.cid, reply);
            }
        }

        const nextCursor = Number(pageResult?.cursor ?? cursor);
        const nextHasMore = Boolean(pageResult?.has_more ?? pageResult?.hasMore);

        if (!nextHasMore || nextCursor === cursor || replies.length === 0)
        {
            hasMore = nextHasMore && nextCursor !== cursor && replies.length > 0;
            cursor = nextCursor;
            break;
        }

        cursor = nextCursor;
        hasMore = nextHasMore;
        pageCount += 1;
    }

    return {
        replies: [...repliesById.values()],
        source: "douyin-signed-api",
    };
}

async function WaitForLoginCookiesAsync(context)
{
    const startedAt = Date.now();

    while (Date.now() - startedAt < COOKIE_SYNC_TIMEOUT_MS)
    {
        if (context.pages().length === 0)
        {
            throw new Error("Cửa sổ đồng bộ cookie đã bị đóng trước khi đăng nhập xong.");
        }

        const cookies = await context.cookies("https://www.douyin.com");

        if (HasValidAuthCookies(cookies))
        {
            return cookies;
        }

        await new Promise((resolve) =>
        {
            setTimeout(resolve, COOKIE_POLL_INTERVAL_MS);
        });
    }

    throw new Error("Đồng bộ cookie quá thời gian chờ. Hãy thử lại và đăng nhập hoàn tất trong cửa sổ Douyin.");
}

export class DouyinService
{
    async WarmupAsync()
    {
        const authStatus = GetCachedAuthStatus();

        if (authStatus.supportsDirectApi)
        {
            return;
        }

        const warmupUrl = config.douyinWarmupVideoUrl || "https://www.douyin.com/";

        try
        {
            const warmupCookies = await EnsureUsableCookiesAsync(warmupUrl);

            if (HasAnyUsableCookies(warmupCookies))
            {
                return;
            }
        }
        catch
        {
            // Nếu bootstrap guest cookie thất bại thì mới fallback sang browser.
        }

        await GetSharedContextAsync();

        if (config.douyinWarmupVideoUrl && !GetConfiguredCommentApiTemplateUrl())
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

    GetAuthStatus()
    {
        return GetCachedAuthStatus();
    }

    async ImportCookiesAsync(cookieText)
    {
        const parsedCookies = ParseCookieRows(cookieText);

        if (parsedCookies.length === 0)
        {
            throw new Error("KhÃ´ng parse Ä‘Æ°á»£c cookie Douyin tá»« ná»™i dung Ä‘Ã£ dÃ¡n.");
        }

        WriteAuthState(
            {
                cookies: parsedCookies,
                origins: [],
            },
        );
        await CloseSharedPlaywrightAsync();

        return GetCachedAuthStatus();
    }

    ConfigureDirectApi(templateConfig)
    {
        const commentApiTemplateUrl = String(templateConfig?.commentApiTemplateUrl ?? "").trim();
        const replyApiTemplateUrl = String(templateConfig?.replyApiTemplateUrl ?? "").trim();

        if (commentApiTemplateUrl)
        {
            SaveCommentApiTemplateUrl(commentApiTemplateUrl);
        }

        if (replyApiTemplateUrl)
        {
            SaveReplyApiTemplateUrl(replyApiTemplateUrl);
        }

        return GetCachedAuthStatus();
    }

    async SyncCookiesAsync()
    {
        if (cookieSyncPromise)
        {
            return cookieSyncPromise;
        }

        cookieSyncPromise = (async () =>
        {
            EnsureAuthDirectories();
            await CloseSharedPlaywrightAsync();

            const persistentContext = await chromium.launchPersistentContext(
                AUTH_USER_DATA_DIR,
                {
                    ...BROWSER_LAUNCH_OPTIONS,
                    headless: false,
                    viewport: CONTEXT_OPTIONS.viewport,
                    userAgent: CONTEXT_OPTIONS.userAgent,
                    locale: CONTEXT_OPTIONS.locale,
                },
            );

            try
            {
                const page = persistentContext.pages()[0] ?? await persistentContext.newPage();

                await page.goto("https://www.douyin.com/",
                {
                    waitUntil: "domcontentloaded",
                    timeout: 60000,
                });
                await WaitForLoginCookiesAsync(persistentContext);
                await persistentContext.storageState({ path: AUTH_STATE_PATH });
            }
            finally
            {
                await persistentContext.close().catch(() =>
                {
                    return null;
                });
            }

            await CloseSharedPlaywrightAsync();

            const authStatus = GetCachedAuthStatus();

            if (!authStatus.isLoggedIn)
            {
                throw new Error("Đã lưu state nhưng không tìm thấy cookie đăng nhập hợp lệ của Douyin.");
            }

            return authStatus;
        })();

        try
        {
            return await cookieSyncPromise;
        }
        finally
        {
            cookieSyncPromise = null;
        }
    }

    async GetRepliesAsync(videoUrl, commentId, maxReplies = 0)
    {
        const resolvedUrl = await ResolveShortUrlAsync(videoUrl);
        const videoId = ExtractVideoId(resolvedUrl);
        const canonicalVideoUrl = BuildCanonicalVideoUrl(resolvedUrl);
        const storedCookies = await EnsureUsableCookiesAsync(canonicalVideoUrl).catch(() =>
        {
            return GetStoredCookies();
        });
        const cookieHeader = BuildCookieHeaderFromCookies(storedCookies);
        const authStatus = GetCachedAuthStatus();
        let signedApiErrorMessage = "";

        if (cookieHeader)
        {
            try
            {
                const signedResult = await WithTimeoutAsync(
                    FetchRepliesViaSignedNodeApiAsync(
                        storedCookies,
                        cookieHeader,
                        videoId,
                        commentId,
                        maxReplies,
                        canonicalVideoUrl,
                    ),
                    GET_COMMENTS_TIMEOUT_MS,
                    "Lấy phản hồi từ Douyin signed API bị quá thời gian chờ.",
                );
                const normalizedReplies = signedResult.replies.map((reply, index) =>
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
            catch (error)
            {
                // Chủ động fallback sang luồng Playwright cũ nếu signer chưa đủ ổn định.
                signedApiErrorMessage = error instanceof Error ? error.message : "Douyin signed API thất bại.";
            }
        }

        if (!authStatus.isLoggedIn)
        {
            return {
                replies: [],
                replyStatus:
                {
                    fetchedReplies: false,
                    requiresLogin: true,
                    blockedByVerification: false,
                    fetchedReplyCommentCount: 0,
                },
            };
        }

        const context = await GetSharedContextAsync();

        // Mở Playwright page, dùng webpack trước và fallback sang in-browser captured API
        const page = await context.newPage();
        const replyApiBootstrap = { value: "" };
        const replyBootstrapResponseHandler = (response) =>
        {
            const url = response.url();

            if (!replyApiBootstrap.value && url.includes(COMMENT_REPLY_LIST_PATH))
            {
                replyApiBootstrap.value = url;
                SaveReplyApiTemplateUrl(url);
            }
        };

        page.on("response", replyBootstrapResponseHandler);

        try
        {
            await WithTimeoutAsync(
                page.goto(canonicalVideoUrl,
                {
                    waitUntil: "domcontentloaded",
                    timeout: 60000,
                }),
                COMMENT_STEP_TIMEOUT_MS,
                "Mở trang Douyin quá lâu khi lấy phản hồi.",
            );
            await WithTimeoutAsync(
                WaitForDouyinClientReadyAsync(page, { value: "" }),
                COMMENT_STEP_TIMEOUT_MS,
                "Douyin tải client quá lâu khi lấy phản hồi.",
            );

            // Chờ Douyin client khởi tạo xong và warm up session
            await page.waitForTimeout(2000);

            let rawReplies = [];
            let webpackError;

            try
            {
                const replyMap = await WithTimeoutAsync(
                    FetchRepliesViaWebpackAsync(page, videoId,
                    [
                        {
                            commentId,
                            replyTotal: maxReplies > 0 ? maxReplies : MAX_TOP_LEVEL_COMMENTS,
                        },
                    ]),
                    GET_COMMENTS_TIMEOUT_MS,
                    "Lấy phản hồi từ Douyin bị quá thời gian chờ.",
                );
                rawReplies = Array.isArray(replyMap?.[commentId]) ? replyMap[commentId] : [];
            }
            catch (firstError)
            {
                webpackError = firstError;

                // Fallback: luôn thử in-browser fetch (credentials:include),
                // FetchRepliesViaCapturedApiAsync tự build URL nếu không có URL thực
                const configuredReplyTemplateUrl = GetConfiguredReplyApiTemplateUrl();
                const derivedReplyTemplateUrl = DeriveReplyApiTemplateUrlFromCommentTemplateUrl(
                    GetConfiguredCommentApiTemplateUrl(),
                );
                const fallbackCandidates = [
                    replyApiBootstrap.value,
                    configuredReplyTemplateUrl,
                    derivedReplyTemplateUrl,
                ].filter(Boolean);
                const fallbackUrl = fallbackCandidates[0] ?? "";

                try
                {
                    const capturedResult = await WithTimeoutAsync(
                        FetchRepliesViaCapturedApiAsync(
                            page,
                            videoId,
                            commentId,
                            maxReplies,
                            fallbackUrl,
                        ),
                        GET_COMMENTS_TIMEOUT_MS,
                        "Lấy phản hồi qua in-browser API bị quá thời gian chờ.",
                    );
                    rawReplies = capturedResult.replies;
                    webpackError = null;
                }
                catch (apiError)
                {
                    const nodeFallbackCookieHeader = BuildCookieHeaderFromCookies(GetStoredCookies());

                    if (nodeFallbackCookieHeader && fallbackUrl)
                    {
                        try
                        {
                            const nodeFallbackResult = await WithTimeoutAsync(
                                FetchRepliesViaNodeApiAsync(
                                    nodeFallbackCookieHeader,
                                    videoId,
                                    commentId,
                                    maxReplies,
                                    fallbackUrl,
                                    canonicalVideoUrl,
                                ),
                                GET_COMMENTS_TIMEOUT_MS,
                                "Lấy phản hồi qua Node direct API bị quá thời gian chờ.",
                            );
                            rawReplies = nodeFallbackResult.replies;
                            webpackError = null;
                        }
                        catch (nodeError)
                        {
                            const webpackMsg = webpackError instanceof Error ? webpackError.message : "Không rõ lý do.";
                            const apiMsg = apiError instanceof Error ? apiError.message : "Không rõ lý do.";
                            const nodeMsg = nodeError instanceof Error ? nodeError.message : "Không rõ lý do.";
                            const signedMsg = signedApiErrorMessage ? ` | signed API (${signedApiErrorMessage})` : "";

                            throw new Error(
                                `Lấy phản hồi thất bại: webpack (${webpackMsg}) | in-browser API (${apiMsg}) | node API (${nodeMsg})${signedMsg}.`,
                            );
                        }
                    }

                    const webpackMsg = webpackError instanceof Error ? webpackError.message : "Không rõ lý do.";
                    const apiMsg = apiError instanceof Error ? apiError.message : "Không rõ lý do.";
                    const signedMsg = signedApiErrorMessage ? ` | signed API (${signedApiErrorMessage})` : "";

                    throw new Error(`Lấy phản hồi thất bại: webpack (${webpackMsg}) | in-browser API (${apiMsg})${signedMsg}.`);
                }
            }

            const trimmedReplies = maxReplies > 0 ? rawReplies.slice(0, maxReplies) : rawReplies;
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
        catch (error)
        {
            return {
                replies: [],
                replyStatus:
                {
                    fetchedReplies: false,
                    requiresLogin: false,
                    blockedByVerification: true,
                    fetchedReplyCommentCount: 0,
                    error: error instanceof Error ? error.message : "Lấy phản hồi thất bại.",
                },
            };
        }
        finally
        {
            page.off("response", replyBootstrapResponseHandler);
            await page.close().catch(() =>
            {
                return null;
            });
        }
    }

    async GetCommentsAsync(videoUrl, maxComments = 0, startCursor = 0)
    {
        const resolvedUrl = await ResolveShortUrlAsync(videoUrl);
        const videoId = ExtractVideoId(resolvedUrl);
        const canonicalVideoUrl = BuildCanonicalVideoUrl(resolvedUrl);
        const storedCookies = await EnsureUsableCookiesAsync(canonicalVideoUrl).catch(() =>
        {
            return GetStoredCookies();
        });
        const cookieHeader = BuildCookieHeaderFromCookies(storedCookies);
        const authStatus = GetCachedAuthStatus();
        const normalizedMaxComments = maxComments > 0 ? maxComments : MAX_TOP_LEVEL_COMMENTS;
        const commentApiTemplateUrl = GetConfiguredCommentApiTemplateUrl();

        if (cookieHeader)
        {
            try
            {
                const signedApiResult = await WithTimeoutAsync(
                    FetchTopLevelCommentsViaSignedNodeApiAsync(
                        storedCookies,
                        cookieHeader,
                        videoId,
                        normalizedMaxComments,
                        startCursor,
                        canonicalVideoUrl,
                    ),
                    GET_COMMENTS_TIMEOUT_MS,
                    "Lấy comment từ Douyin signed API bị quá thời gian chờ.",
                );
                const normalizedComments = signedApiResult.comments.map((comment, index) =>
                {
                    return NormalizeTopLevelComment(comment, index);
                });

                return {
                    videoId,
                    comments: normalizedComments,
                    source: signedApiResult.source,
                    topLevelCommentCount: normalizedComments.length,
                    reportedCommentCount: signedApiResult.reportedTotal,
                    nextCursor: signedApiResult.nextCursor,
                    douyinHasMore: signedApiResult.douyinHasMore,
                    replyStatus:
                    {
                        fetchedReplies: false,
                        requiresLogin: !authStatus.isLoggedIn,
                        blockedByVerification: false,
                        fetchedReplyCommentCount: 0,
                    },
                };
            }
            catch
            {
                // Fallback sang template URL hoặc Playwright nếu signer hiện tại bị chặn.
            }
        }

        if (commentApiTemplateUrl && cookieHeader)
        {
            try
            {
                const directApiResult = await WithTimeoutAsync(
                    FetchTopLevelCommentsViaNodeApiAsync(
                        cookieHeader,
                        videoId,
                        normalizedMaxComments,
                        startCursor,
                        commentApiTemplateUrl,
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
                    replyStatus:
                    {
                        fetchedReplies: false,
                        requiresLogin: !authStatus.isLoggedIn,
                        blockedByVerification: false,
                        fetchedReplyCommentCount: 0,
                    },
                };
            }
            catch
            {
                ClearPersistedCommentApiTemplateUrl();
            }
        }

        const context = await GetSharedContextAsync();
        const page = await context.newPage();
        const commentApiBootstrap =
        {
            value: "",
        };
        const commentBootstrapResponseHandler = (response) =>
        {
            const url = response.url();

            if (url.includes(COMMENT_REPLY_LIST_PATH))
            {
                if (!GetConfiguredReplyApiTemplateUrl())
                {
                    SaveReplyApiTemplateUrl(url);
                }

                return;
            }

            if (commentApiBootstrap.value || !url.includes(COMMENT_LIST_PATH))
            {
                return;
            }

            commentApiBootstrap.value = url;
            SaveCommentApiTemplateUrl(url);
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
            let replyStatus =
            {
                fetchedReplies: false,
                requiresLogin: !authStatus.isLoggedIn,
                blockedByVerification: false,
                fetchedReplyCommentCount: 0,
            };

            if (authStatus.isLoggedIn)
            {
                const replyTargets = topLevelResult.comments
                    .filter((comment) => Number(comment.replyTotal ?? comment.reply_comment_total ?? 0) > 0)
                    .map((comment) =>
                    {
                        return {
                            commentId: comment.cid,
                            replyTotal: Number(comment.replyTotal ?? comment.reply_comment_total ?? 0),
                        };
                    });

                if (replyTargets.length > 0)
                {
                    try
                    {
                        const replyMap = await WithTimeoutAsync(
                            FetchRepliesViaWebpackAsync(page, videoId, replyTargets),
                            GET_COMMENTS_TIMEOUT_MS,
                            "Lấy reply từ Douyin bị quá thời gian chờ.",
                        );
                        let fetchedReplyCommentCount = 0;

                        for (const normalizedComment of normalizedComments)
                        {
                            const replies = Array.isArray(replyMap?.[normalizedComment.commentId])
                                ? replyMap[normalizedComment.commentId]
                                : [];
                            normalizedComment.replies = replies.map((reply, index) =>
                            {
                                return NormalizeReplyComment(reply, index);
                            });
                            fetchedReplyCommentCount += normalizedComment.replies.length;
                        }

                        replyStatus =
                        {
                            fetchedReplies: fetchedReplyCommentCount > 0,
                            requiresLogin: false,
                            blockedByVerification: false,
                            fetchedReplyCommentCount,
                        };
                    }
                    catch (error)
                    {
                        replyStatus =
                        {
                            fetchedReplies: false,
                            requiresLogin: false,
                            blockedByVerification: true,
                            fetchedReplyCommentCount: 0,
                            error: error instanceof Error ? error.message : "Lấy reply thất bại.",
                        };
                    }
                }
            }

            return {
                videoId,
                comments: normalizedComments,
                source: topLevelResult.source ?? "douyin-webpack-client",
                topLevelCommentCount: normalizedComments.length,
                reportedCommentCount: topLevelResult.reportedTotal,
                nextCursor: topLevelResult.nextCursor,
                douyinHasMore: topLevelResult.douyinHasMore,
                replyStatus,
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
