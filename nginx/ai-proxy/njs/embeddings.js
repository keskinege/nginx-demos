function parseOllamaResponse(responseText) {
    const response = JSON.parse(responseText);
    if (response.embeddings && Array.isArray(response.embeddings) && response.embeddings.length > 0) {
        return response.embeddings[0];
    }
    if (response.embedding && Array.isArray(response.embedding)) {
        return response.embedding;
    }
    throw new Error("Ollama response missing embedding array");
}

function parseOpenAIResponse(responseText) {
    const response = JSON.parse(responseText);
    if (response.error) {
        throw new Error(`OpenAI embedding error: ${response.error.message || JSON.stringify(response.error)}`);
    }
    if (!response.data || !Array.isArray(response.data) || response.data.length === 0) {
        throw new Error("OpenAI response missing 'data' array or is empty");
    }
    if (!response.data[0].embedding || !Array.isArray(response.data[0].embedding)) {
        throw new Error("OpenAI response missing 'embedding' in first data element");
    }
    return response.data[0].embedding;
}

async function computeOllama(r, promptText, providerConfig) {
    const body = JSON.stringify({
        model: providerConfig.model,
        prompt: promptText
    });

    const reply = await r.subrequest(providerConfig.location, {
        method: 'POST',
        body: body
    });

    if (reply.status !== 200) {
        throw new Error(`Ollama embedding API returned status ${reply.status}: ${reply.responseText}`);
    }

    return parseOllamaResponse(reply.responseText);
}

async function computeOpenAI(r, promptText, providerConfig) {
    const payload = {
        model: providerConfig.model,
        input: promptText
    };
    // OpenAI's text-embedding-3 models support truncating output dimensions
    if (typeof providerConfig.dimensions === 'number') {
        payload.dimensions = providerConfig.dimensions;
    }
    const body = JSON.stringify(payload);

    const reply = await r.subrequest(providerConfig.location, {
        method: 'POST',
        body: body
    });

    if (reply.status !== 200) {
        throw new Error(`OpenAI embedding API returned status ${reply.status}: ${reply.responseText}`);
    }

    return parseOpenAIResponse(reply.responseText);
}

const PROVIDERS = {
    ollama: computeOllama,
    openai: computeOpenAI
};

async function compute(r, promptText, config) {
    const provider = config.embedding.provider;
    const providerConfig = config.embedding.providers[provider];

    if (!providerConfig) {
        throw new Error(`Unknown embedding provider: '${provider}'`);
    }

    const computeFn = PROVIDERS[provider];
    if (!computeFn) {
        throw new Error(`Embedding provider '${provider}' not implemented`);
    }

    return await computeFn(r, promptText, providerConfig);
}

export default { compute, parseOllamaResponse, parseOpenAIResponse };
