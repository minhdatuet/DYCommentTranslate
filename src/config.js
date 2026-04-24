import path from "node:path";
import process from "node:process";

import dotenv from "dotenv";

dotenv.config();

const DEFAULT_DICT_DIR = process.platform === "win32"
    ? "D:\\Novel\\convert-etx"
    : "./dict";
const DEFAULT_STV_API_URL = "https://comic.sangtacvietcdn.xyz/tsm.php?cdn=";
const DEFAULT_JUSTONEAPI_BASE_URL = "https://api.justoneapi.com";

export const config =
{
    port: Number(process.env.PORT ?? 3000),
    douyinCommentApiTemplateUrl: String(process.env.DOUYIN_COMMENT_API_TEMPLATE_URL ?? "").trim(),
    douyinReplyApiTemplateUrl: String(process.env.DOUYIN_REPLY_API_TEMPLATE_URL ?? "").trim(),
    douyinDirectApiStatePath: path.resolve(".cache", "douyin-direct-api-state.json"),
    justOneApiBaseUrl: String(process.env.JUSTONEAPI_BASE_URL ?? DEFAULT_JUSTONEAPI_BASE_URL).trim(),
    justOneApiToken: String(process.env.JUSTONEAPI_TOKEN ?? "").trim(),
    justOneApiTimeoutMs: Number(process.env.JUSTONEAPI_TIMEOUT_MS ?? 90000),
    commentSource: String(process.env.COMMENT_SOURCE ?? "douyin").trim().toLowerCase(),
    geminiApiKey: process.env.GEMINI_API_KEY ?? "",
    geminiModel: process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
    stvApiUrl: process.env.STV_API_URL ?? DEFAULT_STV_API_URL,
    offlineDictDir: process.env.OFFLINE_DICT_DIR ?? DEFAULT_DICT_DIR,
    playwrightHeadless: (process.env.PLAYWRIGHT_HEADLESS ?? "true").toLowerCase() !== "false",
    playwrightLaunchTimeoutMs: Number(process.env.PLAYWRIGHT_LAUNCH_TIMEOUT_MS ?? 30000),
    douyinWarmupVideoUrl: String(process.env.DOUYIN_WARMUP_VIDEO_URL ?? "").trim(),
    douyinAuthStatePath: path.resolve(".cache", "douyin-storage-state.json"),
    douyinAuthUserDataDir: path.resolve(".cache", "douyin-auth-profile"),
    publicDir: path.resolve("public"),
};
