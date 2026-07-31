// Dict-backed tests for cache.js lookup/store/LRU/TTL/fallback logic.
// Runs under the njs CLI with an in-memory mock of the NGX shared dictionary
// (`js_shared_dict_zone`) and a mock request object whose subrequest simulates
// the embedding API.

import cache from 'cache.js';

let passed = 0;
let failed = 0;

function assert(condition, msg) {
    if (condition) {
        passed++;
    } else {
        failed++;
        console.error(`FAIL: ${msg}`);
    }
}

function assertEq(actual, expected, msg) {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
        passed++;
    } else {
        failed++;
        console.error(`FAIL: ${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

// ── Test doubles ──

// In-memory stand-in for ngx.shared.ai_cache
function makeSharedDictMock() {
    const data = {};
    return {
        get: key => (key in data ? data[key] : undefined),
        set: (key, value) => { data[key] = String(value); },
        delete: key => { delete data[key]; },
        _data: data
    };
}

const dictMock = makeSharedDictMock();
globalThis.ngx = { shared: { ai_cache: dictMock } };

// Deterministic pseudo-embedding derived from prompt text: identical prompts
// score cosine 1.0, different prompts land below the 0.95 threshold (signed,
// position-sensitive components keep unrelated strings near-orthogonal)
function promptToVector(text) {
    const v = [0, 0, 0, 0];
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        v[code % 4] += (code % 2 === 0 ? 1 : -1) * code * (i + 1);
    }
    return v;
}

// Mock NJS request object. If `embeddingsDown` is true, the embedding
// subrequest rejects (simulating the embedding API being unreachable).
function makeRequestMock(embeddingsDown) {
    return {
        subrequestCalls: 0,
        log: function () {},
        subrequest: function (location, options) {
            this.subrequestCalls++;
            if (embeddingsDown) {
                return Promise.reject(new Error("embedding API unreachable"));
            }
            const req = JSON.parse(options.body);
            const vector = promptToVector(req.prompt || "");
            return Promise.resolve({
                status: 200,
                responseText: JSON.stringify({ embedding: vector })
            });
        }
    };
}

const CONFIG = {
    enabled: true,
    similarity_threshold: 0.95,
    text_similarity_threshold: 0.85,
    ttl_seconds: 3600,
    max_entries: 3,
    embedding: {
        provider: "ollama",
        providers: {
            ollama: { model: "nomic-embed-text", location: "/ollama-embedding", dimensions: 768 }
        }
    }
};

function body(prompt) {
    return { model: "gpt-5", messages: [{ role: "user", content: prompt }] };
}

function storedEntries(model) {
    const raw = dictMock._data[`${model}:entries`];
    return raw ? JSON.parse(raw) : [];
}

// ── Tests ──

async function main() {

    // T1: store → lookup HIT via embeddings
    const r1 = makeRequestMock(false);
    await cache.store(body("Hello world"), "t1", JSON.stringify({ id: "R1" }), CONFIG, r1);
    const hit1 = await cache.lookup(body("Hello world"), "t1", CONFIG, r1);
    assertEq(hit1.response, JSON.stringify({ id: "R1" }),
        "T1: stored response is returned on lookup HIT");
    assert(hit1.embedding !== null && hit1.embedding.length === 4,
        "T1: lookup result carries the computed embedding for reuse");
    assertEq(hit1.embeddingFailed, false, "T1: embeddingFailed flag is false");

    // T2: embedding is computed at most once per request (lookup → store reuse)
    const r2 = makeRequestMock(false);
    const miss2 = await cache.lookup(body("brand new prompt"), "t2", CONFIG, r2);
    assertEq(miss2.response, null, "T2: empty cache → MISS (response null)");
    assertEq(r2.subrequestCalls, 1, "T2: MISS lookup computed the embedding once");
    await cache.store(body("brand new prompt"), "t2", JSON.stringify({ id: "R2" }), CONFIG, r2, miss2);
    assertEq(r2.subrequestCalls, 1,
        "T2: store() reuses the lookup embedding — no second subrequest");

    // T3: LRU eviction regression — cache must keep working past max_entries
    // (previous allocator reused `count` as entry index and permanently
    // emptied the cache after ~max_entries+3 stores)
    const r3 = makeRequestMock(false);
    for (let i = 0; i < 20; i++) {
        await cache.store(body(`prompt number ${i}`), "t3", JSON.stringify({ id: `resp-${i}` }), CONFIG, r3);
    }
    assertEq(storedEntries("t3").length, 3,
        "T3: entries stay capped at max_entries after 20 stores");
    const hit3 = await cache.lookup(body("prompt number 19"), "t3", CONFIG, r3);
    assertEq(hit3.response, JSON.stringify({ id: "resp-19" }),
        "T3: newest entry still retrievable after heavy eviction churn");
    // Eviction is verified against the dict itself: the oldest entry indices
    // must be gone and the LRU index must hold exactly the 3 newest
    assertEq(storedEntries("t3"), [19, 18, 17],
        "T3: LRU index holds exactly the 3 newest entry indices");
    assertEq(dictMock._data["t3:entry:0"], undefined,
        "T3: oldest entry blob was deleted from the dict");
    const evicted3 = await cache.lookup(body("a completely unrelated question about zigzags"), "t3", CONFIG, r3);
    assertEq(evicted3.response, null, "T3: unrelated prompt MISSes the trimmed cache");

    // T4: expired entries are skipped AND lazily deleted on lookup
    const r4 = makeRequestMock(false);
    await cache.store(body("expiring prompt"), "t4", JSON.stringify({ id: "R4" }), CONFIG, r4);
    const entryKey = "t4:entry:0";
    const entry = JSON.parse(dictMock._data[entryKey]);
    entry.created_at = 0; // backdate far beyond ttl_seconds
    dictMock._data[entryKey] = JSON.stringify(entry);
    const miss4 = await cache.lookup(body("expiring prompt"), "t4", CONFIG, r4);
    assertEq(miss4.response, null, "T4: expired entry is not served");
    assertEq(dictMock._data[entryKey], undefined,
        "T4: expired entry is lazily deleted from the dict");
    assertEq(storedEntries("t4").length, 0,
        "T4: expired entry removed from the LRU index");

    // T5: text fallback when the embedding API is down
    const r5 = makeRequestMock(true);
    await cache.store(body("what is the meaning of life"), "t5", JSON.stringify({ id: "R5" }), CONFIG, r5);
    const hit5 = await cache.lookup(body("what is the meaning of life"), "t5", CONFIG, r5);
    assertEq(hit5.embeddingFailed, true, "T5: embeddingFailed flag set when API is down");
    assertEq(hit5.response, JSON.stringify({ id: "R5" }),
        "T5: identical prompt HITs via Jaccard text fallback (score 1.0)");

    // T6: semantic match is preferred over a text-only match
    const r6down = makeRequestMock(true);
    const r6 = makeRequestMock(false);
    // Same prompt stored twice: once during an embedding outage (text-only
    // entry), once with a real embedding
    await cache.store(body("shared prompt"), "t6", JSON.stringify({ id: "text-only-entry" }), CONFIG, r6down);
    await cache.store(body("shared prompt"), "t6", JSON.stringify({ id: "semantic-entry" }), CONFIG, r6);
    const hit6 = await cache.lookup(body("shared prompt"), "t6", CONFIG, r6);
    assertEq(hit6.response, JSON.stringify({ id: "semantic-entry" }),
        "T6: semantic match wins over an equally-scoring text match");

    // T7: HIT survives bookkeeping write failure (full shared zone)
    const r7 = makeRequestMock(false);
    await cache.store(body("resilient hit"), "t7", JSON.stringify({ id: "R7" }), CONFIG, r7);
    const origSet = dictMock.set;
    dictMock.set = () => { throw new Error("SharedMemoryError: zone is full"); };
    const hit7 = await cache.lookup(body("resilient hit"), "t7", CONFIG, r7);
    assertEq(hit7.response, JSON.stringify({ id: "R7" }),
        "T7: HIT is still served when hit-bookkeeping writes fail");
    // ...and store() must not throw either
    let storeThrew = false;
    try {
        await cache.store(body("another"), "t7", JSON.stringify({ id: "R7b" }), CONFIG, r7);
    } catch (e) {
        storeThrew = true;
    }
    dictMock.set = origSet;
    assertEq(storeThrew, false, "T7: store() is best-effort when the zone is full");

    // T8: prune() removes expired entries and keeps the index consistent
    const r8 = makeRequestMock(false);
    await cache.store(body("prune me"), "t8", JSON.stringify({ id: "R8a" }), CONFIG, r8);
    await cache.store(body("keep me"), "t8", JSON.stringify({ id: "R8b" }), CONFIG, r8);
    const pruneKey = "t8:entry:0";
    const pruneEntry = JSON.parse(dictMock._data[pruneKey]);
    pruneEntry.created_at = 0;
    dictMock._data[pruneKey] = JSON.stringify(pruneEntry);
    const pruned = cache.prune("t8", CONFIG);
    assertEq(pruned, 1, "T8: prune() reports one expired entry removed");
    assertEq(storedEntries("t8").length, 1, "T8: index length matches survivors");
    const hit8 = await cache.lookup(body("keep me"), "t8", CONFIG, r8);
    assertEq(hit8.response, JSON.stringify({ id: "R8b" }),
        "T8: surviving entry still retrievable after prune");
}

main().then(() => {
    console.log(`\ncache_dict_test.js: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        console.error(`FAIL: ${failed} dict-backed test(s) failed`);
    }
});
