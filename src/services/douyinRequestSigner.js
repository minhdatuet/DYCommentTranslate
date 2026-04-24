import crypto from "node:crypto";
import os from "node:os";

const COMMENT_LIST_URL = "https://www.douyin.com/aweme/v1/web/comment/list/";
const COMMENT_REPLY_LIST_URL = "https://www.douyin.com/aweme/v1/web/comment/list/reply/";
const DEFAULT_BROWSER_LANGUAGE = "zh-CN";
const DEFAULT_BROWSER_NAME = "Chrome";
const DEFAULT_BROWSER_PLATFORM = "Win32";
const DEFAULT_DEVICE_PLATFORM = "webapp";
const DEFAULT_CHANNEL = "channel_pc_web";
const DEFAULT_AID = "6383";
const DEFAULT_VERSION_CODE = "170400";
const DEFAULT_VERSION_NAME = "17.4.0";
const DEFAULT_PC_CLIENT_TYPE = "1";
const DEFAULT_PC_LIBRA_DIVERT = "Windows";
const DEFAULT_PLATFORM = "PC";
const DEFAULT_OS_NAME = "Windows";
const DEFAULT_OS_VERSION = "10";
const DEFAULT_ENGINE_NAME = "Blink";
const DEFAULT_SUPPORT_DASH = "1";
const DEFAULT_SUPPORT_H265 = "0";
const DEFAULT_DOWNLINK = "10";
const DEFAULT_EFFECTIVE_TYPE = "4g";
const DEFAULT_ROUND_TRIP_TIME = "0";
const DEFAULT_SCREEN_WIDTH = "1440";
const DEFAULT_SCREEN_HEIGHT = "1200";
const DEFAULT_DEVICE_MEMORY = "8";
const DEFAULT_CPU_CORE_NUM = "8";
const DEFAULT_ITEM_TYPE = "0";
const DEFAULT_CUT_VERSION = "1";
const CUSTOM_BASE64_ALPHABET = "Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe";
const ABOGUS_ARGUMENTS = [0, 1, 14];
const ABOGUS_UA_CODE = [
    76, 98, 15, 131, 97, 245, 224, 133, 122, 199, 241, 166, 79, 34, 90, 191,
    128, 126, 122, 98, 66, 11, 14, 40, 49, 110, 110, 173, 67, 96, 138, 252,
];

function GetCookieValue(cookies, cookieName)
{
    const normalizedName = String(cookieName ?? "").trim().toLowerCase();
    const matchedCookie = cookies.find((cookie) =>
    {
        return String(cookie?.name ?? "").trim().toLowerCase() === normalizedName;
    });

    return String(matchedCookie?.value ?? "").trim();
}

function GetBrowserVersion(userAgent)
{
    const matchedVersion = String(userAgent ?? "").match(/Chrome\/([\d.]+)/i);
    return matchedVersion?.[1] ?? "124.0.0.0";
}

function GetNumericCookieValue(cookies, cookieName, fallbackValue)
{
    const cookieValue = GetCookieValue(cookies, cookieName);

    if (cookieValue)
    {
        return cookieValue;
    }

    return String(fallbackValue);
}

function GetRoundedDeviceMemory()
{
    const memoryInGiB = Math.max(1, Math.round(os.totalmem() / (1024 ** 3)));

    if (memoryInGiB <= 4)
    {
        return "4";
    }

    if (memoryInGiB <= 8)
    {
        return "8";
    }

    if (memoryInGiB <= 16)
    {
        return "16";
    }

    return "32";
}

function GetCpuCoreCount()
{
    const availableParallelism = typeof os.availableParallelism === "function"
        ? os.availableParallelism()
        : os.cpus().length;

    return String(Math.max(1, availableParallelism));
}

export function GenerateVerifyFp()
{
    const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    let timestamp = Date.now();
    let base36 = "";

    while (timestamp > 0)
    {
        const remainder = timestamp % 36;
        base36 = remainder < 10
            ? `${remainder}${base36}`
            : `${String.fromCharCode("a".charCodeAt(0) + remainder - 10)}${base36}`;
        timestamp = Math.floor(timestamp / 36);
    }

    const buffer = new Array(36).fill("");
    buffer[8] = "_";
    buffer[13] = "_";
    buffer[18] = "_";
    buffer[23] = "_";
    buffer[14] = "4";

    for (let index = 0; index < buffer.length; index += 1)
    {
        if (buffer[index])
        {
            continue;
        }

        let randomIndex = Math.floor(Math.random() * alphabet.length);

        if (index === 19)
        {
            randomIndex = (randomIndex & 3) | 8;
        }

        buffer[index] = alphabet[randomIndex];
    }

    return `verify_${base36}_${buffer.join("")}`;
}

function GenerateMsToken()
{
    const alphabet = "ABCDEFGHIGKLMNOPQRSTUVWXYZabcdefghigklmnopqrstuvwxyz0123456789=";
    let token = "";

    for (let index = 0; index < 120; index += 1)
    {
        const randomIndex = Math.floor(Math.random() * alphabet.length);
        token += alphabet[randomIndex];
    }

    return token;
}

function CreateFingerprint(params)
{
    const innerWidth = Number(params.screen_width ?? DEFAULT_SCREEN_WIDTH);
    const innerHeight = Number(params.screen_height ?? DEFAULT_SCREEN_HEIGHT);
    const outerWidth = innerWidth;
    const outerHeight = innerHeight;

    return {
        innerWidth,
        innerHeight,
        outerWidth,
        outerHeight,
        availWidth: outerWidth,
        availHeight: outerHeight,
        sizeWidth: outerWidth,
        sizeHeight: outerHeight,
        platform: params.browser_platform ?? DEFAULT_BROWSER_PLATFORM,
    };
}

function BuildFingerprintString(fingerprint)
{
    return [
        fingerprint.innerWidth,
        fingerprint.innerHeight,
        fingerprint.outerWidth,
        fingerprint.outerHeight,
        0,
        0,
        0,
        0,
        fingerprint.availWidth,
        fingerprint.availHeight,
        fingerprint.availWidth,
        fingerprint.availHeight,
        fingerprint.innerWidth,
        fingerprint.innerHeight,
        24,
        24,
        fingerprint.platform,
    ].join("|");
}

function Rotl(value, bits)
{
    const normalizedBits = bits % 32;
    return ((value << normalizedBits) & 0xFFFFFFFF) | (value >>> (32 - normalizedBits));
}

function Rc4Encrypt(plaintext, key)
{
    const box = new Array(256).fill(0).map((_, index) => index);
    let keyIndex = 0;

    for (let index = 0; index < 256; index += 1)
    {
        keyIndex = (keyIndex + box[index] + key.charCodeAt(index % key.length)) % 256;
        [box[index], box[keyIndex]] = [box[keyIndex], box[index]];
    }

    let i = 0;
    let j = 0;
    let output = "";

    for (let index = 0; index < plaintext.length; index += 1)
    {
        i = (i + 1) % 256;
        j = (j + box[i]) % 256;
        [box[i], box[j]] = [box[j], box[i]];
        const point = (box[i] + box[j]) % 256;
        output += String.fromCharCode(box[point] ^ plaintext.charCodeAt(index));
    }

    return output;
}

function Sm3ToArray(data)
{
    const buffer = Array.isArray(data)
        ? Buffer.from(data)
        : Buffer.from(String(data), "utf8");
    const digest = crypto.createHash("sm3").update(buffer).digest();

    return [...digest];
}

function EncodeCustomBase64(input)
{
    let output = "";

    for (let index = 0; index < input.length; index += 3)
    {
        const byte0 = input.charCodeAt(index);
        const byte1 = index + 1 < input.length ? input.charCodeAt(index + 1) : 0;
        const byte2 = index + 2 < input.length ? input.charCodeAt(index + 2) : 0;
        const value = (byte0 << 16) | (byte1 << 8) | byte2;

        output += CUSTOM_BASE64_ALPHABET[(value & 0xFC0000) >> 18];
        output += CUSTOM_BASE64_ALPHABET[(value & 0x03F000) >> 12];

        if (index + 1 < input.length)
        {
            output += CUSTOM_BASE64_ALPHABET[(value & 0x0FC0) >> 6];
        }

        if (index + 2 < input.length)
        {
            output += CUSTOM_BASE64_ALPHABET[value & 0x3F];
        }
    }

    output += "=".repeat((4 - (output.length % 4)) % 4);
    return output;
}

function RandomList(randomSeed = null, highMask = 170, lowMask = 85, a = 0, b = 0, c = 0, d = 0)
{
    const randomNumber = randomSeed ?? (Math.random() * 10000);
    const low = Math.trunc(randomNumber) & 255;
    const high = Math.trunc(randomNumber) >> 8;

    return [
        (low & highMask) | a,
        (low & lowMask) | b,
        (high & highMask) | c,
        (high & lowMask) | d,
    ];
}

function GenerateString1()
{
    const part1 = String.fromCharCode(...RandomList(null, 170, 85, 1, 2, 5, 45 & 170));
    const part2 = String.fromCharCode(...RandomList(null, 170, 85, 1, 0, 0, 0));
    const part3 = String.fromCharCode(...RandomList(null, 170, 85, 1, 0, 5, 0));

    return `${part1}${part2}${part3}`;
}

function EndCheckNum(values)
{
    let result = 0;

    for (const value of values)
    {
        result ^= value;
    }

    return result;
}

function List4(...values)
{
    return [
        44,
        values[0],
        0,
        0,
        0,
        0,
        24,
        values[1],
        values[12],
        0,
        values[2],
        values[3],
        0,
        0,
        0,
        1,
        0,
        239,
        values[4],
        values[13],
        values[5],
        values[6],
        0,
        0,
        0,
        0,
        values[7],
        0,
        0,
        14,
        values[8],
        values[9],
        0,
        values[10],
        values[11],
        3,
        values[14],
        1,
        values[15],
        1,
        values[16],
        0,
        0,
        0,
    ];
}

function GenerateString2List(queryString, method, fingerprint)
{
    const startTime = Date.now();
    const endTime = startTime + Math.floor(Math.random() * 5) + 4;
    const paramsArray = Sm3ToArray(Sm3ToArray(`${queryString}cus`));
    const methodArray = Sm3ToArray(Sm3ToArray(`${method}cus`));

    return List4(
        (endTime >> 24) & 255,
        paramsArray[21],
        ABOGUS_UA_CODE[23],
        (endTime >> 16) & 255,
        paramsArray[22],
        ABOGUS_UA_CODE[24],
        (endTime >> 8) & 255,
        endTime & 255,
        (startTime >> 24) & 255,
        (startTime >> 16) & 255,
        (startTime >> 8) & 255,
        startTime & 255,
        methodArray[21],
        methodArray[22],
        Math.floor(endTime / (256 ** 4)) & 255,
        Math.floor(startTime / (256 ** 4)) & 255,
        BuildFingerprintString(fingerprint).length,
    );
}

function GenerateString2(queryString, method, fingerprint)
{
    const browserString = BuildFingerprintString(fingerprint);
    const values = GenerateString2List(queryString, method, fingerprint);
    const checkNum = EndCheckNum(values);
    const payload = [...values, ...browserString.split("").map((char) => char.charCodeAt(0)), checkNum];

    return Rc4Encrypt(String.fromCharCode(...payload), "y");
}

function GenerateABogus(queryString, userAgent, fingerprint)
{
    const combined = `${GenerateString1()}${GenerateString2(queryString, "GET", fingerprint)}`;
    return EncodeCustomBase64(combined);
}

function BuildBaseParams(cookies, userAgent)
{
    const browserVersion = GetBrowserVersion(userAgent);
    const verifyFp = GetCookieValue(cookies, "s_v_web_id") || GenerateVerifyFp();
    const params =
    {
        device_platform: DEFAULT_DEVICE_PLATFORM,
        aid: DEFAULT_AID,
        channel: DEFAULT_CHANNEL,
        item_type: DEFAULT_ITEM_TYPE,
        whale_cut_token: "",
        cut_version: DEFAULT_CUT_VERSION,
        rcFT: "",
        update_version_code: DEFAULT_VERSION_CODE,
        pc_client_type: DEFAULT_PC_CLIENT_TYPE,
        pc_libra_divert: DEFAULT_PC_LIBRA_DIVERT,
        support_h265: GetCookieValue(cookies, "hevc_supported") === "true" ? "1" : DEFAULT_SUPPORT_H265,
        support_dash: DEFAULT_SUPPORT_DASH,
        cpu_core_num: GetNumericCookieValue(cookies, "device_web_cpu_core", GetCpuCoreCount()),
        version_code: DEFAULT_VERSION_CODE,
        version_name: DEFAULT_VERSION_NAME,
        cookie_enabled: "true",
        screen_width: GetNumericCookieValue(cookies, "dy_swidth", DEFAULT_SCREEN_WIDTH),
        screen_height: GetNumericCookieValue(cookies, "dy_sheight", DEFAULT_SCREEN_HEIGHT),
        browser_language: DEFAULT_BROWSER_LANGUAGE,
        browser_platform: DEFAULT_BROWSER_PLATFORM,
        browser_name: DEFAULT_BROWSER_NAME,
        browser_version: browserVersion,
        browser_online: "true",
        engine_name: DEFAULT_ENGINE_NAME,
        engine_version: browserVersion,
        os_name: DEFAULT_OS_NAME,
        os_version: DEFAULT_OS_VERSION,
        device_memory: GetNumericCookieValue(cookies, "device_web_memory_size", GetRoundedDeviceMemory()),
        platform: DEFAULT_PLATFORM,
        downlink: DEFAULT_DOWNLINK,
        effective_type: DEFAULT_EFFECTIVE_TYPE,
        round_trip_time: DEFAULT_ROUND_TRIP_TIME,
        verifyFp,
        fp: verifyFp,
    };
    const uifid = GetCookieValue(cookies, "UIFID") || GetCookieValue(cookies, "UIFID_TEMP");
    const msToken = GetCookieValue(cookies, "msToken");
    const webId = GetCookieValue(cookies, "webid") || GetCookieValue(cookies, "web_id");

    if (uifid)
    {
        params.uifid = uifid;
    }

    if (msToken)
    {
        params.msToken = msToken;
    }
    else
    {
        params.msToken = GenerateMsToken();
    }

    if (webId)
    {
        params.webid = webId;
    }

    return params;
}

function BuildUrl(baseUrl, params, userAgent)
{
    const url = new URL(baseUrl);
    const fingerprint = CreateFingerprint(params);
    const searchParams = new URLSearchParams();

    for (const [key, value] of Object.entries(params))
    {
        searchParams.set(key, String(value));
    }

    const queryString = searchParams.toString();
    searchParams.set("a_bogus", GenerateABogus(queryString, userAgent, fingerprint));
    url.search = searchParams.toString();

    return url.toString();
}

export function BuildSignedCommentListUrl(videoId, cursor, count, cookies, userAgent)
{
    const params =
    {
        ...BuildBaseParams(cookies, userAgent),
        aweme_id: String(videoId),
        cursor: String(cursor),
        count: String(count),
    };

    return BuildUrl(COMMENT_LIST_URL, params, userAgent);
}

export function BuildSignedReplyListUrl(videoId, commentId, cursor, count, cookies, userAgent)
{
    const params =
    {
        ...BuildBaseParams(cookies, userAgent),
        item_id: String(videoId),
        comment_id: String(commentId),
        cursor: String(cursor),
        count: String(count),
    };

    return BuildUrl(COMMENT_REPLY_LIST_URL, params, userAgent);
}
