

function resolveLinkedNode(link, nodes, targetParam = null, visited = new Set()) {
    if (!Array.isArray(link) || link.length < 1) {
        return link;
    }

    const targetId = link[0].toString();

    if (visited.has(targetId)) {
        return null;
    }
    visited.add(targetId);

    const targetNode = nodes[targetId] || {};
    const inputs = targetNode.inputs || {};
    const classType = (inputs['class'] || inputs.class_type || '').toLowerCase();

    try {
        // Handle explicit value/primitives
        if ('value' in inputs || classType.includes('primitive')) {
            const value = inputs.value;
            return Array.isArray(value) ? resolveLinkedNode(value, nodes, targetParam, visited) : value;
        }

        // Handle switch routes
        if ('switch' in inputs || classType.includes('switch')) {
            let switchValue = inputs.switch;
            if (Array.isArray(switchValue)) {
                switchValue = resolveLinkedNode(switchValue, nodes, 'switch', visited);
            }

            if (switchValue && 'on_true' in inputs) {
                return resolveLinkedNode(inputs.on_true, nodes, targetParam, visited);
            } else if (!switchValue && 'on_false' in inputs) {
                return resolveLinkedNode(inputs.on_false, nodes, targetParam, visited);
            }
        }

        // Handle resolution nodes
        if (['width', 'height'].includes(targetParam)) {
            if ('megapixels' in inputs && ('aspect_ratio' in inputs || 'ratio' in inputs)) {
                let megapixels = inputs.megapixels;
                if (Array.isArray(megapixels)) {
                    megapixels = resolveLinkedNode(megapixels, nodes, 'megapixels', visited);
                }

                let aspectRatio = inputs.aspect_ratio || inputs.ratio;
                if (Array.isArray(aspectRatio)) {
                    aspectRatio = resolveLinkedNode(aspectRatio, nodes, 'aspect_ratio', visited);
                }

                let [widthRatio, heightRatio] = parseAspectRatio(aspectRatio);
                let [w, h] = calculateResolution(widthRatio, heightRatio, parseFloat(megapixels));

                return targetParam === 'width' ? w : h;
            }
        }

        // Direct target parameter match
        if (targetParam && targetParam in inputs) {
            let value = inputs[targetParam];
            return Array.isArray(value) ? resolveLinkedNode(value, nodes, targetParam, visited) : value;
        }

        // Special case when CreateCFGScheduleFloatList is used
        if (targetParam === 'cfg') {
            let start = inputs.cfg_scale_start;
            let end = inputs.cfg_scale_end;

            if (start !== undefined && end !== undefined) {
                if (Array.isArray(start)) start = resolveLinkedNode(start, nodes, targetParam, visited);
                if (Array.isArray(end)) end = resolveLinkedNode(end, nodes, targetParam, visited);

                const startFloat = parseFloat(start);
                const endFloat = parseFloat(end);

                if (!isNaN(startFloat) && !isNaN(endFloat)) {
                    return startFloat === endFloat ? startFloat : `${startFloat} -> ${endFloat}`;   // incompatible with A1111
                }
                return start;
            }
        }

        // Fallback aliases
        const aliases = {
            'sampler': ['sampler_name', 'sampler'],
            'steps': ['steps', 'sigmas'],
            'seed': ['seed', 'noise', 'noise_seed'],
            'cfg': ['cfg', 'guider', 'guidance'],
        };

        const targetAliases = aliases[targetParam] || [];
        for (let alias of targetAliases) {
            if (alias in inputs) {
                let value = inputs[alias];
                return Array.isArray(value) ? resolveLinkedNode(value, nodes, targetParam, visited) : value;
            }
        }

    } catch (error) {
        console.error(`Error resolving ${targetParam} on node ${targetId}: ${error}`);
    }
    return null;
}

function parseAspectRatio(aspectRatio) {
    const regex =  /(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)/;
    const match = String(aspectRatio).match(regex);
    if (match) {
        return [parseFloat(match[1]), parseFloat(match[2])];
    }
    return [0.0, 0.0];
}

function calculateResolution(widthRatio, heightRatio, megapixels) {
    if (heightRatio === 0 || widthRatio === 0) return [1024, 1024];
    const base = 1024 * 1024;
    const area = megapixels * base;
    const ratio = widthRatio / heightRatio;
    let h = Math.sqrt(area / ratio);
    let w = h * ratio;
    w = Math.round(w / 8) * 8;
    h = Math.round(h / 8) * 8;
    return [w, h];
}

function getActiveGraph(nodes) {
    const activeIds = new Set();
    const referenced = new Set();

    // Nodes that are references by other nodes
    for (const data of Object.values(nodes)) {
        const inputs = data.inputs || {};
        for (const val of Object.values(inputs)) {
            if (Array.isArray(val) && val.length > 0) {
                referenced.add(val[0].toString());
            }
        }
    }

    // Nodes that are not referenced by other nodes
    const sinks = Object.keys(nodes).filter(nId => !referenced.has(nId));

    // Helper to trace nodes backwards from sinks
    function trace(nId) {
        if (activeIds.has(nId)) return;
        activeIds.add(nId);

        const node = nodes[nId];
        if (!node) return;

        const inputs = node.inputs || {};

        if ('switch' in inputs && ('on_true' in inputs || 'on_false' in inputs)) {
            const switchLink = inputs.switch;
            if (Array.isArray(switchLink)) {
                trace(switchLink[0].toString());
            }

            const switchVal = resolveLinkedNode(switchLink, nodes, 'switch');
            const activePath = switchVal ? 'on_true' : 'on_false';

            if (activePath in inputs && Array.isArray(inputs[activePath])) {
                trace(inputs[activePath][0].toString());
            }
        } else {
            // Normal nodes: trace all array connections
            for (const val of Object.values(inputs)) {
                if (Array.isArray(val) && val.length > 0) {
                    trace(val[0].toString());
                }
            }
        }
    }

    for (const sink of sinks) {
        trace(sink.toString());
    }

    const activeNodes = {};
    for (const [k, v] of Object.entries(nodes)) {
        if (activeIds.has(k)) {
            activeNodes[k] = v;
        }
    }
    return activeNodes;
}

function extractComfyPrompt(nodeData) {
    const inputs = nodeData.inputs || {};
    let extracted = {'positive': null, 'negative': null, 'text': null};

    function getStr(key) {
        const val = inputs[key];
        return (typeof val === 'string' && val.trim()) ? val.trim() : '';
    }

    const text = getStr('text');
    if (text) {
        extracted.text = text;
        return extracted;
    }

    // CLIPTextEncodeSDXL
    const textG = getStr('text_g');
    const textL = getStr('text_l');
    if (textG || textL) {
        extracted.text = (textG === textL) ? textG : `${textG} ${textL}`.trim();
        return extracted;
    }

    // CLIPTextEncodeFlux
    const clipL = getStr('clip_l');
    const t5xxl = getStr('t5xxl');
    if (clipL || t5xxl) {
        extracted.text = (clipL === t5xxl) ? clipL : `${clipL} ${t5xxl}`.trim();
        return extracted;
    }

    // easy positive/easy negative
    const positive = getStr('positive');
    if (positive) {
        extracted.positive = positive;
        return extracted;
    }
    const negative = getStr('negative');
    if (negative) {
        extracted.negative = negative;
        return extracted;
    }

    // WAN (dual prompt node)
    const posPrompt = getStr('positive_prompt');
    const negPrompt = getStr('negative_prompt');
    if (posPrompt || negPrompt) {
        extracted.positive = posPrompt || null;
        extracted.negative = negPrompt || null;
        return extracted;
    }

    // TextEncodeQwenImageEdit & TextEncodeZImageOmni & probably others
    const prompt = getStr('prompt');
    if (prompt) {
        extracted.text = prompt;
        return extracted;
    }

    return extracted;
}

function extractComfyMetadata(nodes) {
    // For debugging workflows:
    // console.log(JSON.stringify(nodes, null, 2));

    if (!nodes || Object.keys(nodes).length === 0) return {};

    // Prune inactive nodes
    nodes = getActiveGraph(nodes);
    if (!nodes || Object.keys(nodes).length === 0) return {};

    const activeLoras = {};
    let result = {
        'positive': "",
        'negative': "",
        'steps': "",
        'sampler': "",
        'scheduler': "",
        'cfg': "",
        'size': "",
        'seed': "",
        'model': "",
        'loras': activeLoras
    };

    let potentialPrompts = [];
    const ksamplers = [];
    let emptyNegative = false;

    for (const nodeData of Object.values(nodes)) {
        const nodeType = (nodeData.class_type || '').toLowerCase();
        const inputs = nodeData.inputs || {};

        // Look for positive/negative prompt
        const textNodes = ["easy positive", "easy negative", "wildcard processor"];
        if (nodeType.includes('textencode') || textNodes.includes(nodeType)) {
            const extracted = extractComfyPrompt(nodeData);

            if (extracted.positive && !result.positive) {
                result.positive = extracted.positive;
            }

            if (extracted.negative !== null) {
                if (extracted.negative === '') {
                    emptyNegative = true;
                } else if (!result.negative) {
                    result.negative = extracted.negative;
                }
            }

            if (extracted.text) {
                const title = (nodeData._meta?.title || '').toLowerCase();
                const textVal = extracted.text;

                // If the title contains "positive" or "negative" it can easily be categorized
                if (title.includes('positive') && !result.positive) {
                    result.positive = textVal;
                } else if (title.includes('negative')) {
                    if (textVal === '') emptyNegative = true;
                    else if (!result.negative) result.negative = textVal;
                } else if (textVal) {
                    potentialPrompts.push(textVal);
                }
            }
        }

        // Look for Sampler for settings
        if (nodeType.includes('sampler')) {
            let link = inputs.steps || inputs.sigmas;
            if (Array.isArray(link)) {
                inputs.steps = resolveLinkedNode(link, nodes, 'steps');
            }
            ksamplers.push(inputs);
        }

        // Look for Guidance, which is the CFG replacement for Flux for example
        if (nodeType.includes('guid')) {
            let guidance = inputs.guidance;
            if (Array.isArray(guidance)) {
                guidance = resolveLinkedNode(guidance, nodes, 'cfg');
            }
            if (guidance) result.cfg = guidance;
        }

        // Look for the model
        const modelKeywords = ['checkpoint', 'unet', 'gguf', 'model'];
        const ignoreKeywords = ['vae', 'image', 'video', 'lora'];

        if (!ignoreKeywords.some(ignore => nodeType.includes(ignore))) {
            if (nodeType.includes('load') && modelKeywords.some(kw => nodeType.includes(kw))) {
                // Just using the first viable result for now
                if (!result.model) {
                    const modelEntry = Object.entries(inputs).find(([k, v]) => k.includes('name') || k.includes('model'));
                    if (modelEntry && typeof modelEntry[1] === 'string') {
                        result.model = modelEntry[1].split(/[\\/]/).pop();
                    }
                }
            }
        }

        // Look for EmptyLatent/Resizer to get the resolution
        const isEmptyLatent = nodeType.includes('latent') && nodeType.includes('empty');
        const isResizer = ['imagetovideolatent', 'imageresize'].some(kw => nodeType.includes(kw));

        if ((isEmptyLatent || isResizer) && !result.size) {
            let width = inputs.width;
            if (Array.isArray(width)) width = resolveLinkedNode(width, nodes, 'width');

            let height = inputs.height;
            if (Array.isArray(height)) height = resolveLinkedNode(height, nodes, 'height');

            if (width && height) {
                result.size = `${width}x${height}`;
            }
        }

        // Look for LoRas
        if (nodeType.includes('lora')) {
            let loraName = inputs.lora_name;
            let loraStrength = parseFloat(inputs.strength_model);

            if (loraName && typeof loraName === 'string' && loraStrength !== 0.0) {
                // Remove rest of path and file extension
                loraName = loraName.split(/[\\/]/).pop().split('.')[0];
                activeLoras[loraName] = isNaN(loraStrength) ? 1.0 : loraStrength;
            }
            // Multi-Lora Loader node handling
            else if (inputs.lora_1) {
                for (const [k, v] of Object.entries(inputs)) {
                    if (k.startsWith('lora') && typeof v === 'object') {
                        let innerName = v.lora;
                        if (innerName && typeof innerName === 'string') {
                            innerName = innerName.split(/[\\/]/).pop().split('.')[0];
                            if (v.on) {
                                activeLoras[innerName] = v.strength;
                            }
                        }
                    }
                }
            }
        }
    }

    // The longest text probably is the positive prompt. If found already, it's probably the negative prompt
    potentialPrompts.sort((a, b) => b.length - a.length);

    if (potentialPrompts.length > 0) {
        if (!result.positive) {
            result.positive = potentialPrompts.shift();
        }
        if (!result.negative && !emptyNegative && potentialPrompts.length > 0) {
            result.negative = potentialPrompts.shift();
        }
    }

    // The Ksampler with the highest number of steps probably is the main Ksampler, refiners/upscale typically use fewer steps
    ksamplers.sort((a, b) => {
        let aSteps = parseFloat(a.steps) || 0;
        let bSteps = parseFloat(b.steps) || 0;
        return bSteps - aSteps;
    });

    if (ksamplers.length > 0) {
        const mainSampler = ksamplers[0];

        result.steps = mainSampler.steps;

        let samplerVal = mainSampler.sampler || mainSampler.sampler_name;
        if (Array.isArray(samplerVal)) samplerVal = resolveLinkedNode(samplerVal, nodes, 'sampler');
        result.sampler = samplerVal;

        let schedulerVal = mainSampler.scheduler;
        if (Array.isArray(schedulerVal)) schedulerVal = resolveLinkedNode(schedulerVal, nodes, 'scheduler');
        result.scheduler = schedulerVal;

        if (!result.cfg) {
            let cfgVal = mainSampler.cfg;
            if (Array.isArray(cfgVal)) cfgVal = resolveLinkedNode(cfgVal, nodes, 'cfg');
            result.cfg = cfgVal;
        }

        let seedVal = mainSampler.seed || mainSampler.noise;
        if (Array.isArray(seedVal)) seedVal = resolveLinkedNode(seedVal, nodes, 'seed');
        result.seed = seedVal;
    }

    return result;
}

module.exports = {
    extractComfyMetadata
};
