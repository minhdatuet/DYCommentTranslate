import { DouyinService } from "../src/services/douyinService.js";

const videoUrl = process.argv[2] ?? "https://www.douyin.com/jingxuan?modal_id=7623466763384016163";
const douyinService = new DouyinService();

try
{
    const result = await douyinService.GetCommentsAsync(videoUrl);

    console.log(JSON.stringify(
    {
        ok: true,
        videoId: result.videoId,
        source: result.source,
        totalComments: result.comments.length,
        topLevelCommentCount: result.topLevelCommentCount,
        reportedCommentCount: result.reportedCommentCount,
        replyStatus: result.replyStatus,
        sampleComments: result.comments.slice(0, 5),
    }, null, 2));
}
catch (error)
{
    console.error(JSON.stringify(
    {
        ok: false,
        error: error instanceof Error ? error.message : "Lỗi không xác định.",
    }, null, 2));
    process.exitCode = 1;
}
