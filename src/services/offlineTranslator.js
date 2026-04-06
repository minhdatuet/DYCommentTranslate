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

    EnsureLoaded()
    {
        if (this.#loaded)
        {
            return;
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
            throw new Error(`Thiếu dữ liệu từ điển offline: ${missingFiles.join(", ")}`);
        }

        this.#engine.Load(this.#dictDirectory);
        this.#loaded = true;
    }

    Translate(text)
    {
        this.EnsureLoaded();
        return this.#engine.Translate(text);
    }

    TranslateComments(comments)
    {
        this.EnsureLoaded();

        return comments.map((comment) =>
        {
            return {
                ...comment,
                translatedText: this.#engine.Translate(comment.text),
            };
        });
    }
}
