import fs from "node:fs";
import path from "node:path";

function IsCjk(character)
{
    const code = character.charCodeAt(0);

    return (code >= 0x4e00 && code <= 0x9fff)
        || (code >= 0x3400 && code <= 0x4dbf)
        || (code >= 0xf900 && code <= 0xfaff);
}

function CreateNode()
{
    return {
        children: Object.create(null),
        value: null,
        priority: 0,
    };
}

function NormalizeSpaces(text)
{
    return text.replace(/ {2,}/g, " ").trim();
}

function ExtractMeaning(rawValue)
{
    const firstPart = rawValue.split("//")[0].trim();
    const slashIndex = firstPart.indexOf("/");

    if (slashIndex !== -1)
    {
        return firstPart.slice(0, slashIndex).trim();
    }

    return firstPart;
}

function ParseDictionaryText(text, priority, output)
{
    const lines = text.split(/\r?\n/);

    for (const line of lines)
    {
        const trimmedLine = line.trim();

        if (!trimmedLine || trimmedLine.startsWith("#") || trimmedLine.startsWith("//"))
        {
            continue;
        }

        const separatorIndex = trimmedLine.indexOf("=");

        if (separatorIndex <= 0)
        {
            continue;
        }

        const chineseText = trimmedLine.slice(0, separatorIndex).trim();
        const vietnameseText = ExtractMeaning(trimmedLine.slice(separatorIndex + 1).trim());

        if (!chineseText || !vietnameseText)
        {
            continue;
        }

        output.push([chineseText, vietnameseText, priority]);
    }
}

function LoadTraditionalMap(filePath)
{
    if (!fs.existsSync(filePath))
    {
        return null;
    }

    const rawText = fs.readFileSync(filePath, "utf8")
        .replace(/^\uFEFF/, "")
        .replace(/[\r\n\s]/g, "");
    const characters = Array.from(rawText);
    const map = new Map();

    for (let index = 0; index + 1 < characters.length; index += 2)
    {
        map.set(characters[index], characters[index + 1]);
    }

    return map;
}

function ConvertToSimplified(text, traditionalMap)
{
    if (!traditionalMap)
    {
        return text;
    }

    let output = "";

    for (const character of text)
    {
        output += traditionalMap.get(character) ?? character;
    }

    return output;
}

function BuildTrie(entries)
{
    const root = CreateNode();
    const hanVietMap = new Map();

    for (const [chineseText, vietnameseText, priority] of entries)
    {
        let currentNode = root;

        for (const character of chineseText)
        {
            currentNode.children[character] ??= CreateNode();
            currentNode = currentNode.children[character];
        }

        if (priority >= currentNode.priority)
        {
            currentNode.value = vietnameseText;
            currentNode.priority = priority;
        }

        if (chineseText.length === 1 && priority <= 1)
        {
            hanVietMap.set(chineseText, vietnameseText);
        }
    }

    return {
        root,
        hanVietMap,
    };
}

function MatchAtPosition(root, text, startIndex)
{
    let currentNode = root;
    let bestMatch = null;
    let cursor = startIndex;

    while (cursor < text.length && currentNode.children[text[cursor]])
    {
        currentNode = currentNode.children[text[cursor]];
        cursor += 1;

        if (currentNode.value !== null)
        {
            bestMatch = {
                endIndex: cursor,
                value: currentNode.value,
            };
        }
    }

    return bestMatch;
}

function NormalizePunctuation(text)
{
    return text
        .replace(/，/g, ",")
        .replace(/。/g, ".")
        .replace(/？/g, "?")
        .replace(/！/g, "!")
        .replace(/；/g, ";")
        .replace(/：/g, ":")
        .replace(/、/g, ",");
}

function CapitalizeSentences(text)
{
    return text.replace(
        /(^|[.!?\n]\s+)([a-zàáạảãăắằặẳẵâấầậẩẫđèéẹẻẽêếềệểễìíịỉĩòóọỏõôốồộổỗơớờợởỡùúụủũưứừựửữỳýỵỷỹ])/gu,
        (match, prefix, character) =>
        {
            return `${prefix}${character.toUpperCase()}`;
        },
    );
}

export class DictEngine
{
    #root;
    #hanVietMap;
    #traditionalMap;
    #ready;

    constructor()
    {
        this.#root = null;
        this.#hanVietMap = new Map();
        this.#traditionalMap = null;
        this.#ready = false;
    }

    get IsReady()
    {
        return this.#ready;
    }

    Load(dictDirectory)
    {
        const fileEntries = [];
        const traditionalMapPath = path.join(dictDirectory, "trad-simp.txt");
        this.#traditionalMap = LoadTraditionalMap(traditionalMapPath);

        const sources =
        [
            { fileName: "ChinesePhienAmWords.txt", priority: 1 },
            { fileName: "VietPhrase_1.txt", priority: 2 },
            { fileName: "VietPhrase_2.txt", priority: 2 },
            { fileName: "Names.txt", priority: 3 },
            { fileName: "LuatNhan.txt", priority: 2 },
        ];

        for (const source of sources)
        {
            const sourcePath = path.join(dictDirectory, source.fileName);

            if (!fs.existsSync(sourcePath))
            {
                continue;
            }

            const text = fs.readFileSync(sourcePath, "utf8");
            ParseDictionaryText(text, source.priority, fileEntries);
        }

        const normalizedEntries = fileEntries.map(([chineseText, vietnameseText, priority]) =>
        {
            return [
                ConvertToSimplified(chineseText, this.#traditionalMap),
                vietnameseText,
                priority,
            ];
        });

        const trie = BuildTrie(normalizedEntries);
        this.#root = trie.root;
        this.#hanVietMap = trie.hanVietMap;
        this.#ready = true;
    }

    Translate(text)
    {
        if (!this.#root)
        {
            return text;
        }

        const normalizedText = ConvertToSimplified(text, this.#traditionalMap);
        const resultParts = [];
        let cursor = 0;

        while (cursor < normalizedText.length)
        {
            const currentCharacter = normalizedText[cursor];

            if (!IsCjk(currentCharacter))
            {
                const startIndex = cursor;

                while (cursor < normalizedText.length && !IsCjk(normalizedText[cursor]))
                {
                    cursor += 1;
                }

                resultParts.push(normalizedText.slice(startIndex, cursor));
                continue;
            }

            const match = MatchAtPosition(this.#root, normalizedText, cursor);

            if (match)
            {
                resultParts.push(match.value);
                cursor = match.endIndex;
                continue;
            }

            resultParts.push(this.#hanVietMap.get(currentCharacter) ?? currentCharacter);
            cursor += 1;
        }

        const translatedText = NormalizeSpaces(resultParts.join(" "));
        const normalizedOutput = NormalizePunctuation(translatedText)
            .replace(/ ([,.;!?])/g, "$1")
            .replace(/\s+\n/g, "\n")
            .replace(/\n\s+/g, "\n");

        return CapitalizeSentences(normalizedOutput);
    }
}
