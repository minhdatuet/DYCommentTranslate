import path from "node:path";
import fs from "node:fs/promises";

import { config } from "../config.js";

// Timeout dài cho VPS CPU 2 core: prefill + decode 1 batch nhỏ vẫn có thể chạm ~60-90s.
const REQUEST_TIMEOUT_MS = 120000;

// Số comment gom vào 1 prompt duy nhất. Giảm số request → giảm overhead prefill/network.
const BATCH_SIZE = 5;

// max_tokens căn theo độ dài input để model không sinh dốc dải.
// 1 Hán tự ≈ 1 token, 1 token dịch tiếng Việt ≈ 2-3 token → nhân 4 + buffer.
const MAX_TOKENS_PER_CHAR = 4;
const MAX_TOKENS_MIN = 64;
const MAX_TOKENS_CAP = 384;

// Sampling theo khuyến nghị HY-MT (xem D:\HY-MT\HY-MT\docs\INFERENCE_GUIDE.md).
const SAMPLING_TEMPERATURE = 0.7;
const SAMPLING_TOP_P = 0.6;
const SAMPLING_TOP_K = 20;
const SAMPLING_REPETITION_PENALTY = 1.05;

// Stop sequences để model không đợ thêm phần giải thích sau khi đã trả đủ bản dịch.
const STOP_SEQUENCES = ["\n\n\n", "注释：", "解释：", "说明：", "Note:", "Explanation:"];

// System prompt cố định → tăng xác suất prompt cache hit ở llama.cpp giữa các request.
const SYSTEM_PROMPT = "你是专业的中越翻译助手，只输出越南语译文，不输出任何解释、注释或原文。";

// Regex nhận dạng ký tự Hán (CJK Unified + Extension A). Comment không chứa Hán tự
// (full Latin/emoji/số) thì không cần dịch → bỏ qua model, tiết kiệm thời gian.
const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;

// Cache persistent để khởi động lại không mất công dịch lại.
const CACHE_FILE_PATH = path.resolve(".cache", "hunyuan-cache.json");
const CACHE_PERSIST_DEBOUNCE_MS = 2000;
const CACHE_MAX_ENTRIES = 5000;

export class HunyuanTranslator
{
    #apiUrl;
    #cache;
    #persistTimer;

    constructor()
    {
        this.#apiUrl = config.hunyuanApiUrl;
        this.#cache = new Map();
        this.#persistTimer = null;
        this.#LoadCacheAsync();
    }

    get IsConfigured()
    {
        return Boolean(this.#apiUrl);
    }

    /// Dịch một mảng text. Trả về mảng cùng kích thước, câu nào lỗi/empty thì null.
    /// Cách hoạt động: gom nhiều câu chưa cache thành 1 prompt đánh số, gửi tuần tự từng batch.
    async TranslateBatchAsync(texts)
    {
        const results = new Array(texts.length).fill(null);
        const pending = [];

        for (let index = 0; index < texts.length; index += 1)
        {
            const trimmedText = String(texts[index] ?? "").trim();
            if (!trimmedText) continue;

            // Comment không có Hán tự (vd chỉ emoji, tiếng Anh, số) → giữ nguyên,
            // không cần gọi model. Trả chính nó để TranslationService không fallback.
            if (!CJK_REGEX.test(trimmedText))
            {
                results[index] = trimmedText;
                continue;
            }

            if (this.#cache.has(trimmedText))
            {
                results[index] = this.#cache.get(trimmedText);
                continue;
            }

            pending.push({ originalIndex: index, text: trimmedText });
        }

        for (let start = 0; start < pending.length; start += BATCH_SIZE)
        {
            const batch = pending.slice(start, start + BATCH_SIZE);
            const items = batch.map((entry) => entry.text);

            let translatedItems = null;
            try
            {
                translatedItems = await this.#FetchBatchAsync(items);
            }
            catch (error)
            {
                console.error("Hunyuan batch error:", error?.message ?? error);
            }

            for (let batchIndex = 0; batchIndex < batch.length; batchIndex += 1)
            {
                const translated = translatedItems?.[batchIndex];
                if (!translated) continue;

                const entry = batch[batchIndex];
                results[entry.originalIndex] = translated;
                this.#CacheSet(entry.text, translated);
            }
        }

        this.#SchedulePersist();
        return results;
    }

    /// Gửi 1 request dummy để load weights vào RAM, tránh request đầu tiên của user phải chờ load.
    async WarmupAsync()
    {
        if (!this.IsConfigured) return;

        try
        {
            await this.#FetchBatchAsync(["你好"]);
            console.log("[Hunyuan] Warmup completed");
        }
        catch (error)
        {
            console.warn("[Hunyuan] Warmup failed:", error?.message ?? error);
        }
    }

    async #FetchBatchAsync(items)
    {
        if (items.length === 0) return [];

        const isSingle = items.length === 1;
        const userPrompt = isSingle
            ? `将下面的中文翻译为越南语：\n${items[0]}`
            : this.#BuildBatchUserPrompt(items);

        // Tính max_tokens dựa trên tổng độ dài input để tránh model sinh dư.
        const totalChars = items.reduce((sum, text) => sum + text.length, 0);
        const maxTokens = Math.min(
            MAX_TOKENS_CAP,
            Math.max(MAX_TOKENS_MIN, totalChars * MAX_TOKENS_PER_CHAR + 32),
        );

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        try
        {
            const response = await fetch(this.#apiUrl,
            {
                method: "POST",
                headers:
                {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(
                {
                    model: "hunyuan",
                    messages:
                    [
                        { role: "system", content: SYSTEM_PROMPT },
                        { role: "user", content: userPrompt },
                    ],
                    temperature: SAMPLING_TEMPERATURE,
                    top_p: SAMPLING_TOP_P,
                    top_k: SAMPLING_TOP_K,
                    repetition_penalty: SAMPLING_REPETITION_PENALTY,
                    repeat_penalty: SAMPLING_REPETITION_PENALTY,
                    max_tokens: maxTokens,
                    stop: STOP_SEQUENCES,
                    cache_prompt: true,
                }),
                signal: controller.signal,
            });

            if (!response.ok)
            {
                const errorBody = await response.text().catch(() => "");
                console.error(`Hunyuan API Error (HTTP ${response.status}):`, errorBody.slice(0, 500));
                return null;
            }

            const data = await response.json();
            const raw = data.choices?.[0]?.message?.content?.trim();
            if (!raw) return null;

            return isSingle ? [raw] : this.#ParseBatchOutput(raw, items.length);
        }
        finally
        {
            clearTimeout(timeoutId);
        }
    }

    #BuildBatchUserPrompt(items)
    {
        // Đánh số từng câu, ép model trả lại theo đúng định dạng "序号. 译文".
        const numbered = items
            .map((text, index) => `${index + 1}. ${text.replace(/\s+/g, " ").trim()}`)
            .join("\n");

        return [
            "逐条翻译为越南语，严格以\"序号. 译文\"格式输出，每条一行，序号与原文一致：",
            numbered,
        ].join("\n");
    }

    #ParseBatchOutput(raw, expectedCount)
    {
        const results = new Array(expectedCount).fill(null);
        const lines = raw.split(/\r?\n+/).map((line) => line.trim()).filter(Boolean);

        for (const line of lines)
        {
            const match = line.match(/^\s*(\d+)\s*[\.\)\:、。]\s*(.+)$/);
            if (!match) continue;

            const idx = Number(match[1]) - 1;
            const text = match[2].trim();
            if (idx >= 0 && idx < expectedCount && text)
            {
                results[idx] = text;
            }
        }

        return results;
    }

    #CacheSet(key, value)
    {
        if (this.#cache.size >= CACHE_MAX_ENTRIES)
        {
            const firstKey = this.#cache.keys().next().value;
            if (firstKey !== undefined)
            {
                this.#cache.delete(firstKey);
            }
        }
        this.#cache.set(key, value);
    }

    async #LoadCacheAsync()
    {
        try
        {
            const content = await fs.readFile(CACHE_FILE_PATH, "utf8");
            const data = JSON.parse(content);
            if (Array.isArray(data))
            {
                for (const entry of data)
                {
                    if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string")
                    {
                        this.#cache.set(entry[0], entry[1]);
                    }
                }
            }
        }
        catch
        {
            // File chưa tồn tại hoặc parse lỗi: bỏ qua, cache rỗng.
        }
    }

    #SchedulePersist()
    {
        if (this.#persistTimer) clearTimeout(this.#persistTimer);
        this.#persistTimer = setTimeout(() =>
        {
            this.#persistTimer = null;
            this.#PersistCacheAsync();
        }, CACHE_PERSIST_DEBOUNCE_MS);
    }

    async #PersistCacheAsync()
    {
        try
        {
            await fs.mkdir(path.dirname(CACHE_FILE_PATH), { recursive: true });
            const data = JSON.stringify(Array.from(this.#cache.entries()));
            await fs.writeFile(CACHE_FILE_PATH, data, "utf8");
        }
        catch (error)
        {
            console.error("Hunyuan cache persist error:", error?.message ?? error);
        }
    }
}
