const cookieForm = document.getElementById("cookieForm");
const cookieTextInput = document.getElementById("cookieText");
const commentForm = document.getElementById("commentForm");
const submitButton = document.getElementById("submitButton");
const statusBox = document.getElementById("statusBox");
const resultTitle = document.getElementById("resultTitle");
const resultMeta = document.getElementById("resultMeta");
const commentList = document.getElementById("commentList");
const authActions = document.getElementById("authActions");
const manualCookieButton = document.getElementById("manualCookieButton");
const manualInstruction = document.getElementById("manualInstruction");
const syncCookiesButton = document.getElementById("syncCookiesButton");
const clearSessionButton = document.getElementById("clearSessionButton");
const authStatusText = document.getElementById("authStatusText");
const templateUrlInput = document.getElementById("templateUrl");

const API_REQUEST_TIMEOUT_MS = 120000;
const DEFAULT_COMMENT_LIMIT = 20;

let currentVideoUrl = "";
let currentTranslationMode = "";
let currentLimit = DEFAULT_COMMENT_LIMIT;
let currentCursor = 0;
let displayedCount = 0;
let hasDouyinAuth = false;
let currentReplyLimit = 50;
let isLoadingMore = false;

console.log("DYComment App initialized");

function SetStatus(message, variant)
{
    console.log(`Status [${variant}]: ${message}`);
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
    console.log("Setting Auth State:", authStatus);
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
        if (manualInstruction) manualInstruction.hidden = true;
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

function GetAvatarText(nickname)
{
    const normalizedNickname = String(nickname ?? "").trim();
    return normalizedNickname ? normalizedNickname.charAt(0).toUpperCase() : "?";
}

async function FetchJsonAsync(url, options = {})
{
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), API_REQUEST_TIMEOUT_MS);

    try
    {
        const response = await fetch(url, { ...options, signal: controller.signal });
        const responseJson = await response.json();
        if (!response.ok) throw new Error(responseJson.error || `Yêu cầu thất bại (${response.status})`);
        return responseJson;
    }
    finally
    {
        clearTimeout(timeoutId);
    }
}

async function FetchComments(videoUrl, translationMode, limit, cursor, offset)
{
    return FetchJsonAsync("/api/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoUrl, translationMode, limit, cursor, offset }),
    });
}

async function FetchReplies(videoUrl, commentId, translationMode, limit)
{
    return FetchJsonAsync("/api/comment-replies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoUrl, commentId, translationMode, limit }),
    });
}

async function FetchAuthStatus()
{
    return FetchJsonAsync("/api/douyin/auth-status");
}

async function SyncCookiesAsync(cookieText, templateUrl = "")
{
    return FetchJsonAsync("/api/douyin/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            cookieHeader: cookieText,
            templateUrl: templateUrl
        }),
    });
}

async function ClearSessionAsync()
{
    return FetchJsonAsync("/api/douyin/session", { method: "DELETE" });
}

manualCookieButton.addEventListener("click", () =>
{
    console.log("Manual Cookie Button clicked");
    const isHidden = !cookieForm.hidden;
    cookieForm.hidden = isHidden;
    if (manualInstruction) {
        manualInstruction.hidden = isHidden;
    }
});

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
        const templateUrl = String(templateUrlInput?.value ?? "").trim();
        const authStatus = await SyncCookiesAsync(cookieText, templateUrl);
        cookieTextInput.value = "";
        if (templateUrlInput) templateUrlInput.value = "";
        SetAuthState(authStatus);
        SetStatus("Đã lưu phiên Douyin.", "success");
    }
    catch (error)
    {
        SetStatus(error.message, "error");
    }
    finally
    {
        syncCookiesButton.disabled = false;
    }
});

clearSessionButton.addEventListener("click", async () =>
{
    clearSessionButton.disabled = true;
    SetStatus("Đang xóa phiên...", "loading");
    try
    {
        const authStatus = await ClearSessionAsync();
        SetAuthState(authStatus);
        SetStatus("Đã xóa phiên.", "success");
    }
    catch (error)
    {
        SetStatus(error.message, "error");
    }
    finally
    {
        clearSessionButton.disabled = false;
    }
});

function RenderCommentItem(comment)
{
    const nickname = EscapeHtml(comment.nickname || "Người dùng Douyin");
    const avatarText = GetAvatarText(comment.nickname);
    const content = EscapeHtml(comment.text || "");
    const translated = EscapeHtml(comment.translatedText || "");
    const timeText = comment.createTimeText || "";
    const replyCount = comment.replyCount || 0;
    const index = comment.index || "";

    return `
        <div class="comment-card">
            <div class="avatar">${avatarText}</div>
            <div class="comment-body">
                <div class="comment-head">
                    <p class="nickname">${nickname}</p>
                    <span class="comment-index">#${index}</span>
                </div>
                <p class="comment-text">${translated || content}</p>
                <p class="meta-line">${timeText}</p>
                ${replyCount > 0 ? `
                    <div class="reply-actions">
                        <button type="button" class="reply-toggle-button" data-comment-id="${comment.commentId}" data-reply-count="${replyCount}">
                            Xem phản hồi (${replyCount})
                        </button>
                    </div>
                    <div class="reply-slot" hidden></div>
                ` : ""}
            </div>
        </div>
    `;
}

function RenderReplyItems(replies)
{
    return replies.map(reply => {
        const nickname = EscapeHtml(reply.nickname || "Người dùng Douyin");
        const avatarText = GetAvatarText(reply.nickname);
        const content = EscapeHtml(reply.text || "");
        const translated = EscapeHtml(reply.translatedText || "");
        return `
            <div class="reply-card">
                <div class="avatar avatar-small">${avatarText}</div>
                <div class="reply-body">
                    <p class="reply-meta">${nickname}</p>
                    <p class="reply-text">${translated || content}</p>
                </div>
            </div>
        `;
    }).join("");
}

commentList.addEventListener("click", async (event) =>
{
    const replyButton = event.target.closest(".reply-toggle-button");
    if (!replyButton) return;
    const commentId = replyButton.dataset.commentId;
    const replySlot = replyButton.closest(".comment-card").querySelector(".reply-slot");
    if (replySlot.dataset.loaded === "true")
    {
        replySlot.hidden = !replySlot.hidden;
        replyButton.textContent = replySlot.hidden ? `Xem phản hồi (${replyButton.dataset.replyCount})` : "Ẩn phản hồi";
        return;
    }
    replyButton.disabled = true;
    replyButton.textContent = "Đang tải phản hồi...";
    try
    {
        const responseJson = await FetchReplies(currentVideoUrl, commentId, currentTranslationMode, currentReplyLimit);
        replySlot.innerHTML = `<div class="reply-list">${RenderReplyItems(responseJson.replies)}</div>`;
        replySlot.dataset.loaded = "true";
        replySlot.hidden = false;
        replyButton.textContent = "Ẩn phản hồi";
    }
    catch (error)
    {
        replyButton.textContent = `Lỗi: ${error.message}`;
    }
    finally
    {
        replyButton.disabled = false;
    }
});

commentForm.addEventListener("submit", async (event) =>
{
    event.preventDefault();
    const formData = new FormData(commentForm);
    currentVideoUrl = String(formData.get("videoUrl")).trim();
    currentTranslationMode = formData.get("translationMode");
    currentLimit = Number(formData.get("commentLimit")) || 20;
    submitButton.disabled = true;
    SetStatus("Đang tải comment...", "loading");
    try
    {
        const responseJson = await FetchComments(currentVideoUrl, currentTranslationMode, currentLimit, 0, 0);
        resultTitle.textContent = responseJson.videoTitle || "Video Douyin";
        resultMeta.innerHTML = `<span>${responseJson.comments.length} bình luận</span>`;
        if (responseJson.comments.length === 0) {
            commentList.className = "comment-list empty";
            commentList.textContent = "Không tìm thấy bình luận.";
        } else {
            commentList.className = "comment-list";
            commentList.innerHTML = responseJson.comments.map(RenderCommentItem).join("");
        }
        SetStatus("Tải thành công.", "success");
    }
    catch (error)
    {
        SetStatus(error.message, "error");
    }
    finally
    {
        submitButton.disabled = false;
    }
});

(async () => {
    try {
        console.log("Fetching initial auth status...");
        const authStatus = await FetchAuthStatus();
        SetAuthState(authStatus);
        SetStatus("Sẵn sàng.", "idle");
    } catch (e) {
        console.error("Initial auth fetch failed:", e);
        SetStatus("Không thể kết nối tới server.", "error");
    }
})();
