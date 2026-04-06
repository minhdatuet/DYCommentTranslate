import fs from "node:fs";
import path from "node:path";

import { DictEngine } from "./dictEngine.js";

export class OfflineTranslator
{
    #engine;
    #loaded;
    #dictDirectory;

    constructor(dictRootDirectory)
    {
        this.#engine = new DictEngine();
        this.#loaded = false;
        this.#dictDirectory = dictRootDirectory;
    }

    get IsAvailable()
    {
        return this.#loaded;
    }

    EnsureLoaded()
    {
        if (this.#loaded)
        {
            return true;
        }

        const requiredFiles =
        [
            "ChinesePhienAmWords.txt",
            "VietPhrase_1.txt",
            "VietPhrase_2.txt",
            "Names.txt",
            "LuatNhan.txt",
        ];

        const missingFiles = requiredFiles.filter((fileName) =>
        {
            return !fs.existsSync(path.join(this.#dictDirectory, fileName));
        });

        if (missingFiles.length > 0)
        {
            console.warn(`Từ điển offline không khả dụng (thiếu: ${missingFiles.join(", ")})`);
            return false;
        }

        this.#engine.Load(this.#dictDirectory);
        this.#loaded = true;
        return true;
    }

    Translate(text)
    {
        if (!this.EnsureLoaded())
        {
            return text;
        }

        return this.#engine.Translate(text);
    }

    TranslateComments(comments)
    {
        if (!this.EnsureLoaded())
        {
            return comments.map((comment) =>
            {
                return {
                    ...comment,
                    translatedText: comment.text,
                };
            });
        }

        return comments.map((comment) =>
        {
            return {
                ...comment,
                translatedText: this.#engine.Translate(comment.text),
            };
        });
    }
}
