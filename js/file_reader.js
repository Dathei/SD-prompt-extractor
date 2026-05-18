const exifr = require('exifr');
const fs = require('fs').promises;

const VALID_FORMATS = ['.png', '.jpg', '.jpeg', '.mp4', '.mkv', '.webm', '.mov'];


async function load_image(filePath) {
    try {
        const metadata = await exifr.parse(filePath, true);
        console.log(metadata);

        if (!metadata) return null;

        // ComfyUI png
        if (metadata.prompt) {
            return (typeof metadata.prompt === 'string') ? JSON.parse(metadata.prompt) : metadata.prompt;
        }

        // A1111 png
        if (metadata.parameters) {
            return { parameters: metadata.parameters};
        }

        // Jpg
        let comment = metadata.userComment || metadata.UserComment;

        if (comment) {
            // Sometimes Exifr returns a raw Uint8Array instead of a string if it has a Unicode prefix
            if (comment instanceof Uint8Array) {
                const prefix = new TextDecoder('latin1').decode(comment.slice(0, 8));
                const body = comment.slice(8);

                if (prefix.startsWith('UNICODE')) {
                    let decoded = new TextDecoder('utf-16be').decode(body);
                    // If BE result has lots of null/control chars, it's probably LE
                    if (/[\x00-\x08]/.test(decoded.slice(0, 20))) {
                        decoded = new TextDecoder('utf-16le').decode(body);
                    }
                    comment = decoded;
                } else if (prefix.startsWith('ASCII')) {
                    comment = new TextDecoder('ascii').decode(body);
                } else {
                    comment = new TextDecoder().decode(body);
                }

                // Strip trailing nulls
                comment = comment.replace(/\x00+$/, '').trim();
            }

            try {
                const parsed = JSON.parse(comment);
                return parsed.prompt ? parsed.prompt : parsed;
            } catch (error) {
                return { parameters: comment};
            }
        }

        return metadata;

    } catch (error) {
        console.error("Image extraction failed:", error);
        return null;
    }
}

async function loadFile(filePath) {
    const ext = filePath.toLowerCase();
    const isValid = VALID_FORMATS.some(format => ext.endsWith(format));

    if (!isValid) {
        console.log(`"${filePath}" is not a valid file format`);
        return null;
    }

    const isImage = ['.jpg', '.jpeg', '.png'].some(format => ext.endsWith(format));

    if (isImage) {
        return await load_image(filePath);
    } else {
        return await loadVideo(filePath);
    }
}


async function loadVideo(filePath) {
    try {
        const buffer = await fs.readFile(filePath);
        const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        let tags;
        if (bytes[0] === 0x1A && bytes[1] === 0x45 && bytes[2] === 0xDF && bytes[3] === 0xA3) {
            tags = extractMatroskaMetadata(bytes);
            console.log('Matroska tags found:', Object.keys(tags));
            console.log('Prompt length:', tags.prompt?.length);
            console.log('Prompt start:', tags.prompt?.slice(0, 100));
            console.log('Prompt end:', tags.prompt?.slice(-50));
        } else {
            tags = parseMp4Metadata(bytes);
        }

        const potentialKeys = ['comment', 'prompt', 'workflow', 'description', '©cmt', '©des'];
        let commentStr = null;

        for (const [key, value] of Object.entries(tags)) {
            console.log('key: ', key);
            if (potentialKeys.some(k => key.toLowerCase().includes(k))) {
                commentStr = value;
                break;
            }
        }
        if (!commentStr) return null;

        try {
            let str = commentStr;
            if (str.startsWith('{\\"')) {
                str = str.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
                // Matroska stores ComfyUI prompts as escaped strings, unescape if needed
                str = trimToBalancedJson(str);
            }
            const parsed = JSON.parse(str);
            console.log('Parsed OK, top-level keys:', Object.keys(parsed).slice(0, 10));
            return parsed;
        } catch (e) {
            console.log('JSON parse failed:', e.message);
            return { parameters: commentStr };
        }
    } catch (error) {
        console.error("Video extraction failed:", error);
        return null;
    }
}

function trimToBalancedJson(s) {
    const start = s.indexOf('{');
    if (start === -1) return s;

    let depth = 0;
    let inStr = false;
    let escape = false;

    for (let j = start; j < s.length; j++) {
        const c = s[j];
        if (escape) { escape = false; continue; }
        if (inStr) {
            if (c === '\\') escape = true;
            else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) return s.slice(start, j + 1);
        }
    }
    return s;
}

function parseMp4Metadata(bytes) {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    const idx = text.indexOf('"prompt"');
    console.log('prompt marker at:', idx);
    console.log('context:', text.slice(idx, idx + 100));

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const decoder = new TextDecoder('utf-8');
    const readU32 = (o) => view.getUint32(o, false);
    const readType = (o) => String.fromCharCode(bytes[o], bytes[o+1], bytes[o+2], bytes[o+3]);
    const result = {};

    function findBox(boxType, start, end) {
        let offset = start;
        while (offset + 8 <= end) {
            const size = readU32(offset);
            const type = readType(offset + 4);
            if (type === boxType) return { start: offset + 8, end: offset + size };
            if (size < 8 || offset + size > end) break;
            offset += size;
        }
        return null;
    }

    function listBoxes(start, end) {
        const boxes = [];
        let offset = start;
        while (offset + 8 <= end) {
            const size = readU32(offset);
            const type = readType(offset + 4);
            if (size < 8 || offset + size > end) break;
            boxes.push({ type, typeOffset: offset + 4, start: offset + 8, end: offset + size });
            offset += size;
        }
        return boxes;
    }

    const moov = findBox('moov', 0, bytes.length);
    if (!moov) return result;
    const udta = findBox('udta', moov.start, moov.end);
    if (!udta) return result;

    const meta = findBox('meta', udta.start, udta.end);
    if (meta) {
        const metaStart = meta.start + 4; // skip version/flags

        const keys = [];
        const keysBox = findBox('keys', metaStart, meta.end);
        if (keysBox) {
            let o = keysBox.start + 8;
            while (o + 8 <= keysBox.end) {
                const keySize = readU32(o);
                if (keySize < 8) break;
                keys.push(decoder.decode(bytes.slice(o + 8, o + keySize)));
                o += keySize;
            }
        }

        const ilstBox = findBox('ilst', metaStart, meta.end);
        if (ilstBox) {
            for (const item of listBoxes(ilstBox.start, ilstBox.end)) {
                const dataBox = findBox('data', item.start, item.end);
                if (!dataBox) continue;
                const value = decoder.decode(bytes.slice(dataBox.start + 8, dataBox.end));

                let keyName = item.type;
                if (keys.length > 0) {
                    const idx = readU32(item.typeOffset);
                    if (idx >= 1 && idx <= keys.length) keyName = keys[idx - 1];
                }
                result[keyName] = value;
            }
        }
    }

    for (const item of listBoxes(udta.start, udta.end)) {
        if (item.type === 'meta' || result[item.type]) continue;
        if (item.end - item.start < 4) continue;
        const strLen = view.getUint16(item.start, false);
        if (strLen > 0 && item.start + 4 + strLen <= item.end) {
            result[item.type] = decoder.decode(bytes.slice(item.start + 4, item.start + 4 + strLen));
        }
    }

    return result;
}

// ComfyUI's VideoHelperSuite Mp4s often are actually Matroska/WebM
function extractMatroskaMetadata(bytes) {
    // Decode the whole file as latin1 to keep byte offsets aligned with string indices.
    // This is safe for finding ASCII markers, even though the file contains binary.
    const scanSlice = bytes.length > 2_000_000 ? bytes.slice(0, 2_000_000) : bytes;
    const asLatin1 = new TextDecoder('latin1').decode(scanSlice);
    // Note: for large files, only scan the first ~2 MB. Matroska usually puts Tags
    // at the start (SeekHead points to it) or end. If start fails, scan the end too.

    const result = {};
    const markers = ['prompt', 'workflow', 'comment', 'description'];

    function findJsonAt(haystack, markerIdx) {
        let i = haystack.indexOf('{', markerIdx);
        if (i === -1) return null;
        let depth = 0;
        let inStr = false;
        let escape = false;
        for (let j = i; j < haystack.length; j++) {
            const c = haystack[j];
            if (escape) { escape = false; continue; }
            if (c === '\\' && inStr) { escape = true; continue; }
            if (c === '"') { inStr = !inStr; continue; }
            if (inStr) continue;
            if (c === '{') depth++;
            else if (c === '}') {
                depth--;
                if (depth === 0) return { start: i, end: j + 1 };
            }
        }
        return null;
    }

    for (const marker of markers) {
        let searchFrom = 0;
        while (true) {
            const idx = asLatin1.indexOf(marker, searchFrom);
            if (idx === -1) break;
            searchFrom = idx + marker.length;

            const range = findJsonAt(asLatin1, idx);
            if (range) {
                const decoded = new TextDecoder('utf-8').decode(
                    bytes.slice(range.start, range.end)
                );
                result[marker] = decoded;
                break;
            }
        }
    }

    return result;
}


module.exports = {
    loadFile,
    VALID_FORMATS
};
