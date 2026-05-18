function extractA1111Metadata(parameters) {
    if (!parameters) return null;

    let result = {
        'full_prompt': parameters.trim(),
        'positive': "",
        'negative': "",
        'steps': "",
        'sampler': "",
        'scheduler': "",
        'cfg': "",
        'size': "",
        'seed': "",
        'model': "",
        'loras': {}
    };

    const parts = parameters.split('\nSteps: ');
    if (parts.length < 2) return result;

    let promptPart = parts[0];
    let settingsPart = "Steps: " + parts[1];

    if (promptPart.includes("Negative prompt:")) {
        let [pos, neg] = promptPart.split("Negative prompt:");
        result.positive = pos ? pos.trim() : "";
        result.negative = neg ? neg.trim() : "";
    } else {
        result.positive = promptPart.trim();
    }

    function getSetting(key) {
        const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        let regex = new RegExp(`${escapedKey}:\\s*(.+?)(?:,|$)`);
        let match = settingsPart.match(regex);
        return (match && match[1]) ? match[1].trim() : "";
    }

    result.steps = getSetting("Steps");
    result.sampler = getSetting("Sampler");
    result.scheduler = getSetting("Schedule type");
    result.cfg = getSetting("CFG scale");
    result.seed = getSetting("Seed");
    result.size = getSetting("Size");
    result.model = getSetting("Model");

    const loraMatches = [...parameters.matchAll(/<lora:([^:]+):([^>]+)>/g)];
    result.loras = Object.fromEntries(loraMatches.map(m => [m[1], m[2]]));

    return result;
}

module.exports = {
    extractA1111Metadata
};