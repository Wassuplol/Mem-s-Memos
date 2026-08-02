/**
 * Mock OpenAI-compatible server: programmable chat + embedding behavior,
 * request recording, and deterministic vectors (content-hash seeded).
 */

import { fnv1a, parseJsonLoose } from '../src/utils/helpers.js';

export class MockOpenAI {
    constructor({ dim = 8, failureRate = 0 } = {}) {
        this.dim = dim;
        this.failureRate = failureRate;
        this.chatCalls = [];
        this.embedCalls = [];
        this.chatResponder = null; // (messages) => string
    }

    /** Deterministic pseudo-embedding: same text → same vector, dim dims. */
    vectorFor(text) {
        const v = [];
        let h = parseInt(fnv1a(String(text)), 16);
        for (let i = 0; i < this.dim; i++) {
            h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
            v.push(((h % 2000) - 1000) / 1000);
        }
        // L2 normalize
        const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
        return v.map((x) => x / n);
    }

    makeFetch() {
        return async (url, init) => {
            const body = init?.body ? JSON.parse(init.body) : {};
            if (Math.random() < this.failureRate) {
                return jsonResponse(500, { error: { message: 'mock server exploded' } });
            }
            if (String(url).includes('/embeddings')) {
                this.embedCalls.push(body);
                const inputs = Array.isArray(body.input) ? body.input : [body.input];
                return jsonResponse(200, {
                    object: 'list',
                    data: inputs.map((t, i) => ({ object: 'embedding', index: i, embedding: this.vectorFor(t) })),
                    model: body.model || 'mock-embed',
                });
            }
            if (String(url).includes('/chat/completions')) {
                this.chatCalls.push(body);
                const content = this.chatResponder
                    ? this.chatResponder(body.messages, body)
                    : defaultResponder(body.messages);
                return jsonResponse(200, {
                    id: 'chatcmpl-mock',
                    object: 'chat.completion',
                    model: body.model || 'mock-chat',
                    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
                    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
                });
            }
            if (String(url).includes('/rerank')) {
                const docs = body.documents || [];
                return jsonResponse(200, {
                    results: docs.map((_, i) => ({ index: i, relevance_score: 1 - i / Math.max(1, docs.length) })),
                });
            }
            return jsonResponse(404, { error: { message: 'unknown mock endpoint' } });
        };
    }
}

function defaultResponder(messages) {
    const user = messages?.[messages.length - 1]?.content || '';
    if (/Reply with the single word/i.test(messages?.[0]?.content || '')) return 'OK';
    if (/STRICT JSON/i.test(messages?.[0]?.content || '') && /queries/.test(user)) {
        return JSON.stringify({ queries: ['alt phrasing one', 'alt phrasing two'] });
    }
    if (/extraction engine/i.test(messages?.[0]?.content || '')) {
        return JSON.stringify({
            window_summary: 'The user and the character discussed the old lighthouse.',
            events: [{
                event_type: 'revelation', importance: 0.8,
                text: 'Mira revealed she hid the brass key inside the lighthouse.',
                datetime: '', cause: 'The user asked about the missing key.',
                result: 'The user now knows where the key is.',
                characters: ['Mira'], locations: ['lighthouse'], items: ['brass key'],
                concepts: ['secret', 'key'], emotion: 'nervous', valence: -0.2, arousal: 0.4,
                knowers: ['user', 'Mira'], secret_from: ['Captain'], confidence: 0.9,
            }],
            facts: [{ subject: 'brass key', predicate: 'hidden in', object: 'lighthouse', confidence: 0.9, valid_when: '' }],
            goals: [{ owner: 'user', goal: 'Recover the brass key', status: 'active', importance: 0.7 }],
            promises: [{ speaker: 'Mira', listener: 'user', promise: 'She will show the hiding spot at dawn', status: 'pending' }],
            emotions: [{ subject: 'Mira', emotion: 'nervous', valence: -0.2, arousal: 0.4 }],
            knowledge: [{ knower: 'user', claim: 'The brass key is inside the lighthouse', stance: 'knows', confidence: 0.9 }],
            state_updates: [{ entity: 'lighthouse', entity_type: 'place', field: 'hazards', value: 'crumbling stairs', confidence: 0.8 }],
            world: { scene: 'lighthouse cliff', time_of_day: 'dusk', weather: 'salt wind', mood: 'tense', active_factions: [] },
            keywords: ['lighthouse', 'brass', 'key', 'hidden'],
        });
    }
    if (/Hypothetical memory/i.test(user) || /hypothetical memory/i.test(messages?.[0]?.content || '')) {
        return 'The character once learned that the brass key was hidden inside the old lighthouse by Mira at dusk.';
    }
    if (/rank memory passages/i.test(messages?.[0]?.content || '')) {
        const count = (user.match(/\[\d+\]/g) || []).length;
        return JSON.stringify({ ranking: Array.from({ length: count }, (_, i) => ({ i, score: 1 - i * 0.1 })) });
    }
    if (/Trim a memory/i.test(messages?.[0]?.content || '')) {
        return 'Mira hid the brass key inside the lighthouse.';
    }
    return 'OK';
}

export function jsonResponse(status, obj) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

/** Loose JSON parse re-export for tests. */
export { parseJsonLoose };
