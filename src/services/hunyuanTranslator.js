import { config } from "../config.js";

const REQUEST_TIMEOUT_MS = 60000;

export class HunyuanTranslator
{
    #apiUrl;
    #cache;

    constructor()
    {
        this.#apiUrl = config.hunyuanApiUrl;
        this.#cache = new Map();
    }

    get IsConfigured()
    {
        return Boolean(this.#apiUrl);
    }

    /**
     * Dịch một mảng các text.
     * Vì đây là model local, mình sẽ dịch tuần tự hoặc batch nhỏ để tránh quá tải VRAM.
     */
    async TranslateBatchAsync(texts)
    {
        const results = new Array(texts.length).fill(null);
        
        for (let i = 0; i < texts.length; i++)
        {
            const text = texts[i]?.trim();
            if (!text) continue;

            if (this.#cache.has(text))
            {
                results[i] = this.#cache.get(text);
                continue;
            }

            const translated = await this.#FetchTranslationAsync(text);
            if (translated)
            {
                results[i] = translated;
                this.#cache.set(text, translated);
            }
        }

        return results;
    }

    async #FetchTranslationAsync(text)
    {
        try
        {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

            // Prompt chuẩn cho ZH -> VI theo README của HY-MT
            const prompt = `将以下文本翻译为越南语，注意只需要输出翻译后的结果，不要额外解释：\n\n${text}`;

            const response = await fetch(this.#apiUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    model: "hunyuan", // Tên model tùy thuộc vào tham số --served-model-name khi chạy vLLM
                    messages: [
                        { role: "user", content: prompt }
                    ],
                    temperature: 0.3,
                    top_p: 0.95,
                    max_tokens: 1024
                }),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) return null;

            const data = await response.json();
            const result = data.choices?.[0]?.message?.content?.trim();
            
            return result || null;
        }
        catch (error)
        {
            console.error("Hunyuan translation error:", error);
            return null;
        }
    }
}
