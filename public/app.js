const commentForm = document.getElementById("commentForm");
const submitButton = document.getElementById("submitButton");
const statusBox = document.getElementById("statusBox");
const resultTitle = document.getElementById("resultTitle");
const resultMeta = document.getElementById("resultMeta");
const commentList = document.getElementById("commentList");
const API_REQUEST_TIMEOUT_MS = 120000;

// State cho pagination
let currentVideoUrl = "";
let currentTranslationMode = "";
let currentLimit = 0;
let displayedCount = 0;
let hasMore = false;
let isLoadingMore = false;

function SetStatus(message, variant)
{
    statusBox.textContent = message;
    statusBox.className = `status-box ${variant}`;
}

function EscapeHtml(text)
{
    return text
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll("\"", "&quot;");
}

function RenderCommentCards(comments)
{
    return comments.map((comment) =>
    {
        return `
            <article class="comment-card">
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
        metaItems.push("Đã lấy được reply");
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
        SetStatus(
            `Đã hiển thị ${displayedCount} comment.`,
            "success",
        );
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

commentForm.addEventListener("submit", async (event) =>
{
    event.preventDefault();

    const formData = new FormData(commentForm);
    currentVideoUrl = String(formData.get("videoUrl") ?? "").trim();
    currentTranslationMode = String(formData.get("translationMode") ?? "offline").trim();
    currentLimit = Number(formData.get("commentLimit")) || 0;
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
