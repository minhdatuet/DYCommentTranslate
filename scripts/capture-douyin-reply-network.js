import fs from "node:fs";
import path from "node:path";

import { chromium } from "playwright";

import { config } from "../src/config.js";

const COMMENT_REPLY_LIST_PATH = "/aweme/v1/web/comment/list/reply/";
const TARGETS_PATH = path.resolve("docs", "douyin-reply-test-targets.json");
const CAPTURE_DIR = path.resolve(".cache", "douyin-reply-captures");
const DIRECT_API_STATE_PATH = path.resolve(".cache", "douyin-direct-api-state.json");
const DEFAULT_MAX_WAIT_MS = 10 * 60 * 1000;
const DEFAULT_HOLD_AFTER_FOUND_MS = 60 * 1000;

function EnsureCaptureDirectory()
{
    fs.mkdirSync(CAPTURE_DIR, { recursive: true });
    fs.mkdirSync(config.douyinAuthUserDataDir, { recursive: true });
}

function ReadTarget()
{
    const targets = JSON.parse(fs.readFileSync(TARGETS_PATH, "utf8"));
    return targets[0];
}

function SleepAsync(timeoutMs)
{
    return new Promise((resolve) =>
    {
        setTimeout(resolve, timeoutMs);
    });
}

function GetTimeoutFromEnv(name, fallbackValue)
{
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallbackValue;
}

function SerializeHeaders(headers)
{
    const serialized = {};

    for (const [key, value] of Object.entries(headers))
    {
        serialized[key] = value;
    }

    return serialized;
}

function BuildCapturePath(prefix)
{
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    return path.join(CAPTURE_DIR, `${timestamp}-${prefix}.json`);
}

function ReadDirectApiState()
{
    if (!fs.existsSync(DIRECT_API_STATE_PATH))
    {
        return {};
    }

    try
    {
        return JSON.parse(fs.readFileSync(DIRECT_API_STATE_PATH, "utf8"));
    }
    catch
    {
        return {};
    }
}

function SaveReplyApiTemplateUrl(templateUrl)
{
    const currentState = ReadDirectApiState();
    const nextState =
    {
        ...currentState,
        updatedAt: new Date().toISOString(),
        replyApiTemplateUrl: templateUrl,
    };

    fs.writeFileSync(DIRECT_API_STATE_PATH, JSON.stringify(nextState, null, 2), "utf8");
}

async function SaveCookiesAsync(context)
{
    await context.storageState({ path: config.douyinAuthStatePath });
}

EnsureCaptureDirectory();

const target = ReadTarget();
const maxWaitMs = GetTimeoutFromEnv("DOUYIN_REPLY_CAPTURE_MAX_WAIT_MS", DEFAULT_MAX_WAIT_MS);
const holdAfterFoundMs = GetTimeoutFromEnv("DOUYIN_REPLY_CAPTURE_HOLD_AFTER_FOUND_MS", DEFAULT_HOLD_AFTER_FOUND_MS);
const context = await chromium.launchPersistentContext(
    config.douyinAuthUserDataDir,
    {
        headless: false,
        timeout: config.playwrightLaunchTimeoutMs,
        chromiumSandbox: false,
        viewport:
        {
            width: 1440,
            height: 1200,
        },
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        locale: "zh-CN",
        args:
        [
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--disable-setuid-sandbox",
            "--no-sandbox",
        ],
    },
);

try
{
    const page = context.pages()[0] ?? await context.newPage();
    const startedAt = Date.now();
    let foundReplyJsonAt = 0;
    let captureCount = 0;

    page.on("response", async (response) =>
    {
        const url = response.url();

        if (!url.includes(COMMENT_REPLY_LIST_PATH))
        {
            return;
        }

        let responseText = "";
        let responseJson = null;

        try
        {
            responseText = await response.text();
            responseJson = responseText.trim() ? JSON.parse(responseText) : null;
        }
        catch
        {
            responseJson = null;
        }

        const comments = Array.isArray(responseJson?.comments) ? responseJson.comments : [];
        const capture =
        {
            capturedAt: new Date().toISOString(),
            url,
            status: response.status(),
            headers: SerializeHeaders(response.headers()),
            target,
            hasBdturingChallenge: Boolean(response.headers()["x-vc-bdturing-parameters"]),
            responseText,
            parsed:
            {
                statusCode: responseJson?.status_code,
                total: responseJson?.total,
                cursor: responseJson?.cursor,
                hasMore: responseJson?.has_more,
                commentCount: comments.length,
                firstComment: comments[0] ?? null,
            },
        };
        const capturePath = BuildCapturePath(`reply-${captureCount}`);

        captureCount += 1;
        fs.writeFileSync(capturePath, JSON.stringify(capture, null, 2), "utf8");
        console.log(`Đã lưu reply capture: ${capturePath}`);

        if (comments.length > 0 && !foundReplyJsonAt)
        {
            foundReplyJsonAt = Date.now();
            SaveReplyApiTemplateUrl(url);
            console.log(`Đã bắt được ${comments.length} reply thật từ network.`);
            console.log("Đã lưu URL này làm replyApiTemplateUrl để backend dùng lại.");
        }
    });

    await page.goto(target.canonicalVideoUrl,
    {
        waitUntil: "domcontentloaded",
        timeout: 60000,
    });

    await SaveCookiesAsync(context);
    console.log(`Đã mở video test: ${target.canonicalVideoUrl}`);
    console.log(`Hãy mở phần bình luận và bấm xem reply của comment: ${target.commentId}`);
    console.log(`Mọi request reply sẽ được lưu vào: ${CAPTURE_DIR}`);

    while (Date.now() - startedAt < maxWaitMs)
    {
        await SaveCookiesAsync(context);

        if (foundReplyJsonAt && Date.now() - foundReplyJsonAt >= holdAfterFoundMs)
        {
            break;
        }

        await SleepAsync(5000);
    }

    await SaveCookiesAsync(context);
    console.log(JSON.stringify(
    {
        ok: true,
        captureCount,
        foundReplyJson: Boolean(foundReplyJsonAt),
        captureDir: CAPTURE_DIR,
        storageStatePath: config.douyinAuthStatePath,
        userDataDir: config.douyinAuthUserDataDir,
    }, null, 2));
}
catch (error)
{
    console.error(JSON.stringify(
    {
        ok: false,
        error: error instanceof Error ? error.message : "Capture reply network thất bại.",
    }, null, 2));
    process.exitCode = 1;
}
finally
{
    await context.close().catch(() =>
    {
        return null;
    });
}
