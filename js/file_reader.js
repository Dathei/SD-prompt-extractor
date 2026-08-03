const exifr = require('exifr');
const fs = require('fs').promises;

const VALID_FORMATS = ['.png', '.jpg', '.jpeg', '.mp4', '.mkv', '.webm', '.mov'];

const MAX_FILE_SIZE = 500 * 1024 * 1024;
const MAX_METADATA_READ = 16 * 1024 * 1024;

const MAX_BOX_SCAN = 4096;

let logger = () => {};
function setLogger(fn) { logger = fn || (() => {}); }

function safeParseJSON(str) {
    if (typeof str !== 'string') return str;

    const trimmed = str.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;

    try {
        return JSON.parse(str);
    } catch (e) {
        // Comfy sometimes exports illegal JSON primitives like NaN
        let sanitized = str
            .replace(/\bNaN\b/g, 'null')
            .replace(/\bInfinity\b/g, '"Infinity"')
            .replace(/\b-Infinity\b/g, '"-Infinity"');

        // Strip out control characters that break JSON.parse
        sanitized = sanitized.replace(/[\u0000-\u001F]+/g, "");

        try {
            return JSON.parse(sanitized);
        } catch (e2) {
            console.error(`JSON parse failure on string: ${sanitized.substring(0, 100)}`);
            return null;
        }
    }
}

async function loadImage(filePath, fileSize) {
    try {
        let metadata = await exifr.parse(filePath, true);

        if (filePath.toLowerCase().endsWith('.png')) {
            // Text-chunk fallback if exifr failed to find parameters/prompt.
            // Generation chunks precede IDAT, so a bounded head read is enough
            // and keeps the allocation off the file's own size.
            if (!metadata || (!metadata.parameters && !metadata.prompt)) {
                const bytes = await readRange(filePath, 0, Math.min(fileSize, MAX_METADATA_READ));
                const chunks = bytes.length ? parsePngTextChunks(bytes) : null;
                if (chunks?.parameters && !chunks?.prompt) {
                    return { parameters: chunks.parameters };
                }
                if (chunks?.prompt) {
                    let parsedPrompt = safeParseJSON(chunks.prompt);
                    if (parsedPrompt) return parsedPrompt;
                    if (chunks.parameters) return { parameters: chunks.parameters };
                    return { parameters: chunks.prompt };
                }
            }
        }

        if (!metadata) return null;

        // ComfyUI png
        if (metadata?.prompt) {
            let parsedPrompt = safeParseJSON(metadata.prompt);
            if (parsedPrompt) return parsedPrompt;
        }

        // A1111 png
        if (metadata?.parameters) return { parameters: metadata.parameters };

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

            let parsedComment = safeParseJSON(comment);
            if (parsedComment) {
                return parsedComment.prompt ? parsedComment.prompt : parsedComment;
            }
            return { parameters: comment };
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

    let stats;
    try {
        stats = await fs.stat(filePath);
    } catch (error) {
        console.error("Could not stat file:", error);
        return null;
    }

    if (stats.size > MAX_FILE_SIZE) {
        logger(`Extraction skipped for "${filePath.split("\\").pop()}": ${(stats.size / 1024 / 1024).toFixed(1)} MB exceeds the ${MAX_FILE_SIZE / 1024 / 1024} MB limit`);
        return null;
    }

    const isImage = ['.jpg', '.jpeg', '.png'].some(format => ext.endsWith(format));

    if (isImage) {
        return await loadImage(filePath, stats.size);
    } else {
        return await loadVideo(filePath, stats.size);
    }
}

function parsePngTextChunks(bytes) {
    const sig = [0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A];      // PNG signature
    for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) return null;

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const result = {};
    let offset = 8;

    while (offset + 12 <= bytes.length) {
        const length = view.getUint32(offset, false);
        const type = String.fromCharCode(bytes[offset+4], bytes[offset+5], bytes[offset+6], bytes[offset+7]);
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        if (dataEnd + 4 > bytes.length) break;

        if (type === 'tEXt') {
            // keyword\0text
            const nullIdx = bytes.indexOf(0, dataStart);
            if (nullIdx !== -1 && nullIdx < dataEnd) {
                const keyword = new TextDecoder('latin1').decode(bytes.slice(dataStart, nullIdx));
                const text = new TextDecoder('utf-8').decode(bytes.slice(nullIdx + 1, dataEnd));
                result[keyword] = text;
            }
        } else if (type === 'iTXt') {
            // keyword\0 compFlag(1) compMethod(1) lang\0 translatedKeyword\0 text
            const nullIdx = bytes.indexOf(0, dataStart);
            if (nullIdx !== -1 && nullIdx + 4 < dataEnd) {
                const keyword = new TextDecoder('latin1').decode(bytes.slice(dataStart, nullIdx));
                const compressed = bytes[nullIdx + 1] === 1;
                // skip compression method, lang tag, translated keyword
                const langEnd = bytes.indexOf(0, nullIdx + 3);
                const transEnd = bytes.indexOf(0, langEnd + 1);
                if (transEnd !== -1 && transEnd < dataEnd && !compressed) {
                    const text = new TextDecoder('utf-8').decode(bytes.slice(transEnd + 1, dataEnd));
                    result[keyword] = text;
                }
            }
        } else if (type === 'IEND') break;

        offset = dataEnd + 4; // skip CRC
    }
    return result;
}

// Shared validation for every read
function validateRange(fileSize, start, length) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length)) return 0;
    if (start < 0 || length <= 0) return 0;
    if (length > MAX_METADATA_READ) return 0;
    if (start >= fileSize) return 0;
    return Math.min(length, fileSize - start);
}

async function readFromHandle(handle, fileSize, start, length) {
    const safeLength = validateRange(fileSize, start, length);
    if (safeLength === 0) return new Uint8Array(0);

    const buf = Buffer.alloc(safeLength);
    const { bytesRead } = await handle.read(buf, 0, safeLength, start);
    return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
}

async function readRange(filePath, start, length) {
    const handle = await fs.open(filePath, 'r');
    try {
        const { size } = await handle.stat();
        return await readFromHandle(handle, size, start, length);
    } finally {
        await handle.close();
    }
}

function isMatroska(bytes) {
    return bytes.length >=4 && bytes[0] === 0x1A && bytes[1] === 0x45 && bytes[2] === 0xDF && bytes[3] === 0xA3;
}

async function readBoxHeader(handle, fileSize, offset, end) {
    if (offset + 8 > end) return null;

    // Read 16 bytes to cover both standard and extended size boxes
    const header = await readFromHandle(handle, fileSize, offset, Math.min(16, end - offset));
    if (header.length < 8) return null;
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);

    let size = view.getUint32(0, false);
    let headerLen = 8;
    const type = String.fromCharCode(header[4], header[5], header[6], header[7]);

    if (size === 1) {
        // 64-bit extended size, common for large mdat
        if (header.length < 16) return null;
        size = Number(view.getBigUint64(8, false));
        headerLen = 16;
    } else if (size === 0) {
        size = end - offset;  // box extends to the end of its parent
    }

    // Validate size after real size is known
    if (!Number.isSafeInteger(size)) return null;
    if (size < headerLen) return null;
    if (size > end - offset) return null;

    return { offset, size, headerLen, type };
}

// Walks boxes between [start, end) reading only headers, never box payloads
// One open handle for the whole walk, so a long scan costs reads, not opens.
async function findBoxOnDisk(filePath, start, end, searchType) {
    const handle = await fs.open(filePath, 'r');
    try {
        const { size: fileSize } = await handle.stat();
        let offset = start;
        let visited = 0;
        while (offset + 8 <= end) {
            if (++visited > MAX_BOX_SCAN) return null;
            const box = await readBoxHeader(handle, fileSize, offset, end);
            if (!box) return null;
            if (box.type === searchType) return box;
            offset += box.size;  // size >= headerLen >= 8, so this always advances
        }
        return null;
    } finally {
        await handle.close();
    }
}

function findVideoKey(tags) {
    const potentialKeys = ['prompt', 'comment', 'workflow', 'description', '©cmt', '©des'];

    const looksUsable = (obj) =>
        obj && typeof obj === 'object' && (
            obj.parameters ||
            obj.prompt ||
            Array.isArray(obj.nodes) ||
            Object.values(obj).some(v => v && typeof v === 'object' && 'class_type' in v)
        );
    for (const k of potentialKeys) {
        const hit = Object.entries(tags).find(([key]) => key.toLowerCase().includes(k));
        if (!hit) continue;
        const parsed = tryParse(hit[1]);
        if (looksUsable(parsed)) return parsed;
    }
    return null;
}

function tryParse(raw) {
    try {
        if (raw.startsWith('{\\"')) {
            raw = raw.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
            // Matroska stores ComfyUI prompts as escaped strings, unescape if needed
            raw = trimToBalancedJson(raw);
        }
        return JSON.parse(raw);
    } catch (e) {
        console.error('JSON parse failed:', e.message);
        return null;
    }
}

async function loadVideo(filePath, fileSize) {
    try {
        const HEAD = 4 * 1024 * 1024;

        // First only read the first 4 bytes to determine if it's a EBML Matroska
        const magic = await readRange(filePath, 0, 4);

        let tags;
        if (isMatroska(magic)) {
            const head = await readRange(filePath, 0, Math.min(HEAD, fileSize));
            tags = extractMatroskaMetadata(head);
        } else {
            const moov = await findBoxOnDisk(filePath, 0, fileSize, 'moov');
            if (!moov) return null;

            if (moov.size <= MAX_METADATA_READ) {
                const moovBytes = await readRange(filePath, moov.offset, moov.size);
                tags = parseMp4Metadata(moovBytes, { moovStart: moov.headerLen });
            } else {
                // moov is too large to buffer. Walk it on disk and read only udta,
                // which is where the generation metadata lives.
                const udta = await findBoxOnDisk(
                    filePath,
                    moov.offset + moov.headerLen,
                    moov.offset + moov.size,
                    'udta'
                );
                if (!udta || udta.size > MAX_METADATA_READ) {
                    logger(`Video extraction skipped for "${filePath.split("\\").pop()}": metadata exceeds the ${MAX_METADATA_READ / 1024 / 1024} MB read limit`);
                    return null;
                }
                const udtaBytes = await readRange(filePath, udta.offset, udta.size);
                tags = parseMp4Metadata(udtaBytes, { udtaStart: udta.headerLen });
            }
        }

        if (!tags || Object.keys(tags).length === 0) return null;

        return findVideoKey(tags);
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

function parseMp4Metadata(bytes, options = {}) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const decoder = new TextDecoder('utf-8');
    const readU32 = (o) => view.getUint32(o, false);
    const readType = (o) => String.fromCharCode(bytes[o], bytes[o+1], bytes[o+2], bytes[o+3]);
    const result = {};

    function findBox(boxType, start, end) {
        const limit = Math.min(end, bytes.length);
        let offset = start;
        while (offset + 8 <= limit) {
            let size = readU32(offset);
            const type = readType(offset + 4);
            if (size === 0) size = limit - offset;  // box extends to parent end
            // Validate before trusting the box
            if (size < 8 || offset + size > limit) break;
            if (type === boxType) return { start: offset + 8, end: offset + size };
            offset += size;
        }
        return null;
    }

    function listBoxes(start, end) {
        const boxes = [];
        const limit = Math.min(end, bytes.length);
        let offset = start;
        while (offset + 8 <= limit) {
            const size = readU32(offset);
            const type = readType(offset + 4);
            if (size < 8 || offset + size > limit) break;
            boxes.push({ type, typeOffset: offset + 4, start: offset + 8, end: offset + size });
            offset += size;
        }
        return boxes;
    }

    let udta;
    if (Number.isSafeInteger(options.udtaStart)) {
        // Buffer is a bare udta box (moov was too large to load)
        udta = { start: options.udtaStart, end: bytes.length };
    } else {
        // Buffer is a moov box, its offsets were already validated on disk
        const moov = Number.isSafeInteger(options.moovStart)
            ? { start: options.moovStart, end: bytes.length }
            : findBox('moov', 0, bytes.length);
        if (!moov) return result;
        udta = findBox('udta', moov.start, moov.end);
    }
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
    const scanSlice = bytes.length > 2_000_000 ? bytes.slice(0, 2_000_000) : bytes;
    const asLatin1 = new TextDecoder('latin1').decode(scanSlice);
    // For large files, only scan the first 2 MB. If start fails, scan the end too.

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
    setLogger,
    VALID_FORMATS
};
