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

function assertClose(actual, expected, epsilon, msg) {
    if (Math.abs(actual - expected) <= epsilon) {
        passed++;
    } else {
        failed++;
        console.error(`FAIL: ${msg} — expected ~${expected}, got ${actual}`);
    }
}

// ── extractPrompt ──

assertEq(cache.extractPrompt({messages: []}), '',
    "extractPrompt: empty messages → empty string");

assertEq(cache.extractPrompt({messages: [
    {role: "user", content: "Hello"}
]}), "Hello",
    "extractPrompt: single user message");

assertEq(cache.extractPrompt({messages: [
    {role: "system", content: "You are helpful"},
    {role: "user", content: "Hello"},
    {role: "assistant", content: "Hi there"},
    {role: "user", content: "What is the weather?"}
]}), "Hello What is the weather?",
    "extractPrompt: multiple roles, only user messages joined");

assertEq(cache.extractPrompt({messages: [
    {role: "assistant", content: "No user here"}
]}), '',
    "extractPrompt: no user messages");

assertEq(cache.extractPrompt({messages: [
    {role: "user", content: ""}
]}), '',
    "extractPrompt: user with empty content");

assertEq(cache.extractPrompt({}), '',
    "extractPrompt: no messages key");

// ── cosineSimilarity ──

assertClose(cache.cosineSimilarity([1, 0, 0], [1, 0, 0]), 1.0, 0.001,
    "cosine: identical vectors = 1.0");
assertClose(cache.cosineSimilarity([1, 0, 0], [0, 1, 0]), 0.0, 0.001,
    "cosine: orthogonal vectors = 0.0");
assertClose(cache.cosineSimilarity([1, 1], [-1, -1]), -1.0, 0.001,
    "cosine: opposite vectors = -1.0");
assertClose(cache.cosineSimilarity([1, 2, 3], [1, 2, 3]), 1.0, 0.001,
    "cosine: same 3d vector = 1.0");
assertClose(cache.cosineSimilarity([], []), 0.0, 0.001,
    "cosine: empty vectors = 0.0");
assertClose(cache.cosineSimilarity([1, 2], [3, 4]), 0.98387, 0.001,
    "cosine: check approximate value");

// ── normalize ──

assertEq(cache.normalize("Hello, World!"), "hello world",
    "normalize: lowercase and strip punctuation");
assertEq(cache.normalize("  HeLLo   WoRLD  "), "hello world",
    "normalize: collapse whitespace and trim");
assertEq(cache.normalize("I'm here! Yes."), "im here yes",
    "normalize: various punctuation removed");
assertEq(cache.normalize("123 numbers stay"), "123 numbers stay",
    "normalize: numbers preserved");

// ── ngrams ──

const grams = cache.ngrams("abcde", 3);
assert(grams["abc"] === true, "ngrams: contains 'abc'");
assert(grams["bcd"] === true, "ngrams: contains 'bcd'");
assert(grams["cde"] === true, "ngrams: contains 'cde'");
let size = 0;
for (const k in grams) { size++; }
assertEq(size, 3, "ngrams: correct size for length 5 with n=3");
let smallSize = 0;
for (const k in cache.ngrams("ab", 3)) { smallSize++; }
assertEq(smallSize, 0,
    "ngrams: text shorter than n → empty set");

// ── jaccardSimilarity ──

assertClose(cache.jaccardSimilarity("hello world", "hello world"), 1.0, 0.001,
    "jaccard: identical strings = 1.0");
const jacScore = cache.jaccardSimilarity("hello world", "hello earth");
assert(jacScore > 0.1 && jacScore < 0.9,
    "jaccard: partially similar strings in expected range");
assertEq(cache.jaccardSimilarity("abc", "xyz"), 0.0,
    "jaccard: completely different = 0.0");

// ── isExpired ──

const now = 1000000;
assert(!cache.isExpired({created_at: 999000, ttl_ms: 2000}, now),
    "isExpired: entry within TTL → not expired");
assert(cache.isExpired({created_at: 998000, ttl_ms: 1000}, now),
    "isExpired: entry past TTL → expired");
assert(!cache.isExpired({created_at: 1000000, ttl_ms: 1}, now),
    "isExpired: entry at same ms with ttl=1 → not expired");

// ── DICT_NAME ──

assertEq(cache.DICT_NAME, 'ai_cache',
    "DICT_NAME: matches shared dict zone name");

// ── Summary ──

console.log(`\ncache.js tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
    throw new Error(`${failed} test(s) failed`);
}
