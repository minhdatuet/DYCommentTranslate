import fs from "node:fs";
import path from "node:path";

import { chromium } from "playwright";

import { config } from "../src/config.js";

const LOGIN_CHECK_INTERVAL_MS = 5000;
const DEFAULT_MAX_WAIT_MS = 10 * 60 * 1000;
const DEFAULT_HOLD_AFTER_LOGIN_MS = 2 * 60 * 1000;
const COOKIE_JSON_EXPORT_PATH = path.resolve(".cache", "douyin-cookies-latest.json");
const COOKIE_HEADER_EXPORT_PATH = path.resolve(".cache", "douyin-cookies-latest.txt");
const COOKIE_SUMMARY_EXPORT_PATH = path.resolve(".cache", "douyin-cookie-sync-summary.json");
const REQUIRED_AUTH_COOKIE_NAMES = new Set([
    "passport_auth_status",
    "passport_auth_mix_state",
    "passport_web_login_state",
    "sessionid",
    "sessionid_ss",
    "uid_tt",
    "sid_guard",
]);

function EnsureCacheDirectory()
{
    fs.mkdirSync(path.dirname(COOKIE_JSON_EXPORT_PATH), { recursive: true });
    fs.mkdirSync(config.douyinAuthUserDataDir, { recursive: true });
}

function SleepAsync(timeoutMs)
{
    return new Promise((resolve) =>
    {
        setTimeout(resolve, timeoutMs);
    });
}

function HasLoginCookie(cookies)
{
    const currentUnixTime = Math.floor(Date.now() / 1000);

    return cookies.some((cookie) =>
    {
        const hasRequiredName = REQUIRED_AUTH_COOKIE_NAMES.has(cookie.name);
        const notExpired = cookie.expires === -1 || cookie.expires > currentUnixTime;
        return hasRequiredName && notExpired && Boolean(cookie.value);
    });
}

function BuildCookieHeader(cookies)
{
    return cookies
        .filter((cookie) =>
        {
            return Boolean(cookie?.name) && Boolean(cookie?.value);
        })
        .map((cookie) =>
        {
            return `${cookie.name}=${cookie.value}`;
        })
        .join("; ");
}

async function SaveCookieSnapshotAsync(context, isLoggedIn)
{
    const storageState = await context.storageState({ path: config.douyinAuthStatePath });
    const cookies = Array.isArray(storageState.cookies) ? storageState.cookies : [];
    const cookieHeader = BuildCookieHeader(cookies);
    const summary =
    {
        syncedAt: new Date().toISOString(),
        isLoggedIn,
        storageStatePath: config.douyinAuthStatePath,
        userDataDir: config.douyinAuthUserDataDir,
        cookieJsonExportPath: COOKIE_JSON_EXPORT_PATH,
        cookieHeaderExportPath: COOKIE_HEADER_EXPORT_PATH,
        cookieCount: cookies.length,
        originCount: Array.isArray(storageState.origins) ? storageState.origins.length : 0,
    };

    fs.writeFileSync(COOKIE_JSON_EXPORT_PATH, JSON.stringify(cookies, null, 2), "utf8");
    fs.writeFileSync(COOKIE_HEADER_EXPORT_PATH, cookieHeader, "utf8");
    fs.writeFileSync(COOKIE_SUMMARY_EXPORT_PATH, JSON.stringify(summary, null, 2), "utf8");

    return summary;
}

function GetTimeoutFromEnv(name, fallbackValue)
{
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallbackValue;
}

EnsureCacheDirectory();

const maxWaitMs = GetTimeoutFromEnv("DOUYIN_LOGIN_MAX_WAIT_MS", DEFAULT_MAX_WAIT_MS);
const holdAfterLoginMs = GetTimeoutFromEnv("DOUYIN_LOGIN_HOLD_AFTER_LOGIN_MS", DEFAULT_HOLD_AFTER_LOGIN_MS);
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
    const startTime = Date.now();
    let firstLoggedInAt = 0;
    let latestSummary = null;

    await page.goto("https://www.douyin.com/",
    {
        waitUntil: "domcontentloaded",
        timeout: 60000,
    });

    console.log("Đã mở Douyin. Hãy scan QR hoặc đăng nhập trong cửa sổ Chromium.");
    console.log("Cookie sẽ được lưu định kỳ vào .cache trong lúc cửa sổ còn mở.");

    while (Date.now() - startTime < maxWaitMs)
    {
        const cookies = await context.cookies();
        const isLoggedIn = HasLoginCookie(cookies);
        latestSummary = await SaveCookieSnapshotAsync(context, isLoggedIn);

        console.log(JSON.stringify(
        {
            checkedAt: new Date().toISOString(),
            isLoggedIn,
            cookieCount: latestSummary.cookieCount,
        }));

        if (isLoggedIn)
        {
            if (!firstLoggedInAt)
            {
                firstLoggedInAt = Date.now();
                console.log("Đã phát hiện cookie đăng nhập. Tiếp tục giữ cửa sổ mở để phiên ổn định.");
            }

            if (Date.now() - firstLoggedInAt >= holdAfterLoginMs)
            {
                break;
            }
        }

        await SleepAsync(LOGIN_CHECK_INTERVAL_MS);
    }

    latestSummary = await SaveCookieSnapshotAsync(context, Boolean(firstLoggedInAt));
    console.log(JSON.stringify(
    {
        ok: true,
        ...latestSummary,
    }, null, 2));
}
catch (error)
{
    console.error(JSON.stringify(
    {
        ok: false,
        error: error instanceof Error ? error.message : "Giữ phiên đăng nhập Douyin thất bại.",
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
