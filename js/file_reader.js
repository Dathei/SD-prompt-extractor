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
        const metadata = await exifr.parse(filePath);

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
                comment = new TextDecoder().decode(comment).replace(/^UNICODE\x00\x00|^ASCII\x00\x00\x00/, '');
            }

            try {
                JSON.parse(comment);
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
