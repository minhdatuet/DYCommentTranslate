import { config } from "../config.js";

// Separator dùng để nối nhiều comment trong 1 request.
// API STV sẽ dịch toàn bộ và giữ nguyên separator trong kết quả.
const BATCH_SEPARATOR = "\n[===SPLIT===]\n";
const MAX_CHARS_PER_BATCH = 3000;
const REQUEST_TIMEOUT_MS = 30000;

export class StvTranslator
{
    #apiUrl;
    #cache;

    constructor()
    {
        this.#apiUrl = config.stvApiUrl;
        this.#cache = new Map();
    }

    get IsConfigured()
    {
        return Boolean(this.#apiUrl);
    }

    /// Gọi API STV dịch 1 chuỗi đã gộp. Trả về text kết quả hoặc null nếu lỗi.
    async #FetchTranslationAsync(content)
    {
        try
        {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

            const response = await fetch(this.#apiUrl,
            {
                method: "POST",
                headers:
                {
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                body: `sajax=trans&content=${encodeURIComponent(content)}`,
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            if (!response.ok)
            {
                return null;
            }

            const result = await response.text();
            return result || null;
        }
        catch
        {
            return null;
        }
    }

    /// Chia mảng texts thành các batch dựa trên tổng ký tự.
    #CreateBatches(texts)
    {
        const batches = [];
        let currentBatch = [];
        let currentLength = 0;

        for (let index = 0; index < texts.length; index += 1)
        {
            const text = texts[index];
            const addedLength = text.length + (currentBatch.length > 0 ? BATCH_SEPARATOR.length : 0);

            if (currentBatch.length > 0 && currentLength + addedLength > MAX_CHARS_PER_BATCH)
            {
                batches.push(currentBatch);
                currentBatch = [];
                currentLength = 0;
            }

            currentBatch.push({ index, text });
            currentLength += currentBatch.length === 1 ? text.length : addedLength;
        }

        if (currentBatch.length > 0)
        {
            batches.push(currentBatch);
        }

        return batches;
    }

    /// Dịch batch nhiều text. Gộp thành ít request nhất có thể.
    /// Trả về mảng kết quả cùng kích thước với input (null cho câu lỗi).
    async TranslateBatchAsync(texts)
    {
        const results = new Array(texts.length).fill(null);

        // Tách những câu đã có cache vs chưa có
        const uncachedItems = [];

        for (let index = 0; index < texts.length; index += 1)
        {
            const text = texts[index];

            if (!text?.trim())
            {
                continue;
            }

            if (this.#cache.has(text))
            {
                results[index] = this.#cache.get(text);
                continue;
            }

            uncachedItems.push({ index, text });
        }

        if (uncachedItems.length === 0)
        {
            return results;
        }

        // Chia thành batches và gọi API tuần tự để không spam
        const batches = this.#CreateBatches(uncachedItems.map((item) => item.text));

        let itemOffset = 0;

        for (const batch of batches)
        {
            const joinedContent = batch.map((entry) => entry.text).join(BATCH_SEPARATOR);
            const apiResult = await this.#FetchTranslationAsync(joinedContent);

            if (apiResult)
            {
                const parts = apiResult.split(/\[===SPLIT===\]/);

                for (let batchIndex = 0; batchIndex < batch.length; batchIndex += 1)
                {
                    const originalIndex = uncachedItems[itemOffset + batchIndex].index;
                    const originalText = uncachedItems[itemOffset + batchIndex].text;
                    const translated = parts[batchIndex]?.trim() ?? null;

                    if (translated && translated !== originalText.trim())
                    {
                        results[originalIndex] = translated;
                        this.#cache.set(originalText, translated);
                    }
                }
            }

            itemOffset += batch.length;
        }

        return results;
    }
}
