export class TranslationService
{
    #offlineTranslator;
    #geminiTranslator;
    #stvTranslator;
    #hunyuanTranslator;

    constructor(offlineTranslator, geminiTranslator, stvTranslator, hunyuanTranslator)
    {
        this.#offlineTranslator = offlineTranslator;
        this.#geminiTranslator = geminiTranslator;
        this.#stvTranslator = stvTranslator;
        this.#hunyuanTranslator = hunyuanTranslator;
    }

    async TranslateCommentsAsync(comments, mode)
    {
        if (mode === "gemini")
        {
            const translatedTexts = await this.#geminiTranslator.TranslateBatchAsync(
                comments.map((comment) => comment.text),
            );

            return comments.map((comment, index) =>
            {
                return {
                    ...comment,
                    translatedText: translatedTexts[index],
                };
            });
        }

        if (mode === "stv")
        {
            return this.#TranslateStvWithFallbackAsync(comments);
        }

        if (mode === "hunyuan")
        {
            return this.#TranslateHunyuanWithFallbackAsync(comments);
        }

        return this.#offlineTranslator.TranslateComments(comments);
    }

    /// Pipeline 3 tầng cho mode hunyuan: Hunyuan → STV → Offline.
    /// Câu nào Hunyuan trả null sẽ thu gom vào 1 batch STV duy nhất, còn lại fallback offline.
    async #TranslateHunyuanWithFallbackAsync(comments)
    {
        const texts = comments.map((comment) => comment.text);
        const hunyuanResults = await this.#hunyuanTranslator.TranslateBatchAsync(texts);

        const stvPendingIndices = [];
        const stvPendingTexts = [];

        for (let index = 0; index < hunyuanResults.length; index += 1)
        {
            if (hunyuanResults[index]) continue;

            const originalText = comments[index]?.text;
            if (!originalText?.trim()) continue;

            stvPendingIndices.push(index);
            stvPendingTexts.push(originalText);
        }

        let stvResults = [];
        if (stvPendingTexts.length > 0)
        {
            stvResults = await this.#stvTranslator.TranslateBatchAsync(stvPendingTexts);
        }

        const stvByOriginalIndex = new Map();
        for (let i = 0; i < stvPendingIndices.length; i += 1)
        {
            stvByOriginalIndex.set(stvPendingIndices[i], stvResults[i]);
        }

        return comments.map((comment, index) =>
        {
            const fromHunyuan = hunyuanResults[index];
            if (fromHunyuan)
            {
                return { ...comment, translatedText: fromHunyuan };
            }

            const fromStv = stvByOriginalIndex.get(index);
            if (fromStv)
            {
                return { ...comment, translatedText: fromStv };
            }

            return {
                ...comment,
                translatedText: this.#offlineTranslator.Translate(comment.text),
            };
        });
    }

    /// Dịch bằng API SangTacViet, câu nào lỗi thì fallback offline.
    async #TranslateStvWithFallbackAsync(comments)
    {
        const texts = comments.map((comment) => comment.text);
        const stvResults = await this.#stvTranslator.TranslateBatchAsync(texts);

        return comments.map((comment, index) =>
        {
            const stvText = stvResults[index];

            if (stvText)
            {
                return {
                    ...comment,
                    translatedText: stvText,
                };
            }

            // API lỗi hoặc không dịch được → fallback offline
            return {
                ...comment,
                translatedText: this.#offlineTranslator.Translate(comment.text),
            };
        });
    }
}
