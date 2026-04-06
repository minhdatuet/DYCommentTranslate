import { config } from "../config.js";

const MAX_CONCURRENT = 10;
const REQUEST_TIMEOUT_MS = 10000;

export class StvTranslator
{
    #apiUrl;
    #cache;
    #activeRequests;
    #queue;

    constructor()
    {
        this.#apiUrl = config.stvApiUrl;
        this.#cache = new Map();
        this.#activeRequests = 0;
        this.#queue = [];
    }

    get IsConfigured()
    {
        return Boolean(this.#apiUrl);
    }

    #ProcessQueue()
    {
        while (this.#activeRequests < MAX_CONCURRENT && this.#queue.length > 0)
        {
            this.#queue.shift()();
        }
    }

    /// <summary>
    /// Dịch một đoạn text bằng API SangTacViet.
    /// Trả về bản dịch hoặc null nếu lỗi/không dịch được.
    /// </summary>
    async TranslateOneAsync(text)
    {
        if (!text?.trim())
        {
            return null;
        }

        if (this.#cache.has(text))
        {
            return this.#cache.get(text);
        }

        return new Promise((resolve) =>
        {
            const execute = async () =>
            {
                this.#activeRequests += 1;

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
                        body: `sajax=trans&content=${encodeURIComponent(text)}`,
                        signal: controller.signal,
                    });

                    clearTimeout(timeoutId);

                    if (!response.ok)
                    {
                        resolve(null);
                        return;
                    }

                    const result = (await response.text()).trim();

                    if (!result || result === text.trim())
                    {
                        resolve(null);
                        return;
                    }

                    this.#cache.set(text, result);
                    resolve(result);
                }
                catch
                {
                    resolve(null);
                }
                finally
                {
                    this.#activeRequests -= 1;
                    this.#ProcessQueue();
                }
            };

            if (this.#activeRequests < MAX_CONCURRENT)
            {
                execute();
            }
            else
            {
                this.#queue.push(execute);
            }
        });
    }

    /// <summary>
    /// Dịch batch nhiều text, trả về mảng kết quả (null cho những câu lỗi).
    /// </summary>
    async TranslateBatchAsync(texts)
    {
        return Promise.all(texts.map((text) => this.TranslateOneAsync(text)));
    }
}
