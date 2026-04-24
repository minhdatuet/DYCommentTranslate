const cookieForm = document.getElementById("cookieForm");
const cookieTextInput = document.getElementById("cookieText");
const commentForm = document.getElementById("commentForm");
const submitButton = document.getElementById("submitButton");
const statusBox = document.getElementById("statusBox");
const resultTitle = document.getElementById("resultTitle");
const resultMeta = document.getElementById("resultMeta");
const commentList = document.getElementById("commentList");
const authActions = document.getElementById("authActions");
const autoLoginButton = document.getElementById("autoLoginButton");
const manualCookieButton = document.getElementById("manualCookieButton");
const loginFlowPanel = document.getElementById("loginFlowPanel");
const loginFlowStatus = document.getElementById("loginFlowStatus");
const loginFlowScreenshot = document.getElementById("loginFlowScreenshot");
const loginFlowTextInput = document.getElementById("loginFlowTextInput");
const sendLoginFlowTextButton = document.getElementById("sendLoginFlowTextButton");
const cancelLoginFlowButton = document.getElementById("cancelLoginFlowButton");
const syncCookiesButton = document.getElementById("syncCookiesButton");
const clearSessionButton = document.getElementById("clearSessionButton");
const authStatusText = document.getElementById("authStatusText");
const API_REQUEST_TIMEOUT_MS = 120000;
const DEFAULT_COMMENT_LIMIT = 20;
const LOGIN_FLOW_POLL_MS = 2000;
const LOGIN_FLOW_SCREENSHOT_MS = 2500;

let currentVideoUrl = "";
let currentTranslationMode = "";
let currentLimit = DEFAULT_COMMENT_LIMIT;
let currentCursor = 0;
let displayedCount = 0;
let hasMore = false;
let isLoadingMore = false;
let hasDouyinAuth = false;
let currentReplyLimit = 50;
let loginFlowId = "";
let loginFlowStatusTimer = 0;
let loginFlowScreenshotTimer = 0;

function SetStatus(message, variant)
{
    statusBox.textContent = message;
    statusBox.className = `status-box ${variant}`;
}

function SetCommentFormEnabled(isEnabled)
{
    for (const element of commentForm.elements)
    {
        element.disabled = !isEnabled;
    }

    submitButton.disabled = !isEnabled;
}

function SetAuthState(authStatus)
{
    hasDouyinAuth = Boolean(authStatus?.isLoggedIn);
    const hasUsableCookies = Boolean(authStatus?.hasUsableCookies);
    const syncedAt = authStatus?.lastSyncedAt
        ? new Date(authStatus.lastSyncedAt).toLocaleString("vi-VN")
        : "";

    if (hasDouyinAuth)
    {
        authStatusText.textContent = syncedAt
            ? `Đã sync cookie Douyin. Cập nhật: ${syncedAt}`
            : "Đã sync cookie Douyin.";
        authActions.hidden = true;
        cookieForm.hidden = true;
        loginFlowPanel.hidden = true;
        clearSessionButton.hidden = false;
        SetCommentFormEnabled(true);
        return;
    }

    if (hasUsableCookies)
    {
        authStatusText.textContent = "Cookie chưa đủ trạng thái đăng nhập để lấy reply.";
    }
    else
    {
        authStatusText.textContent = "Cần cookie Douyin đã đăng nhập trước khi tải comment.";
    }

    authActions.hidden = false;
    clearSessionButton.hidden = true;
    SetCommentFormEnabled(false);
}

function EscapeHtml(text)
{
    return String(text ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll("\"", "&quot;");
}

function GetTranslatedText(item)
{
    return String(item?.translatedText ?? "").trim() || "Chưa có bản dịch.";
}

function GetAvatarText(nickname)
{
    const normalizedNickname = String(nickname ?? "").trim();

    if (!normalizedNickname)
    {
        return "?";
    }

    return [...normalizedNickname][0].toUpperCase();
}

function RenderReplyItems(replies)
{
    return replies.map((reply) =>
    {
        return `
            <div class="reply-card">
                <div class="avatar avatar-small">${EscapeHtml(GetAvatarText(reply.nickname))}</div>
                <div class="reply-body">
                    <p class="reply-meta">${EscapeHtml(reply.nickname)} · ${reply.likeCount} thích</p>
                    <p class="reply-text">${EscapeHtml(GetTranslatedText(reply))}</p>
                </div>
            </div>
        `;
    }).join("");
}

function RenderCommentCards(comments)
{
    return comments.map((comment) =>
    {
        const hasReplies = Number(comment.replyCount || 0) > 0;
        const repliesHtml = Array.isArray(comment.replies) && comment.replies.length > 0
            ? `
                <div class="reply-list">
                    ${RenderReplyItems(comment.replies)}
                </div>
            `
            : "";
        const replyActionHtml = hasReplies
            ? `
                <div class="reply-actions">
                    <button
                        type="button"
                        class="reply-toggle-button"
                        data-comment-id="${EscapeHtml(comment.commentId)}"
                        data-reply-count="${Number(comment.replyCount || 0)}"
                    >
                        Xem phản hồi (${Number(comment.replyCount || 0)})
                    </button>
                </div>
            `
            : "";

        return `
            <article class="comment-card" data-comment-id="${EscapeHtml(comment.commentId)}">
                <div class="avatar">${EscapeHtml(GetAvatarText(comment.nickname))}</div>
                <div class="comment-body">
                    <div class="comment-head">
                        <p class="nickname">${EscapeHtml(comment.nickname)}</p>
                        <span class="comment-index">#${comment.index}</span>
                    </div>
                    <p class="comment-text">${EscapeHtml(GetTranslatedText(comment))}</p>
                    <p class="meta-line">
                        ${comment.likeCount} thích · ${comment.replyCount} phản hồi
                    </p>
                    ${replyActionHtml}
                    <div class="reply-slot">${repliesHtml}</div>
                </div>
            </article>
        `;
    }).join("");
}

function RemoveLoadMoreButton()
{
    const existingButton = commentList.querySelector(".load-more-button");

    if (existingButton)
    {
        existingButton.remove();
    }
}

function AppendLoadMoreButton()
{
    RemoveLoadMoreButton();

    const button = document.createElement("button");
    button.className = "load-more-button";
    button.textContent = `Tải thêm ${currentLimit} comment`;
    button.addEventListener("click", LoadMoreComments);
    commentList.appendChild(button);
}

function BuildMetaItems(payload)
{
    const metaItems =
    [
        `Douyin báo ${payload.reportedCommentCount || payload.totalFetched || 0} comment`,
        "Nguồn: Douyin user cookie",
    ];

    if (payload.replyStatus?.blockedByVerification)
    {
        metaItems.push("Reply bị Douyin chặn verify");
    }
    else if (payload.replyStatus?.fetchedReplies)
    {
        metaItems.push(`Đã lấy ${payload.replyStatus.fetchedReplyCommentCount} reply`);
    }

    return metaItems;
}

function RenderComments(payload)
{
    resultTitle.textContent = `Bình luận (${payload.totalFetched || payload.comments.length || 0})`;
    resultMeta.innerHTML = BuildMetaItems(payload).map((item) =>
    {
        return `<span>${EscapeHtml(item)}</span>`;
    }).join("");

    if (!payload.comments.length)
    {
        commentList.className = "comment-list empty";
        commentList.textContent = "Không có comment để hiển thị.";
        return;
    }

    commentList.className = "comment-list";
    commentList.innerHTML = RenderCommentCards(payload.comments);
    currentCursor = Number(payload.nextCursor || 0);
    hasMore = Boolean(payload.hasMore);

    if (hasMore)
    {
        AppendLoadMoreButton();
    }
}

function AppendComments(payload)
{
    RemoveLoadMoreButton();
    commentList.insertAdjacentHTML("beforeend", RenderCommentCards(payload.comments));
    currentCursor = Number(payload.nextCursor || currentCursor);
    hasMore = Boolean(payload.hasMore);

    if (hasMore)
    {
        AppendLoadMoreButton();
    }
}

async function FetchJsonAsync(url, options = {})
{
    const response = await fetch(url, options);
    const responseJson = await response.json();

    if (!response.ok || !responseJson.ok)
    {
        throw new Error(responseJson.error || "Yêu cầu thất bại.");
    }

    return responseJson;
}

async function FetchComments(videoUrl, translationMode, limit, cursor, indexOffset)
{
    const controller = new AbortController();
    const timeoutId = setTimeout(() =>
    {
        controller.abort();
    }, API_REQUEST_TIMEOUT_MS);

    try
    {
        return await FetchJsonAsync("/api/comments",
        {
            method: "POST",
            headers:
            {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ videoUrl, translationMode, limit, cursor, indexOffset }),
            signal: controller.signal,
        });
    }
    catch (error)
    {
        if (error instanceof DOMException && error.name === "AbortError")
        {
            throw new Error("Yêu cầu lấy comment bị quá thời gian chờ.");
        }

        throw error;
    }
    finally
    {
        clearTimeout(timeoutId);
    }
}

async function FetchReplies(videoUrl, commentId, translationMode, limit)
{
    return FetchJsonAsync("/api/comment-replies",
    {
        method: "POST",
        headers:
        {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(
        {
            videoUrl,
            commentId,
            translationMode,
            limit,
        }),
    });
}

async function FetchAuthStatus()
{
    return FetchJsonAsync("/api/douyin/auth-status");
}

async function SyncCookiesAsync(cookieText)
{
    return FetchJsonAsync("/api/douyin/session",
    {
        method: "POST",
        headers:
        {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ cookieHeader: cookieText }),
    });
}

async function ClearSessionAsync()
{
    return FetchJsonAsync("/api/douyin/session",
    {
        method: "DELETE",
    });
}

async function StartLoginFlowAsync()
{
    return FetchJsonAsync("/api/douyin/login-flow",
    {
        method: "POST",
    });
}

async function FetchLoginFlowStatusAsync(flowId)
{
    return FetchJsonAsync(`/api/douyin/login-flow/${encodeURIComponent(flowId)}/status`);
}

async function StopLoginFlowAsync(flowId)
{
    return FetchJsonAsync(`/api/douyin/login-flow/${encodeURIComponent(flowId)}`,
    {
        method: "DELETE",
    });
}

async function ClickLoginFlowAsync(flowId, x, y)
{
    return FetchJsonAsync(`/api/douyin/login-flow/${encodeURIComponent(flowId)}/click`,
    {
        method: "POST",
        headers:
        {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ x, y }),
    });
}

async function TypeLoginFlowTextAsync(flowId, text)
{
    return FetchJsonAsync(`/api/douyin/login-flow/${encodeURIComponent(flowId)}/type`,
    {
        method: "POST",
        headers:
        {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ text }),
    });
}

async function PressLoginFlowKeyAsync(flowId, key)
{
    return FetchJsonAsync(`/api/douyin/login-flow/${encodeURIComponent(flowId)}/key`,
    {
        method: "POST",
        headers:
        {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ key }),
    });
}

function StopLoginFlowPolling()
{
    if (loginFlowStatusTimer)
    {
        clearInterval(loginFlowStatusTimer);
        loginFlowStatusTimer = 0;
    }

    if (loginFlowScreenshotTimer)
    {
        clearInterval(loginFlowScreenshotTimer);
        loginFlowScreenshotTimer = 0;
    }
}

function RefreshLoginFlowScreenshot()
{
    if (!loginFlowId)
    {
        return;
    }

    loginFlowScreenshot.src = `/api/douyin/login-flow/${encodeURIComponent(loginFlowId)}/screenshot?t=${Date.now()}`;
}

async function PollLoginFlowStatus()
{
    if (!loginFlowId)
    {
        return;
    }

    try
    {
        const flowStatus = await FetchLoginFlowStatusAsync(loginFlowId);

        if (flowStatus.completed || flowStatus.isLoggedIn)
        {
            StopLoginFlowPolling();
            loginFlowId = "";
            loginFlowPanel.hidden = true;
            loginFlowScreenshot.removeAttribute("src");
            SetAuthState(flowStatus);
            SetStatus("Đã lấy cookie Douyin tự động. Có thể tải comment và reply.", "success");
            return;
        }

        const secondsLeft = Math.max(0, Math.ceil(Number(flowStatus.expiresInMs || 0) / 1000));
        loginFlowStatus.textContent = `Đang chờ đăng nhập Douyin (${secondsLeft}s).`;
    }
    catch (error)
    {
        StopLoginFlowPolling();
        loginFlowId = "";
        loginFlowStatus.textContent = error instanceof Error ? error.message : "Phiên đăng nhập đã dừng.";
        SetStatus(error instanceof Error ? error.message : "Phiên đăng nhập đã dừng.", "error");
    }
}

async function LoadMoreComments()
{
    if (isLoadingMore)
    {
        return;
    }

    isLoadingMore = true;
    const loadMoreButton = commentList.querySelector(".load-more-button");

    if (loadMoreButton)
    {
        loadMoreButton.disabled = true;
        loadMoreButton.textContent = "Đang tải thêm...";
    }

    try
    {
        const responseJson = await FetchComments(
            currentVideoUrl,
            currentTranslationMode,
            currentLimit,
            currentCursor,
            displayedCount,
        );

        displayedCount += responseJson.comments.length;
        AppendComments(responseJson);
        SetStatus(`Đã hiển thị ${displayedCount} comment.`, "success");
    }
    catch (error)
    {
        if (loadMoreButton)
        {
            loadMoreButton.disabled = false;
            loadMoreButton.textContent = `Tải thêm ${currentLimit} comment`;
        }

        SetStatus(error instanceof Error ? error.message : "Lỗi tải thêm.", "error");
    }
    finally
    {
        isLoadingMore = false;
    }
}

manualCookieButton.addEventListener("click", () =>
{
    cookieForm.hidden = !cookieForm.hidden;
});

autoLoginButton.addEventListener("click", async () =>
{
    autoLoginButton.disabled = true;
    cookieForm.hidden = true;
    loginFlowPanel.hidden = false;
    loginFlowStatus.textContent = "Đang mở Douyin...";
    SetStatus("Đang mở phiên đăng nhập Douyin tự động...", "loading");

    try
    {
        const flow = await StartLoginFlowAsync();
        loginFlowId = flow.flowId;
        RefreshLoginFlowScreenshot();
        await PollLoginFlowStatus();
        loginFlowStatusTimer = window.setInterval(PollLoginFlowStatus, LOGIN_FLOW_POLL_MS);
        loginFlowScreenshotTimer = window.setInterval(RefreshLoginFlowScreenshot, LOGIN_FLOW_SCREENSHOT_MS);
        SetStatus("Hãy đăng nhập trong khung Douyin. Khi thành công app sẽ tự lấy cookie.", "loading");
    }
    catch (error)
    {
        loginFlowPanel.hidden = true;
        SetStatus(error instanceof Error ? error.message : "Không mở được Douyin.", "error");
    }
    finally
    {
        autoLoginButton.disabled = false;
    }
});

cancelLoginFlowButton.addEventListener("click", async () =>
{
    const flowId = loginFlowId;
    StopLoginFlowPolling();
    loginFlowId = "";
    loginFlowPanel.hidden = true;
    loginFlowScreenshot.removeAttribute("src");

    if (flowId)
    {
        await StopLoginFlowAsync(flowId).catch(() =>
        {
            return null;
        });
    }

    SetStatus("Đã đóng phiên đăng nhập Douyin.", "idle");
});

loginFlowScreenshot.addEventListener("click", async (event) =>
{
    if (!loginFlowId || !loginFlowScreenshot.naturalWidth || !loginFlowScreenshot.naturalHeight)
    {
        return;
    }

    const rect = loginFlowScreenshot.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * loginFlowScreenshot.naturalWidth;
    const y = ((event.clientY - rect.top) / rect.height) * loginFlowScreenshot.naturalHeight;

    try
    {
        await ClickLoginFlowAsync(loginFlowId, x, y);
        RefreshLoginFlowScreenshot();
    }
    catch (error)
    {
        SetStatus(error instanceof Error ? error.message : "Không gửi được thao tác click.", "error");
    }
});

sendLoginFlowTextButton.addEventListener("click", async () =>
{
    const text = String(loginFlowTextInput.value ?? "");

    if (!loginFlowId || !text)
    {
        return;
    }

    try
    {
        await TypeLoginFlowTextAsync(loginFlowId, text);
        loginFlowTextInput.value = "";
        RefreshLoginFlowScreenshot();
    }
    catch (error)
    {
        SetStatus(error instanceof Error ? error.message : "Không nhập được nội dung.", "error");
    }
});

for (const keyButton of document.querySelectorAll(".login-key-button"))
{
    keyButton.addEventListener("click", async () =>
    {
        if (!loginFlowId)
        {
            return;
        }

        try
        {
            await PressLoginFlowKeyAsync(loginFlowId, keyButton.dataset.key);
            RefreshLoginFlowScreenshot();
        }
        catch (error)
        {
            SetStatus(error instanceof Error ? error.message : "Không gửi được phím điều khiển.", "error");
        }
    });
}

cookieForm.addEventListener("submit", async (event) =>
{
    event.preventDefault();

    const cookieText = String(cookieTextInput.value ?? "").trim();

    if (!cookieText)
    {
        SetStatus("Hãy dán cookie Douyin đã đăng nhập.", "error");
        return;
    }

    syncCookiesButton.disabled = true;
    SetStatus("Đang kiểm tra cookie Douyin...", "loading");

    try
    {
        const authStatus = await SyncCookiesAsync(cookieText);
        cookieTextInput.value = "";
        SetAuthState(authStatus);
        SetStatus("Đã lưu phiên Douyin. Có thể tải comment và reply.", "success");
    }
    catch (error)
    {
        SetAuthState({ isLoggedIn: false, hasUsableCookies: false });
        SetStatus(error instanceof Error ? error.message : "Sync cookie thất bại.", "error");
    }
    finally
    {
        syncCookiesButton.disabled = false;
    }
});

clearSessionButton.addEventListener("click", async () =>
{
    clearSessionButton.disabled = true;
    SetStatus("Đang xóa phiên Douyin...", "loading");

    try
    {
        const authStatus = await ClearSessionAsync();
        StopLoginFlowPolling();
        loginFlowId = "";
        SetAuthState(authStatus);
        cookieForm.hidden = true;
        loginFlowPanel.hidden = true;
        loginFlowScreenshot.removeAttribute("src");
        commentList.className = "comment-list empty";
        commentList.textContent = "Sync cookie Douyin để bắt đầu.";
        resultTitle.textContent = "Chưa có dữ liệu";
        resultMeta.innerHTML = "";
        SetStatus("Đã xóa phiên Douyin.", "success");
    }
    catch (error)
    {
        SetStatus(error instanceof Error ? error.message : "Không xóa được phiên.", "error");
    }
    finally
    {
        clearSessionButton.disabled = false;
    }
});

commentList.addEventListener("click", async (event) =>
{
    const replyButton = event.target.closest(".reply-toggle-button");

    if (!replyButton)
    {
        return;
    }

    const commentId = String(replyButton.dataset.commentId || "");
    const commentCard = replyButton.closest(".comment-card");
    const replySlot = commentCard?.querySelector(".reply-slot");

    if (!commentId || !commentCard || !replySlot)
    {
        return;
    }

    if (replySlot.dataset.loaded === "true")
    {
        replySlot.hidden = !replySlot.hidden;
        replyButton.textContent = replySlot.hidden
            ? `Xem phản hồi (${replyButton.dataset.replyCount})`
            : "Ẩn phản hồi";
        return;
    }

    replyButton.disabled = true;
    replyButton.textContent = "Đang tải phản hồi...";

    try
    {
        const responseJson = await FetchReplies(
            currentVideoUrl,
            commentId,
            currentTranslationMode,
            currentReplyLimit,
        );

        if (responseJson.replyStatus?.requiresLogin)
        {
            throw new Error("Hãy sync cookie Douyin đã đăng nhập trước khi tải phản hồi.");
        }

        if (responseJson.replyStatus?.blockedByVerification && !responseJson.replies.length)
        {
            throw new Error(responseJson.replyStatus.error || "Douyin chặn request phản hồi.");
        }

        if (!responseJson.replies.length)
        {
            replySlot.innerHTML = "<div class=\"reply-empty\">Không có phản hồi công khai.</div>";
        }
        else
        {
            replySlot.innerHTML = `
                <div class="reply-list">
                    ${RenderReplyItems(responseJson.replies)}
                </div>
            `;
        }

        replySlot.dataset.loaded = "true";
        replySlot.hidden = false;
        replyButton.textContent = "Ẩn phản hồi";
        SetStatus("Đã tải phản hồi của bình luận.", "success");
    }
    catch (error)
    {
        replySlot.innerHTML = `<div class="reply-empty">${EscapeHtml(error instanceof Error ? error.message : "Lỗi tải phản hồi.")}</div>`;
        replySlot.hidden = false;
        replyButton.textContent = `Xem phản hồi (${replyButton.dataset.replyCount})`;
        SetStatus(error instanceof Error ? error.message : "Lỗi tải phản hồi.", "error");
    }
    finally
    {
        replyButton.disabled = false;
    }
});

commentForm.addEventListener("submit", async (event) =>
{
    event.preventDefault();

    if (!hasDouyinAuth)
    {
        SetStatus("Cần sync cookie Douyin đã đăng nhập trước.", "error");
        return;
    }

    const formData = new FormData(commentForm);
    currentVideoUrl = String(formData.get("videoUrl") ?? "").trim();
    currentTranslationMode = String(formData.get("translationMode") ?? "offline").trim();
    currentLimit = Number(formData.get("commentLimit")) || DEFAULT_COMMENT_LIMIT;
    currentCursor = 0;
    currentReplyLimit = 50;
    displayedCount = 0;

    submitButton.disabled = true;
    SetStatus("Đang tải comment từ Douyin...", "loading");

    try
    {
        const responseJson = await FetchComments(
            currentVideoUrl,
            currentTranslationMode,
            currentLimit,
            0,
            0,
        );

        displayedCount = responseJson.comments.length;
        RenderComments(responseJson);

        const statusText = responseJson.hasMore
            ? `Hiển thị ${displayedCount} comment. Bấm "Tải thêm" để xem tiếp.`
            : `Tải ${displayedCount} comment thành công.`;

        SetStatus(statusText, "success");
    }
    catch (error)
    {
        commentList.className = "comment-list empty";
        commentList.textContent = error instanceof Error ? error.message : "Lỗi không xác định.";
        resultTitle.textContent = "Không tải được dữ liệu";
        resultMeta.innerHTML = "";
        SetStatus(error instanceof Error ? error.message : "Yêu cầu thất bại.", "error");
    }
    finally
    {
        submitButton.disabled = !hasDouyinAuth;
    }
});

try
{
    const authStatus = await FetchAuthStatus();
    SetAuthState(authStatus);
}
catch
{
    SetAuthState({ isLoggedIn: false, hasUsableCookies: false });
    authStatusText.textContent = "Không đọc được trạng thái cookie Douyin.";
}
