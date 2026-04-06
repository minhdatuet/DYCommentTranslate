import { config } from "../config.js";

function BuildPrompt(texts)
{
    const serializedTexts = JSON.stringify(texts, null, 2);

    return [
        "Bạn là hệ thống dịch bình luận Douyin từ tiếng Trung sang tiếng Việt.",
        "Yêu cầu:",
        "- Chỉ trả về JSON hợp lệ.",
        "- Không giải thích thêm.",
        "- Giữ nguyên sắc thái khẩu ngữ, icon, xuống dòng nếu có.",
        "- Mỗi phần tử output tương ứng đúng vị trí input.",
        "- Schema output: {\"translations\":[{\"translatedText\":\"...\"}]}",
        "",
        "Danh sách câu cần dịch:",
        serializedTexts,
    ].join("\n");
}

export class GeminiTranslator
{
    #apiKey;
    #model;

    constructor()
    {
        this.#apiKey = config.geminiApiKey;
        this.#model = config.geminiModel;
    }

    get IsConfigured()
    {
        return Boolean(this.#apiKey);
    }

    async TranslateBatchAsync(texts)
    {
        if (!this.IsConfigured)
        {
            throw new Error("Thiếu GEMINI_API_KEY.");
        }

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.#model}:generateContent?key=${this.#apiKey}`;
        const requestBody =
        {
            contents:
            [
                {
                    role: "user",
                    parts:
                    [
                        {
                            text: BuildPrompt(texts),
                        },
                    ],
                },
            ],
            generationConfig:
            {
                responseMimeType: "application/json",
            },
        };

        const response = await fetch(url,
        {
            method: "POST",
            headers:
            {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(requestBody),
        });

        if (!response.ok)
        {
            const errorText = await response.text();
            throw new Error(`Gemini API lỗi: ${response.status} ${errorText}`);
        }

        const responseJson = await response.json();
        const responseText = responseJson?.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!responseText)
        {
            throw new Error("Gemini không trả về nội dung dịch.");
        }

        const parsed = JSON.parse(responseText);
        const translations = parsed?.translations;

        if (!Array.isArray(translations) || translations.length !== texts.length)
        {
            throw new Error("Gemini trả về dữ liệu không đúng schema mong đợi.");
        }

        return translations.map((item) => item?.translatedText ?? "");
    }
}
