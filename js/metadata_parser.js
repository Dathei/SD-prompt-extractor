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
    if (parameters.cfg) params.push(`CFG scale: ${parameters.cfg}`);
    if (parameters.seed) params.push(`Seed: ${parameters.seed}`);
    if (parameters.size) params.push(`Size: ${parameters.size}`);
    if (parameters.model) params.push(`Model: ${String(parameters.model).trim()}`);

    if (params.length > 0) {
        parts.push(params.join(', '));
    }

    return parts.join('\n\n');
}

function addLorasAsTags(loras, stripVersion = false) {
    if (!loras) return [];

    const tags = [];
    const versionPattern = /(?:[_-]|(?<=[a-zA-Z]))(?:[vV]\d+(?:[.-]\d+)?|0+\d+)(?=[_-]|$)|[_-]\d+(?:[.-]\d+)?$/g;

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

function getFormattedMetadata(rawMetadata, stripVersion = false) {
     if (!rawMetadata) return {annotation: "", tags: []};

     let parsedDict = null;

     if (rawMetadata.parameters) {
         parsedDict = extractA1111Metadata(rawMetadata.parameters);
     } else if (rawMetadata.prompt) {
         let nodes = rawMetadata.prompt;
         if (typeof nodes === 'string') {
             try { nodes = JSON.parse(nodes); } catch (e) { nodes = {}; }
         }
         parsedDict = extractComfyMetadata(nodes);
     } else {
         parsedDict = extractComfyMetadata(rawMetadata);
     }

    if (!parsedDict) return { annotation: "", tags: [] };

    let annotation = formatParameters(parsedDict);
    // Cleanup space after commas
    annotation = annotation.replace(/,(\w)/g, ', $1');

    let tags = addLorasAsTags(parsedDict.loras, stripVersion);

    return {
        annotation: annotation,
        tags: tags
    };
 }

 module.exports = {
     getFormattedMetadata
 };


