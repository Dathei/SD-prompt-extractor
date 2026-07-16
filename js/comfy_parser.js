

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
    const classType = (inputs['class'] || targetNode.class_type || '').toLowerCase();

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

        // Handle reroutes
        if (classType.includes('reroute') || classType.includes('showanything')) {
            console.log(inputs);
            if ('text' in inputs && typeof inputs.text === 'string' && inputs.text.trim() !== '') {
                return inputs.text;
            }
            const passThroughKeys = ['anything', 'value'];
            for (let key of passThroughKeys) {
                if (key in inputs) {
                    let passValue = inputs[key];
                    return Array.isArray(passValue) ? resolveLinkedNode(passValue, nodes, targetParam, visited) : passValue;
                }
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

    // ImpactWildcardProcessor
    const wildcardText = getStr('populated_text');
    console.log(wildcardText);
    if (wildcardText) {
        extracted.text = wildcardText;
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

    // TextEncodeQwenImageEdit, TextEncodeZImageOmni, Wildcard Processor (Mikey) & probably others
    const prompt = getStr('prompt');
    if (prompt) {
        extracted.text = prompt;
        return extracted;
    }

    return extracted;
}


const LATENT_LINK_KEYS = [
    'latent_image', 'latent', 'latents', 'samples', 'image', 'images', 'pixels', 'video'
];

function isSamplerPass(inputs) {
    if (!('steps' in inputs) && !('sigmas' in inputs)) return false;
    return Object.entries(inputs).some(([k,v]) => Array.isArray(v) && LATENT_LINK_KEYS.includes(k));
}

function traceSamplingChain(nodeId, nodes, visited, chain) {
    nodeId = nodeId.toString();
    if (visited.has(nodeId)) return;
    visited.add(nodeId);

    const node = nodes[nodeId];
    if (!node) return;

    const inputs = node.inputs || {};
    const linkEntries = Object.entries(inputs).filter(([,v]) => Array.isArray(v) && v.length > 0);

    if (isSamplerPass(inputs)) {
        chain.push({ id: nodeId, inputs: inputs, classType: node.class_type || '' });

        for (const [key,link] of linkEntries) {
            if (LATENT_LINK_KEYS.includes(key)) {
                traceSamplingChain(link[0], nodes, visited, chain);
            }
        }
        return;
    }

    // Prefer latent link connections, otherwise follow anything else (reroutes/unknown custom nodes)
    const latentLinks = Object.entries(linkEntries).filter(([k]) => LATENT_LINK_KEYS.includes(k));
    const toFollow = latentLinks.length > 0 ? latentLinks : linkEntries;
    for (const [, link] of toFollow) {
        traceSamplingChain(link[0], nodes, visited, chain);
    }
}


function findSamplerChain(nodes) {
    const referenced = new Set();
    for (const data of Object.values(nodes)) {
        for (const val of Object.values(data.inputs || {})) {
            if (Array.isArray(val) && val.length > 0) {
                referenced.add(val[0]).toString();
            }
        }
    }
    const sinks = Object.keys(nodes).filter(nId => !referenced.has(nId));

    // Prefer save nodes over preview nodes
    const sinkScore = (id) => {
        const t = (nodes[id].class_type || '').toLowerCase();
        if (t.includes('save') || t.includes('combine')) return 0;
        if (t.includes('preview') || t.includes('compare')) return 2;
        return 1;
    }
    sinks.sort((a, b) => sinkScore(a) - sinkScore(b));

    const chain = [];
    const visited = new Set();
    for (const sink of sinks) {
        traceSamplingChain(sink, nodes, visited, chain);
        if (chain.length > 0) break;
    }
    return chain;
}

// Find out how much of the image this pass (re)generates. 1.0 = full generation.
// This is to avoid pre-processing passes (they have denoise < 1.0)
function denoiseFraction(inputs, nodes) {
    let d = inputs.denoise;
    if (Array.isArray(d)) d = resolveLinkedNode(d, nodes, 'denoise');
    if (d !== undefined && d !== null && d !== '') {
        const f = parseFloat(d);
        if (!isNaN(f)) return f;
    }
    // KSamplerAdvanced-style refiner passes
    if (inputs.add_noise === 'disable' || inputs.add_noise === false) return 0.0;
    let sas = inputs.start_at_step;
    if (Array.isArray(sas)) sas = resolveLinkedNode(sas, nodes, 'start_at_step');
    if (sas !== undefined && parseFloat(sas) > 0) return 0.5;
    // SamplerCustom-style: denoise lives on the scheduler behind sigmas
    if (Array.isArray(inputs.sigmas)) {
        const f = parseFloat(resolveLinkedNode(inputs.sigmas, nodes, 'denoise'));
        if (!isNaN(f)) return f;
    }
    return 1.0;     // might cause problems, maybe better to return null as default
}

function pickMainSampler(chain, nodes) {
    if (!chain || chain.length === 0) return null;
    for (const pass of chain) {
        if (denoiseFraction(pass.inputs, nodes) >= 0.99) return pass;
    }
    // Fallback: Full denoise not found, return earliest pass (e.g. when doing img2img)
    return chain[chain.length - 1];
}


// Conditioning traversal (positive/negative prompt)
const COND_FOLLOW_RX = /cond|positive|negative|prompt|text|pipe|base/;
const COND_STOP_KEYS = [
    'clip', 'model', 'vae', 'control_net', 'clip_vision', 'style_model',
    'mask', 'image', 'images', 'pixels', 'latent_image', 'samples',
    'noise', 'sampler', 'sigmas', 'guider'
];

function traceCondTexts(link, nodes, which, visited = new Set(), out = null) {
    if (!out) out = { texts: [], zeroed: false };
    if (!Array.isArray(link) || link.length < 1) return out;

    const nodeId = link[0].toString();
    if (visited.has(nodeId)) return out;
    visited.add(nodeId);

    const node = nodes[nodeId];
    if (!node) return out;

    const inputs = node.inputs || {};
    const classType = (node.class_type || '').toLowerCase();

    // ConditioningZeroOut
    if (classType.includes('zeroout')) {
        out.zeroed = true;
        return out;
    }

    const extracted = extractComfyPrompt(node);
    let text = extracted[which] || extracted.text;

    // Text widgets can themselves be links (primitives, wildcard nodes, ...)
    if (!text) {
        const textKeys = ['text', 'populated_text', 'prompt', which, which + '_prompt'];
        for (const key of textKeys) {
            if (Array.isArray(inputs[key])) {
                const resolved = resolveLinkedNode(inputs[key], nodes, 'text');
                if (typeof resolved === 'string' && resolved.trim()) {
                    text = resolved.trim();
                    break;
                }
            }
        }
    }
    if (text) {
        out.texts.push(text);
        return out;
    }

    if (classType.includes('textencode')) return out;

    // Follow condition-like links
    // For unknown nodes fall back to everything except clearly wrong keys
    const linkEntries = Object.entries(inputs).filter(([, v]) => Array.isArray(v) && v.length > 0);
    let toFollow = linkEntries.filter(([k]) => COND_FOLLOW_RX.test(k));
    if (toFollow.length === 0) {
        toFollow = linkEntries.filter(([k]) => !COND_STOP_KEYS.includes(k));
    }
    for (const [, l] of toFollow) {
        traceCondTexts(l, nodes, which, visited, out);
    }
    return out;
}


function getCondLinks(samplerInputs, nodes) {
    let pos = samplerInputs.positive || samplerInputs.cond || null;
    let neg = samplerInputs.negative || null;

    // SamplerCustomAdvanced hides conditioning behind a guider
    if (!pos && Array.isArray(samplerInputs.guider)) {
        const guider = nodes[samplerInputs.guider[0].toString()];
        const gInputs = guider ? (guider.inputs || {}) : {};
        pos = gInputs.positive || gInputs.conditioning || null;
        neg = gInputs.negative || null;
    }

    return {
        pos: Array.isArray(pos) ? pos : null,
        neg: Array.isArray(neg) ? neg : null,
        // In case the prompt was embedded as a plain string
        posStr: typeof pos === 'string' && pos.trim() ? pos.trim() : null,
        negStr: typeof neg === 'string' && neg.trim() ? neg.trim() : null
    };
}


function traceModelName(link, nodes, visited = new Set()) {
    if (!Array.isArray(link) || link.length < 1) return null;
    const nodeId = link[0].toString();
    if (visited.has(nodeId)) return null;
    visited.add(nodeId);

    const node = nodes[nodeId];
    if (!node) return null;
    const inputs = node.inputs || {};

    // Loader reached: a string input naming the model file
    for (const [k, v] of Object.entries(inputs)) {
        if (typeof v === 'string' && v.trim() && !k.includes('lora') &&
            (k.includes('ckpt') || k.includes('unet') || k.includes('gguf') || k.endsWith('_name'))) {
            return v.split(/[\\/]/).pop();
        }
    }

    for (const [k, v] of Object.entries(inputs)) {
        if (Array.isArray(v) && v.length > 0 && /model|guider|pipe|sigmas/.test(k)) {
            const found = traceModelName(v, nodes, visited);
            if (found) return found;
        }
    }
    return null;
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

    const samplerChain = findSamplerChain(nodes);
    const mainSampler = pickMainSampler(samplerChain, nodes);

    if (mainSampler) {
        const mIn = mainSampler.inputs;

        let steps = mIn.steps || mIn.sigmas;
        if (Array.isArray(steps)) steps = resolveLinkedNode(steps, nodes, 'steps');
        if (steps) result.steps = steps;

        let samplerVal = mIn.sampler || mIn.sampler_name;
        if (Array.isArray(samplerVal)) samplerVal = resolveLinkedNode(samplerVal, nodes, 'sampler');
        if (samplerVal && typeof samplerVal === 'string') result.sampler = samplerVal;

        let schedulerVal = mIn.scheduler || mIn.sigmas;
        if (Array.isArray(schedulerVal)) schedulerVal = resolveLinkedNode(schedulerVal, nodes, 'scheduler');
        if (schedulerVal && typeof schedulerVal === 'string') result.scheduler = schedulerVal;

        let cfgVal = mIn.cfg || mIn.guider;
        if (Array.isArray(cfgVal)) cfgVal = resolveLinkedNode(cfgVal, nodes, 'cfg');
        if (cfgVal !== null && cfgVal !== undefined && typeof cfgVal !== 'object') result.cfg = cfgVal;

        let seedVal = mIn.seed || mIn.noise_seed || mIn.noise;
        if (Array.isArray(seedVal)) seedVal = resolveLinkedNode(seedVal, nodes, 'seed');
        if (seedVal !== null && seedVal !== undefined && typeof seedVal !== 'object') result.seed = seedVal;

        const cond = getCondLinks(mIn, nodes);
        if (cond.posStr) result.positive = cond.posStr;
        if (cond.negStr) result.negative = cond.negStr;

        if (!result.positive && cond.pos) {
            const traced = traceCondTexts(cond.pos, nodes, 'positive');
            if (traced.texts.length > 0) {
                result.positive = [...new Set(traced.texts)].join(', ');
            }
        }
        if (!result.negative && cond.neg) {
            const traced = traceCondTexts(cond.neg, nodes, 'negative');
            if (traced.zeroed || traced.texts.length === 0) {
                emptyNegative = true;
            } else {
                result.negative = [...new Set(traced.texts)].join(', ');
            }
        }
        // No negative conditioning at all
        if (result.positive && !cond.neg && !cond.negStr && !result.negative) {
            emptyNegative = true;
        }

        // The model that actually fed the main pass
        const modelLink = mIn.model || mIn.guider || mIn.sigmas;
        if (Array.isArray(modelLink)) {
            const modelName = traceModelName(modelLink, nodes);
            if (modelName) result.model = modelName;
        }
    }

    // Flat scan (fallbacks, LoRAs, size, guidance)
    for (const nodeData of Object.values(nodes)) {
        const nodeType = (nodeData.class_type || '').toLowerCase();
        const inputs = nodeData.inputs || {};

        // Look for positive/negative prompt
        const textNodes = ["easy positive", "easy negative", "wildcard processor", "impactwildcardprocessor"];
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
