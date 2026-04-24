import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { config } from "../src/config.js";

const OUTPUT_PATH = path.resolve(".cache", "douyin-production-session.env");

function ReadJsonFile(filePath, fallbackValue)
{
    if (!fs.existsSync(filePath))
    {
        return fallbackValue;
    }

    try
    {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
    }
    catch
    {
        return fallbackValue;
    }
}

function EscapeEnvValue(value)
{
    return String(value ?? "").replaceAll("\n", "").replaceAll("\r", "");
}

fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });

const storageState = ReadJsonFile(config.douyinAuthStatePath, null);
const directApiState = ReadJsonFile(config.douyinDirectApiStatePath, {});

if (!storageState?.cookies?.length)
{
    throw new Error("Chưa có storage state Douyin để export.");
}

const storageStateBase64 = Buffer.from(JSON.stringify(storageState), "utf8").toString("base64");
const adminToken = config.douyinAdminToken || crypto.randomBytes(24).toString("hex");
const lines =
[
    "# File này chứa cookie/token Douyin. Không commit và không chia sẻ công khai.",
    `DOUYIN_STORAGE_STATE_BASE64=${EscapeEnvValue(storageStateBase64)}`,
    `DOUYIN_REPLY_API_TEMPLATE_URL=${EscapeEnvValue(directApiState.replyApiTemplateUrl ?? "")}`,
    `DOUYIN_COMMENT_API_TEMPLATE_URL=${EscapeEnvValue(directApiState.commentApiTemplateUrl ?? "")}`,
    `DOUYIN_ADMIN_TOKEN=${EscapeEnvValue(adminToken)}`,
];

fs.writeFileSync(OUTPUT_PATH, `${lines.join("\n")}\n`, "utf8");

console.log(JSON.stringify(
{
    ok: true,
    outputPath: OUTPUT_PATH,
    cookieCount: storageState.cookies.length,
    hasReplyApiTemplateUrl: Boolean(directApiState.replyApiTemplateUrl),
    generatedAdminToken: !config.douyinAdminToken,
}, null, 2));
