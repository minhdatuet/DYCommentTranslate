import express from "express";

import { config } from "./config.js";
import { DouyinService } from "./services/douyinService.js";
import { GeminiTranslator } from "./services/geminiTranslator.js";
import { OfflineTranslator } from "./services/offlineTranslator.js";
import { StvTranslator } from "./services/stvTranslator.js";
import { TranslationService } from "./services/translationService.js";

const app = express();
const douyinService = new DouyinService();
const offlineTranslator = new OfflineTranslator(config.offlineDictDir);
const geminiTranslator = new GeminiTranslator();
const stvTranslator = new StvTranslator();
const translationService = new TranslationService(offlineTranslator, geminiTranslator, stvTranslator);

app.use(express.json(
{
    limit: "1mb",
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
    });
});

app.post("/api/comments", async (request, response) =>
{
    const videoUrl = String(request.body?.videoUrl ?? "").trim();
    const translationMode = String(request.body?.translationMode ?? "offline").trim().toLowerCase();

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
        const result = await douyinService.GetCommentsAsync(videoUrl);
        const translatedComments = await translationService.TranslateCommentsAsync(
            result.comments,
            translationMode,
        );

        response.json(
        {
            ok: true,
            videoId: result.videoId,
            source: result.source,
            totalComments: translatedComments.length,
            topLevelCommentCount: result.topLevelCommentCount ?? translatedComments.length,
            reportedCommentCount: result.reportedCommentCount ?? translatedComments.length,
            replyStatus: result.replyStatus ?? null,
            comments: translatedComments,
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

app.listen(config.port, () =>
{
    console.log(`DYComment đang chạy tại http://localhost:${config.port}`);
});
