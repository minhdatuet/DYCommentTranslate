import fs from "node:fs";
import path from "node:path";

import { config } from "../src/config.js";
import { DouyinService } from "../src/services/douyinService.js";

const COOKIE_JSON_EXPORT_PATH = path.resolve(".cache", "douyin-cookies-latest.json");
const COOKIE_HEADER_EXPORT_PATH = path.resolve(".cache", "douyin-cookies-latest.txt");
const COOKIE_SUMMARY_EXPORT_PATH = path.resolve(".cache", "douyin-cookie-sync-summary.json");

function EnsureCacheDirectory()
{
    fs.mkdirSync(path.dirname(COOKIE_JSON_EXPORT_PATH), { recursive: true });
}

function ReadStorageState()
{
    if (!fs.existsSync(config.douyinAuthStatePath))
    {
        return {
            cookies: [],
            origins: [],
        };
    }

    return JSON.parse(fs.readFileSync(config.douyinAuthStatePath, "utf8"));
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

function ExportCookies(authStatus)
{
    EnsureCacheDirectory();

    const storageState = ReadStorageState();
    const cookies = Array.isArray(storageState.cookies) ? storageState.cookies : [];
    const cookieHeader = BuildCookieHeader(cookies);
    const summary =
    {
        syncedAt: new Date().toISOString(),
        authStatus,
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

const service = new DouyinService();

try
{
    console.log("Mở Chromium Douyin. Hãy scan QR hoặc đăng nhập trong cửa sổ vừa mở.");
    console.log("Script sẽ tự lưu cookie sau khi phát hiện phiên đăng nhập hợp lệ.");

    const authStatus = await service.SyncCookiesAsync();
    const summary = ExportCookies(authStatus);

    console.log(JSON.stringify(
    {
        ok: true,
        ...summary,
    }, null, 2));
}
catch (error)
{
    console.error(JSON.stringify(
    {
        ok: false,
        error: error instanceof Error ? error.message : "Đồng bộ cookie Douyin thất bại.",
    }, null, 2));
    process.exitCode = 1;
}
finally
{
    await service.CloseAsync();
}
