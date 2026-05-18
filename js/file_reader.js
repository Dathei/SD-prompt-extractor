const { execFile } = require('child_process');
const exifr = require('exifr');
const util = require('util');
const execFilePromise = util.promisify(execFile);

const VALID_FORMATS = ['.png', '.jpg', '.jpeg', '.mp4', '.mkv', '.webm', '.mov', '.avi'];

async function load_video(filePath) {
    try {
        const ffmpegPaths = await eagle.extraModule.ffmpeg.getPaths();
        const ffprobePath = ffmpegPaths.ffprobe;

        const { stdout } = await execFilePromise(ffprobePath, [
            "-v", "quiet",
            "-print_format", "json",
            "-show_format",
            filePath
        ]);

        const formatTags = JSON.parse(stdout).format?.tags || {};

        const potential_keys = ['comment', 'COMMENT', 'prompt', 'Prompt', 'workflow', 'Workflow', 'description'];
        let commentStr = null;

        for (const key of potential_keys) {
            if (formatTags[key]) {
                commentStr = formatTags[key];
                break;
            }
        }
        if (!commentStr) return null;

        return JSON.parse(commentStr);
    } catch (error) {
        console.error("Video extraction failed:", error);
        return null;
    }
}

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
        return await load_video(filePath);
    }
}

module.exports = {
    loadFile,
    VALID_FORMATS
};
