import embeddings from 'embeddings.js';

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

function assertThrows(fn, msg) {
    try {
        fn();
        failed++;
        console.error(`FAIL: ${msg} — expected throw, but no error`);
    } catch (e) {
        passed++;
    }
}

const ollamaValid = JSON.stringify({
    embedding: [0.1, 0.2, 0.3]
});
assertEq(embeddings.parseOllamaResponse(ollamaValid), [0.1, 0.2, 0.3],
    "Ollama: valid response returns embedding");

assertThrows(() => embeddings.parseOllamaResponse('{}'),
    "Ollama: missing embedding throws");

assertThrows(() => embeddings.parseOllamaResponse(JSON.stringify({embedding: "not-array"})),
    "Ollama: non-array embedding throws");

const openaiValid = JSON.stringify({
    object: "list",
    data: [{object: "embedding", embedding: [0.4, 0.5, 0.6], index: 0}],
    model: "text-embedding-3-small",
    usage: {prompt_tokens: 8, total_tokens: 8}
});
assertEq(embeddings.parseOpenAIResponse(openaiValid), [0.4, 0.5, 0.6],
    "OpenAI: valid response returns embedding");

assertThrows(() => embeddings.parseOpenAIResponse(JSON.stringify({error: {message: "bad key"}})),
    "OpenAI: error response throws");

assertThrows(() => embeddings.parseOpenAIResponse(JSON.stringify({data: []})),
    "OpenAI: empty data array throws");

assertThrows(() => embeddings.parseOpenAIResponse(JSON.stringify({data: [{embedding: "bad"}]})),
    "OpenAI: non-array embedding in data throws");

console.log(`\nembeddings.js tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
    throw new Error(`${failed} test(s) failed`);
}
