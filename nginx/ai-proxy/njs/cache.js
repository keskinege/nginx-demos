import embeddings from 'embeddings.js';

const DICT_NAME = 'ai_cache';

function dict() {
    return ngx.shared[DICT_NAME];
}

function readJSON(key) {
    const raw = dict().get(key);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
}

function writeJSON(key, value) {
    dict().set(key, JSON.stringify(value));
}

function readEntries(model) {
    const raw = dict().get(`${model}:entries`);
    if (!raw) return [];
    try { return JSON.parse(raw); } catch (e) { return []; }
}

function writeEntries(model, arr) {
    dict().set(`${model}:entries`, JSON.stringify(arr));
}

// Monotonic per-model index allocator. Never decremented, so entry indices
// are unique for the lifetime of the cache (fixes reuse of `count` as an
// allocator, which collided with live entries once eviction started).
function readSeq(model) {
    const raw = dict().get(`${model}:seq`);
    return raw ? parseInt(raw, 10) : 0;
}

function writeSeq(model, n) {
    dict().set(`${model}:seq`, String(n));
}

function entryKey(model, index) {
    return `${model}:entry:${index}`;
}

function extractPrompt(requestBody) {
    if (!requestBody.messages || !Array.isArray(requestBody.messages)) return '';
    const userContents = [];
    for (let i = 0; i < requestBody.messages.length; i++) {
        if (requestBody.messages[i].role === 'user') {
            const content = requestBody.messages[i].content;
            if (typeof content === 'string') {
                userContents.push(content);
            }
        }
    }
    return userContents.join(' ');
}

function cosineSimilarity(a, b) {
    let dot = 0, normA = 0, normB = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function normalize(text) {
    return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function ngrams(text, n) {
    const grams = {};
    for (let i = 0; i <= text.length - n; i++) {
        grams[text.slice(i, i + n)] = true;
    }
    return grams;
}

function objectKeys(obj) {
    const keys = [];
    for (const k in obj) {
        if (obj.hasOwnProperty ? obj.hasOwnProperty(k) : Object.prototype.hasOwnProperty.call(obj, k)) {
            keys.push(k);
        }
    }
    return keys;
}

function objectSize(obj) {
    return objectKeys(obj).length;
}

function jaccardSimilarity(a, b) {
    const gramsA = ngrams(a, 3);
    const gramsB = ngrams(b, 3);
    const sizeB = objectSize(gramsB);
    if (sizeB === 0) return 0;
    const keysA = objectKeys(gramsA);
    let intersection = 0;
    for (let i = 0; i < keysA.length; i++) {
        if (gramsB[keysA[i]]) intersection++;
    }
    const union = keysA.length + sizeB - intersection;
    return union === 0 ? 0 : intersection / union;
}

function isExpired(entry, now) {
    return (now - entry.created_at) > entry.ttl_ms;
}

function lruPin(model, index) {
    const entries = readEntries(model);
    const pos = entries.indexOf(index);
    if (pos === -1) {
        entries.unshift(index);
    } else if (pos !== 0) {
        entries.splice(pos, 1);
        entries.unshift(index);
    }
    writeEntries(model, entries);
}

// Looks up a semantically similar cached response for the request prompt.
//
// Returns a result object (never throws for expected failure modes):
//   {
//     response:        string | null,  // cached response body on HIT, null on MISS
//     promptText:      string,         // extracted prompt (reusable by store())
//     embedding:       number[] | null,// computed embedding (reusable by store())
//     embeddingFailed: boolean         // true if the embedding API was unreachable
//   }
//
// Semantic (cosine) matches are always preferred over text (Jaccard) matches;
// text similarity is only a fallback for entries/requests without embeddings.
async function lookup(requestBody, model, config, r) {
    const result = { response: null, promptText: '', embedding: null, embeddingFailed: false };

    const promptText = extractPrompt(requestBody);
    if (!promptText) return result;
    result.promptText = promptText;

    const threshold = config.similarity_threshold || 0.95;
    const textThreshold = config.text_similarity_threshold || 0.85;
    const now = Date.now();
    const entries = readEntries(model);

    let promptEmbedding = null;
    try {
        promptEmbedding = await embeddings.compute(r, promptText, config);
        result.embedding = promptEmbedding;
    } catch (e) {
        r.log(`Semantic cache: embedding compute failed (${e.message}), falling back to text similarity`);
        result.embeddingFailed = true;
    }

    const normPrompt = normalize(promptText);

    let bestSemantic = null, bestSemanticScore = -1, bestSemanticIdx = -1;
    let bestText = null, bestTextScore = -1, bestTextIdx = -1;
    const expiredIdx = [];

    for (let i = 0; i < entries.length; i++) {
        const idx = entries[i];
        const entry = readJSON(entryKey(model, idx));
        if (!entry) continue;
        if (isExpired(entry, now)) {
            expiredIdx.push(idx);
            continue;
        }

        if (promptEmbedding && entry.embedding && entry.embedding.length > 0) {
            const score = cosineSimilarity(promptEmbedding, entry.embedding);
            if (score >= threshold && score > bestSemanticScore) {
                bestSemantic = entry;
                bestSemanticScore = score;
                bestSemanticIdx = idx;
            }
        } else if (entry.prompt_text) {
            const score = jaccardSimilarity(normPrompt, normalize(entry.prompt_text));
            if (score >= textThreshold && score > bestTextScore) {
                bestText = entry;
                bestTextScore = score;
                bestTextIdx = idx;
            }
        }
    }

    // Lazily prune expired entries encountered during the scan (best effort)
    if (expiredIdx.length > 0) {
        try {
            const remaining = entries.filter(idx => expiredIdx.indexOf(idx) === -1);
            writeEntries(model, remaining);
            for (let i = 0; i < expiredIdx.length; i++) {
                dict().delete(entryKey(model, expiredIdx[i]));
            }
            r.log(`Semantic cache: lazily pruned ${expiredIdx.length} expired entries for model '${model}'`);
        } catch (e) {
            r.log(`Semantic cache: lazy prune failed for model '${model}' (${e.message})`);
        }
    }

    // Semantic matches always win over text-fallback matches
    let bestMatch = null, bestScore = -1, bestMatchIdx = -1, matchKind = null;
    if (bestSemantic) {
        bestMatch = bestSemantic;
        bestScore = bestSemanticScore;
        bestMatchIdx = bestSemanticIdx;
        matchKind = 'semantic';
    } else if (bestText) {
        bestMatch = bestText;
        bestScore = bestTextScore;
        bestMatchIdx = bestTextIdx;
        matchKind = 'text';
    }

    if (bestMatch) {
        bestMatch.hits = (bestMatch.hits || 0) + 1;
        bestMatch.created_at = now;
        // Best-effort bookkeeping: a full shared zone must not turn a HIT into a MISS
        try {
            writeJSON(entryKey(model, bestMatchIdx), bestMatch);
            lruPin(model, bestMatchIdx);
        } catch (e) {
            r.log(`Semantic cache: hit bookkeeping failed for model '${model}' (${e.message})`);
        }

        r.log(`Semantic cache: HIT for model '${model}', match=${matchKind}, score=${bestScore.toFixed(4)}, hits=${bestMatch.hits}`);
        result.response = bestMatch.response;
        return result;
    }

    r.log(`Semantic cache: MISS for model '${model}', entries scanned=${entries.length}`);
    return result;
}

// Stores an upstream response in the cache. `precomputed` is an optional
// result object from a prior lookup() call for the same request, so the
// embedding is computed at most once per request.
async function store(requestBody, model, response, config, r, precomputed) {
    const promptText = (precomputed && precomputed.promptText) ? precomputed.promptText : extractPrompt(requestBody);
    if (!promptText) return;

    const ttlMs = (config.ttl_seconds || 3600) * 1000;
    const maxEntries = config.max_entries || 1000;
    const now = Date.now();

    let promptEmbedding = (precomputed && precomputed.embedding) ? precomputed.embedding : null;
    if (!promptEmbedding) {
        try {
            promptEmbedding = await embeddings.compute(r, promptText, config);
        } catch (e) {
            r.log(`Semantic cache: embedding compute failed for store (${e.message}), storing without embedding`);
        }
    }

    const entry = {
        embedding: promptEmbedding || [],
        prompt_text: promptText,
        response: response,
        created_at: now,
        ttl_ms: ttlMs,
        hits: 0
    };

    // Best-effort writes: a full shared zone throws SharedMemoryError, which
    // must never affect the client response path.
    try {
        const idx = readSeq(model);
        writeJSON(entryKey(model, idx), entry);
        writeSeq(model, idx + 1);

        const entries = readEntries(model);
        entries.unshift(idx);

        // Evict LRU tail entries while over capacity
        while (entries.length > maxEntries) {
            const tail = entries.pop();
            dict().delete(entryKey(model, tail));
            r.log(`Semantic cache: LRU eviction for model '${model}', evicted entry ${tail}`);
        }

        writeEntries(model, entries);
        r.log(`Semantic cache: STORED for model '${model}', count=${entries.length}`);
    } catch (e) {
        r.log(`Semantic cache: store failed for model '${model}' (${e.message})`);
    }
}

function evictModelEntries(model) {
    const entries = readEntries(model);
    for (let i = 0; i < entries.length; i++) {
        dict().delete(entryKey(model, entries[i]));
    }
    dict().delete(`${model}:entries`);
    dict().delete(`${model}:seq`);
    return entries.length;
}

// Removes all expired entries for a model. Expired entries are also removed
// lazily during lookup(); this is the explicit/batch variant.
function pruneExpired(model, config) {
    const ttlMs = (config && config.ttl_seconds ? config.ttl_seconds : 3600) * 1000;
    const now = Date.now();
    let pruned = 0;

    const entries = readEntries(model);
    const valid = [];
    for (let i = 0; i < entries.length; i++) {
        const entry = readJSON(entryKey(model, entries[i]));
        if (entry && !isExpired(entry, now)) {
            valid.push(entries[i]);
        } else {
            dict().delete(entryKey(model, entries[i]));
            pruned++;
        }
    }
    writeEntries(model, valid);
    return pruned;
}

export default {
    lookup,
    store,
    evict: evictModelEntries,
    prune: pruneExpired,
    extractPrompt,
    cosineSimilarity,
    normalize,
    ngrams,
    jaccardSimilarity,
    isExpired,
    DICT_NAME
};
