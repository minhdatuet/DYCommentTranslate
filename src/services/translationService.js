export class TranslationService
{
    #offlineTranslator;
    #geminiTranslator;
    #stvTranslator;

    constructor(offlineTranslator, geminiTranslator, stvTranslator)
    {
        this.#offlineTranslator = offlineTranslator;
        this.#geminiTranslator = geminiTranslator;
        this.#stvTranslator = stvTranslator;
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

        return this.#offlineTranslator.TranslateComments(comments);
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
