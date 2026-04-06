const commentForm = document.getElementById("commentForm");
const submitButton = document.getElementById("submitButton");
const statusBox = document.getElementById("statusBox");
const resultTitle = document.getElementById("resultTitle");
const resultMeta = document.getElementById("resultMeta");
const commentList = document.getElementById("commentList");

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

function RenderComments(payload)
{
    resultTitle.textContent = `Video ${payload.videoId || "không xác định"}`;
    const metaItems =
    [
        `${payload.topLevelCommentCount || payload.totalComments} comment cấp 1`,
        `Douyin báo ${payload.reportedCommentCount || payload.totalComments} comment`,
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
    commentList.innerHTML = payload.comments.map((comment) =>
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

commentForm.addEventListener("submit", async (event) =>
{
    event.preventDefault();

    const formData = new FormData(commentForm);
    const payload =
    {
        videoUrl: String(formData.get("videoUrl") ?? "").trim(),
        translationMode: String(formData.get("translationMode") ?? "offline").trim(),
    };

    submitButton.disabled = true;
    SetStatus("Đang tải comment từ Douyin...", "loading");

    try
    {
        const response = await fetch("/api/comments",
        {
            method: "POST",
            headers:
            {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
        });
        const responseJson = await response.json();

        if (!response.ok || !responseJson.ok)
        {
            throw new Error(responseJson.error || "Không thể lấy comment.");
        }

        RenderComments(responseJson);
        SetStatus("Tải comment thành công.", "success");
    }
    catch (error)
    {
        commentList.className = "comment-list empty";
        commentList.textContent = error instanceof Error ? error.message : "Lỗi không xác định.";
        resultTitle.textContent = "Không tải được dữ liệu";
        resultMeta.innerHTML = "";
        SetStatus("Yêu cầu thất bại.", "error");
    }
    finally
    {
        submitButton.disabled = false;
    }
});
