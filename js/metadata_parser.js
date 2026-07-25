const {extractA1111Metadata} = require("./a1111_parser");
const {extractComfyMetadata} = require("./comfy_parser");

const capitalize = (s) => (typeof s === 'string' && s.length > 0) ? s.charAt(0).toUpperCase() + s.slice(1) : s;

function formatParameters(parameters) {
    const parts = [];

    const positive = parameters.positive || '';
    if (positive) {
        parts.push(String(positive).trim());
    }

    const loras = parameters.loras || {};
    if (Object.keys(loras).length > 0) {
        let lora_lines = ['Loras:'];
        for (const [name, strength] of Object.entries(loras)) {
            let parsedStrength = parseFloat(strength);
            if (!isNaN(parsedStrength)) {
                lora_lines.push(`${name}: ${parsedStrength.toFixed(2)}`);
            } else {
                lora_lines.push(`${name}: ${strength}`);
            }
        }
        parts.push(lora_lines.join('\n'));
    }

    const negative = parameters.negative || '';
    if (negative) {
        parts.push(`Negative prompt: ${String(negative).trim()}`);
    }

    const params = [];

    if (parameters.steps) params.push(`Steps: ${parameters.steps}`);
    if (parameters.sampler) params.push(`Sampler: ${capitalize(String(parameters.sampler).split(/[\\/]/).pop())}`);
    if (parameters.scheduler) params.push(`Scheduler: ${capitalize(String(parameters.scheduler))}`);
    if (parameters.cfg) params.push(`CFG scale: ${parseFloat(Number(parameters.cfg).toFixed(2))}`);
    if (parameters.seed) params.push(`Seed: ${parameters.seed}`);
    if (parameters.size) params.push(`Size: ${parameters.size}`);
    if (parameters.model) params.push(`Model: ${String(parameters.model).trim()}`);
    if (parameters.extra_params) {
        for (const [k, v] of Object.entries(parameters.extra_params)) {
            params.push(`${k}: ${v}`);
        }
    }

    if (params.length > 0) {
        parts.push(params.join(', '));
    }

    return parts.join('\n\n');
}

function addLorasAsTags(loras, stripVersion = false) {
    if (!loras) return [];

    const tags = [];
    const versionPattern = /(?:[_-]|(?<=[a-zA-Z]))(?:[vV]\d+(?:[_.-]\d+)?|0+\d+)(?=[_-]|$)|[_-](?:epoch|ep|st)[_-]?\d+(?=[_-]|$)/g;

    for (let loraName of Object.keys(loras)) {
        if (stripVersion) {
            loraName = loraName.replace(versionPattern, '');
            // Cleanup double underscores/dashes left behind in the middle
            loraName = loraName.replace(/_{2,}/g, '_').replace(/-{2,}/g, '-');
            // Cleanup any dangling underscores/dashes at the start and end
            loraName = loraName.replace(/^[-_]+|[-_]+$/g, '');
        }
        tags.push(`lora: ${loraName}`);
    }

    return tags;
}

function parseRaw(rawMetadata) {
    if (!rawMetadata) return null;
    if (rawMetadata.parameters) return extractA1111Metadata(rawMetadata.parameters);
    if (rawMetadata.prompt) {
        let nodes = rawMetadata.prompt;
        if (typeof nodes === 'string') {
            try { nodes = JSON.parse(nodes.replace(/\bNaN\b/g, 'null')); } catch (e) { nodes = {}; }
        }
        return extractComfyMetadata(nodes);
    }
    if (looksLikeComfyNodes(rawMetadata)) return extractComfyMetadata(rawMetadata);
    return null;
}

function getFormattedMetadata(rawMetadata, stripVersion = false) {
    const parsed = parseRaw(rawMetadata);
    if (!parsed) return { annotation: "", tags: [] };

    let annotation = formatParameters(parsed);
    // Cleanup space after commas
    annotation = annotation.replace(/,(\w)/g, ', $1');

    let tags = addLorasAsTags(parsed.loras, stripVersion);
    const pluginTags = [...new Set([
        ...addLorasAsTags(parsed.loras, true),
        ...addLorasAsTags(parsed.loras, false)
    ])];

    return { annotation, tags, pluginTags };
 }

function looksLikeComfyNodes(obj) {
    if (!obj || typeof obj !== 'object') return false;
    // ComfyUI nodes are number keys and each value has a class_type field
    const values = Object.values(obj);
    if (values.length === 0) return false;
    return values.some(v => v && typeof v === 'object' && 'class_type' in v);
}

 module.exports = {
    addLorasAsTags,
    getFormattedMetadata
 };


