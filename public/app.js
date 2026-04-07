const commentForm = document.getElementById("commentForm");
const submitButton = document.getElementById("submitButton");
const statusBox = document.getElementById("statusBox");
const resultTitle = document.getElementById("resultTitle");
const resultMeta = document.getElementById("resultMeta");
const commentList = document.getElementById("commentList");
const syncCookiesButton = document.getElementById("syncCookiesButton");
const authStatusText = document.getElementById("authStatusText");
const API_REQUEST_TIMEOUT_MS = 120000;

let currentVideoUrl = "";
let currentTranslationMode = "";
let currentLimit = 0;
let displayedCount = 0;
let hasMore = false;
let isLoadingMore = false;
let hasDouyinAuth = false;
let currentReplyLimit = 50;

function SetStatus(message, variant)
{
    statusBox.textContent = message;
    statusBox.className = `status-box ${variant}`;
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
            ? `Đã đăng nhập Douyin. Lần đồng bộ gần nhất: ${syncedAt}`
            : "Đã đăng nhập Douyin và sẵn sàng tải reply.";
        syncCookiesButton.hidden = true;
        return;
    }

    if (hasUsableCookies)
    {
        authStatusText.textContent = syncedAt
            ? `Đang dùng guest cookie. Có thể tải comment công khai, nhưng reply vẫn cần đăng nhập.`
            : "Đang dùng guest cookie. Có thể tải comment công khai, nhưng reply vẫn cần đăng nhập.";
        syncCookiesButton.hidden = false;
        return;
    }

    authStatusText.textContent = "Chưa có cookie Douyin đăng nhập. Comment công khai vẫn có thể chạy, nhưng reply sẽ bị giới hạn.";
    syncCookiesButton.hidden = false;
}

function EscapeHtml(text)
{
    return String(text ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll("\"", "&quot;");
}

function RenderCommentCards(comments)
{
    return comments.map((comment) =>
    {
        const hasReplies = Number(comment.replyCount || 0) > 0;
        const repliesHtml = Array.isArray(comment.replies) && comment.replies.length > 0
            ? `
                <div class="reply-list">
                    <p class="reply-title">Phản hồi</p>
                    ${comment.replies.map((reply) =>
                    {
                        return `
                            <div class="reply-card">
                                <p class="reply-meta">${EscapeHtml(reply.nickname)} · ${reply.likeCount} thích</p>
                                <p class="reply-text">${EscapeHtml(reply.text)}</p>
                            </div>
                        `;
                    }).join("")}
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
                <div class="comment-head">
                    <div>
                        <p class="nickname">${EscapeHtml(comment.nickname)}</p>
                        <p class="meta-line">
                            ${comment.likeCount} thích · ${comment.replyCount} phản hồi
                        </p>
                    </div>
                    <span class="comment-index">#${comment.index}</span>
                </div>
                <div class="comment-columns">
                    <section>
                        <p class="column-label">Bản gốc</p>
                        <p class="comment-text">${EscapeHtml(comment.text)}</p>
                    </section>
                    <section>
                        <p class="column-label">Bản dịch</p>
                        <p class="comment-text translated">${EscapeHtml(comment.translatedText || "")}</p>
                    </section>
                </div>
                ${replyActionHtml}
                <div class="reply-slot">${repliesHtml}</div>
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

function RenderComments(payload)
{
    resultTitle.textContent = `Video ${payload.videoId || "không xác định"}`;
    const metaItems =
    [
        `${payload.topLevelCommentCount || payload.totalFetched} comment cấp 1`,
        `Douyin báo ${payload.reportedCommentCount || payload.totalFetched} comment`,
        `Nguồn: ${payload.source}`,
    ];

    if (payload.replyStatus?.blockedByVerification)
    {
        metaItems.push("Reply bị Douyin chặn bằng verify");
    }
    else if (payload.replyStatus?.fetchedReplies)
    {
        metaItems.push(`Đã lấy ${payload.replyStatus.fetchedReplyCommentCount} reply`);
    }
    else if (payload.replyStatus?.requiresLogin)
    {
        metaItems.push("Reply cần cookie đăng nhập");
    }

    resultMeta.innerHTML = metaItems.map((item) =>
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

    hasMore = payload.hasMore;

    if (hasMore)
    {
        AppendLoadMoreButton();
    }
}

function AppendComments(payload)
{
    RemoveLoadMoreButton();
    commentList.insertAdjacentHTML("beforeend", RenderCommentCards(payload.comments));

    hasMore = payload.hasMore;

    if (hasMore)
    {
        AppendLoadMoreButton();
    }
}

async function FetchComments(videoUrl, translationMode, limit, offset)
{
    const controller = new AbortController();
    const timeoutId = setTimeout(() =>
    {
        controller.abort();
    }, API_REQUEST_TIMEOUT_MS);

    let response;

    try
    {
        response = await fetch("/api/comments",
        {
            method: "POST",
            headers:
            {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ videoUrl, translationMode, limit, offset }),
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

    const responseJson = await response.json();

    if (!response.ok || !responseJson.ok)
    {
        throw new Error(responseJson.error || "Không thể lấy comment.");
    }

    return responseJson;
}

async function FetchReplies(videoUrl, commentId, translationMode, limit)
{
    const response = await fetch("/api/comment-replies",
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
    const responseJson = await response.json();

    if (!response.ok || !responseJson.ok)
    {
        throw new Error(responseJson.error || "Không thể lấy phản hồi.");
    }

    return responseJson;
}

async function FetchAuthStatus()
{
    const response = await fetch("/api/douyin/auth-status");
    const responseJson = await response.json();

    if (!response.ok || !responseJson.ok)
    {
        throw new Error(responseJson.error || "Không đọc được trạng thái cookie Douyin.");
    }

    return responseJson;
}

async function SyncCookiesAsync()
{
    const response = await fetch("/api/douyin/sync-cookies",
    {
        method: "POST",
    });
    const responseJson = await response.json();

    if (!response.ok || !responseJson.ok)
    {
        throw new Error(responseJson.error || "Đồng bộ cookie thất bại.");
    }

    return responseJson;
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

syncCookiesButton.addEventListener("click", async () =>
{
    syncCookiesButton.disabled = true;
    SetStatus("Đang mở cửa sổ Douyin để đăng nhập và đồng bộ cookie...", "loading");

    try
    {
        const authStatus = await SyncCookiesAsync();
        SetAuthState(authStatus);
        SetStatus("Đồng bộ cookie Douyin thành công. Từ lần sau app sẽ dùng lại phiên này.", "success");
    }
    catch (error)
    {
        SetStatus(error instanceof Error ? error.message : "Đồng bộ cookie thất bại.", "error");
    }
    finally
    {
        syncCookiesButton.disabled = false;
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
            throw new Error("Hãy sync cookies Douyin đã đăng nhập trước khi tải phản hồi.");
        }

        if (!responseJson.replies.length)
        {
            replySlot.innerHTML = "<div class=\"reply-empty\">Không tải được phản hồi hoặc comment không có phản hồi công khai.</div>";
        }
        else
        {
            replySlot.innerHTML = `
                <div class="reply-list">
                    <p class="reply-title">Phản hồi</p>
                    ${responseJson.replies.map((reply) =>
                    {
                        return `
                            <div class="reply-card">
                                <p class="reply-meta">${EscapeHtml(reply.nickname)} · ${reply.likeCount} thích</p>
                                <p class="reply-text">${EscapeHtml(reply.text)}</p>
                                <p class="reply-translation">${EscapeHtml(reply.translatedText || "")}</p>
                            </div>
                        `;
                    }).join("")}
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

    const formData = new FormData(commentForm);
    currentVideoUrl = String(formData.get("videoUrl") ?? "").trim();
    currentTranslationMode = String(formData.get("translationMode") ?? "offline").trim();
    currentLimit = Number(formData.get("commentLimit")) || 0;
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
        submitButton.disabled = false;
    }
});

try
{
    const authStatus = await FetchAuthStatus();
    SetAuthState(authStatus);
}
catch
{
    authStatusText.textContent = "Không đọc được trạng thái cookie Douyin.";
}
