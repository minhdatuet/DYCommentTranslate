import crypto from "node:crypto";

import express from "express";

import { config } from "./config.js";
import { DouyinService } from "./services/douyinService.js";
import { GeminiTranslator } from "./services/geminiTranslator.js";
import { OfflineTranslator } from "./services/offlineTranslator.js";
import { StvTranslator } from "./services/stvTranslator.js";
import { TranslationService } from "./services/translationService.js";

const USER_SESSION_COOKIE_NAME = "dyc_user_session";
const USER_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_COMMENT_LIMIT = 20;

const app = express();
const douyinService = new DouyinService();
const offlineTranslator = new OfflineTranslator(config.offlineDictDir);
const geminiTranslator = new GeminiTranslator();
const stvTranslator = new StvTranslator();
const translationService = new TranslationService(offlineTranslator, geminiTranslator, stvTranslator);
const userSessions = new Map();

function DecodeStorageStateBase64(storageStateBase64)
{
    const normalized = String(storageStateBase64 ?? "").trim();

    if (!normalized)
    {
        return null;
    }

    return JSON.parse(Buffer.from(normalized, "base64").toString("utf8"));
}

function ParseRequestCookies(cookieHeader)
{
    return String(cookieHeader ?? "")
        .split(";")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .reduce((cookies, entry) =>
        {
            const separatorIndex = entry.indexOf("=");

            if (separatorIndex <= 0)
            {
                return cookies;
            }

            const name = entry.slice(0, separatorIndex).trim();
            const value = entry.slice(separatorIndex + 1).trim();
            cookies.set(name, value);
            return cookies;
        }, new Map());
}

function BuildSessionCookie(sessionId, maxAgeSeconds, request)
{
    const encodedSessionId = encodeURIComponent(sessionId);
    const secureFlag = config.nodeEnv === "production" || request.secure ? "; Secure" : "";

    return [
        `${USER_SESSION_COOKIE_NAME}=${encodedSessionId}`,
        "Path=/",
        "HttpOnly",
        "SameSite=Lax",
        `Max-Age=${maxAgeSeconds}`,
        secureFlag,
    ].filter(Boolean).join("; ");
}

function BuildEmptyAuthStatus()
{
    return {
        isLoggedIn: false,
        hasUsableCookies: false,
        hasCachedState: false,
        lastSyncedAt: "",
        hasCommentApiTemplateUrl: Boolean(config.douyinCommentApiTemplateUrl),
        hasReplyApiTemplateUrl: Boolean(config.douyinReplyApiTemplateUrl),
        supportsDirectApi: false,
        directApiUpdatedAt: "",
    };
}

function ClearExpiredUserSessions()
{
    const now = Date.now();

    for (const [sessionId, session] of userSessions)
    {
        if (now - session.updatedAt > USER_SESSION_TTL_MS)
        {
            userSessions.delete(sessionId);
        }
    }
}

function GetUserSession(request)
{
    ClearExpiredUserSessions();

    const requestCookies = ParseRequestCookies(request.get("cookie"));
    const sessionId = requestCookies.get(USER_SESSION_COOKIE_NAME);

    if (!sessionId)
    {
        return null;
    }

    const session = userSessions.get(sessionId);

    if (!session)
    {
        return null;
    }

    session.updatedAt = Date.now();
    return session;
}

function SetUserSessionCookie(response, request, sessionId)
{
    response.setHeader(
        "Set-Cookie",
        BuildSessionCookie(sessionId, Math.floor(USER_SESSION_TTL_MS / 1000), request),
    );
}

function ClearUserSessionCookie(response, request)
{
    response.setHeader("Set-Cookie", BuildSessionCookie("", 0, request));
}

function SaveUserSession(response, request, sessionPayload)
{
    const sessionId = crypto.randomUUID();

    userSessions.set(sessionId,
    {
        cookies: sessionPayload.cookies,
        storageState: sessionPayload.storageState ??
        {
            cookies: sessionPayload.cookies,
            origins: [],
        },
        directApiState: sessionPayload.directApiState ?? {},
        syncedAt: sessionPayload.syncedAt,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    });
    SetUserSessionCookie(response, request, sessionId);
}

function RequireUserSession(request, response)
{
    const session = GetUserSession(request);
    const authStatus = session
        ? douyinService.GetAuthStatusForSession(session, session.syncedAt)
        : BuildEmptyAuthStatus();

    if (authStatus.isLoggedIn)
    {
        return session;
    }

    response.status(401).json(
    {
        ok: false,
        error: "Cần sync cookie Douyin đã đăng nhập trước khi sử dụng.",
        authStatus,
    });
    return null;
}

function NormalizeLimit(rawLimit)
{
    const limit = Number(rawLimit) || DEFAULT_COMMENT_LIMIT;
    return Math.max(1, Math.min(100, limit));
}

function NormalizeCursor(rawCursor)
{
    return Math.max(0, Number(rawCursor) || 0);
}

function ApplyDisplayIndex(comments, indexOffset)
{
    const normalizedOffset = Math.max(0, Number(indexOffset) || 0);

    return comments.map((comment, index) =>
    {
        return {
            ...comment,
            index: normalizedOffset + index + 1,
        };
    });
}

offlineTranslator.EnsureLoaded();

app.set("trust proxy", 1);
app.use(express.json(
{
    limit: "6mb",
}));
app.use(express.static(config.publicDir));

app.get("/api/health", (request, response) =>
{
    response.json(
    {
        ok: true,
        geminiConfigured: geminiTranslator.IsConfigured,
        stvConfigured: stvTranslator.IsConfigured,
        offlineDictDir: config.offlineDictDir,
        douyinSource: "user-cookies",
        userSessionTtlMs: USER_SESSION_TTL_MS,
    });
});

app.get("/api/douyin/auth-status", (request, response) =>
{
    const session = GetUserSession(request);
    const authStatus = session
        ? douyinService.GetAuthStatusForSession(session, session.syncedAt)
        : BuildEmptyAuthStatus();

    response.json(
    {
        ok: true,
        ...authStatus,
    });
});

app.post("/api/douyin/session", (request, response) =>
{
    try
    {
        const storageState = request.body?.storageState
            ?? DecodeStorageStateBase64(request.body?.storageStateBase64);
        const cookieText = String(
            request.body?.cookieHeader
            ?? request.body?.cookieText
            ?? "",
        ).trim();
        const templateUrl = String(request.body?.templateUrl ?? "").trim();
        const sessionPayload = storageState
            ? douyinService.CreateUserSessionFromStorageState(storageState)
            : douyinService.CreateUserSessionFromCookieText(cookieText, templateUrl);
        SaveUserSession(response, request, sessionPayload);

        response.json(
        {
            ok: true,
            ...sessionPayload.authStatus,
        });
    }
    catch (error)
    {
        response.status(400).json(
        {
            ok: false,
            error: error instanceof Error ? error.message : "Sync cookie Douyin thất bại.",
        });
    }
});

app.delete("/api/douyin/session", (request, response) =>
{
    const requestCookies = ParseRequestCookies(request.get("cookie"));
    const sessionId = requestCookies.get(USER_SESSION_COOKIE_NAME);

    if (sessionId)
    {
        userSessions.delete(sessionId);
    }

    ClearUserSessionCookie(response, request);
    response.json(
    {
        ok: true,
        ...BuildEmptyAuthStatus(),
    });
});



app.post("/api/comments", async (request, response) =>
{
    const session = RequireUserSession(request, response);

    if (!session)
    {
        return;
    }

    const videoUrl = String(request.body?.videoUrl ?? "").trim();
    const translationMode = String(request.body?.translationMode ?? "offline").trim().toLowerCase();
    const limit = NormalizeLimit(request.body?.limit);
    const cursor = NormalizeCursor(request.body?.cursor);
    const indexOffset = Number(request.body?.indexOffset) || 0;

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
        const result = await douyinService.GetCommentsWithCookiesAsync(
            videoUrl,
            session,
            limit,
            cursor,
        );
        if (result.directApiState)
        {
            session.directApiState =
            {
                ...(session.directApiState ?? {}),
                ...result.directApiState,
            };
        }
        if (result.storageState)
        {
            session.storageState = result.storageState;
            session.cookies = result.storageState.cookies ?? session.cookies;
        }
        const trimmedComments = result.comments.slice(0, limit);
        const translatedComments = await translationService.TranslateCommentsAsync(
            trimmedComments,
            translationMode,
        );
        const indexedComments = ApplyDisplayIndex(translatedComments, indexOffset);

        response.json(
        {
            ok: true,
            videoId: result.videoId,
            source: result.source,
            totalFetched: indexOffset + indexedComments.length,
            reportedCommentCount: result.reportedCommentCount,
            topLevelCommentCount: indexedComments.length,
            replyStatus: result.replyStatus,
            cursor,
            nextCursor: result.nextCursor,
            hasMore: indexedComments.length > 0 && result.douyinHasMore,
            comments: indexedComments,
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
    const session = RequireUserSession(request, response);

    if (!session)
    {
        return;
    }

    const videoUrl = String(request.body?.videoUrl ?? "").trim();
    const commentId = String(request.body?.commentId ?? "").trim();
    const translationMode = String(request.body?.translationMode ?? "offline").trim().toLowerCase();
    const limit = Number(request.body?.limit) || 50;

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
        const result = await douyinService.GetRepliesWithCookiesAsync(
            videoUrl,
            commentId,
            session,
            limit,
        );
        if (result.directApiState)
        {
            session.directApiState =
            {
                ...(session.directApiState ?? {}),
                ...result.directApiState,
            };
        }
        if (result.storageState)
        {
            session.storageState = result.storageState;
            session.cookies = result.storageState.cookies ?? session.cookies;
        }
        const translatedReplies = await translationService.TranslateCommentsAsync(
            result.replies,
            translationMode,
        );

        response.json(
        {
            ok: true,
            commentId,
            source: "douyin-user-cookies",
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
