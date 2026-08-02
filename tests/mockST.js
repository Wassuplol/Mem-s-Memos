/**
 * Mock SillyTavern: a minimal global `SillyTavern` with getContext() matching
 * the real surface the extension uses — enough to boot the full bureau in
 * Node and drive messages/generation through it.
 */

export function createMockST() {
    const listeners = new Map();
    const extensionSettings = {};
    const chat = [];
    const injected = { text: '', position: 1, depth: 1 };

    const event_types = {
        APP_INITIALIZED: 'app_initialized',
        APP_READY: 'app_ready',
        MESSAGE_SENT: 'message_sent',
        MESSAGE_RECEIVED: 'message_received',
        CHAT_CHANGED: 'chat_changed',
        GENERATION_STARTED: 'generation_started',
        GENERATION_ENDED: 'generation_ended',
    };

    const eventSource = {
        on(type, fn) {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type).add(fn);
            return this;
        },
        off(type, fn) {
            listeners.get(type)?.delete(fn);
            return this;
        },
        once(type, fn) {
            const wrap = (...args) => { this.off(type, wrap); fn(...args); };
            return this.on(type, wrap);
        },
        async emit(type, payload) {
            for (const fn of [...(listeners.get(type) ?? [])]) await fn(payload);
        },
    };

    const ctx = {
        extensionSettings,
        saveSettingsDebounced: () => { ctx._saved = (ctx._saved || 0) + 1; },
        chat,
        chatId: 'chat-001',
        characterId: 0,
        characters: [{ name: 'Mira', description: 'The lighthouse keeper.' }],
        name1: 'user',
        name2: 'Mira',
        groups: [],
        groupId: null,
        eventSource,
        event_types,
        setExtensionPrompt(key, text, position, depth, scan, role) {
            injected.key = key;
            injected.text = text;
            injected.position = position;
            injected.depth = depth;
        },
        getExtensionPrompt: () => ({ ...injected }),
        SlashCommandParser: null, // tests assert graceful absence
        SlashCommand: null,
        SlashCommandNamedArgument: null,
        ARGUMENT_TYPE: null,
    };

    globalThis.SillyTavern = {
        getContext: () => ctx,
        libs: {},
    };

    return {
        ctx,
        eventSource,
        injected,
        async sendUser(text) {
            chat.push({ is_user: true, name: 'user', mes: text });
            await eventSource.emit(event_types.MESSAGE_SENT, chat.length - 1);
        },
        async sendCharacter(text) {
            chat.push({ is_user: false, name: 'Mira', mes: text });
            await eventSource.emit(event_types.MESSAGE_RECEIVED, chat.length - 1);
        },
        async startGeneration() {
            await eventSource.emit(event_types.GENERATION_STARTED, {});
            // Mirror ST 1.18: registered generate_interceptor runs with the chat
            if (typeof globalThis.mmInterceptor === 'function') {
                await globalThis.mmInterceptor(chat, 2048, () => false, 'normal');
            }
        },
        async switchChat(newId) {
            ctx.chatId = newId;
            await eventSource.emit(event_types.CHAT_CHANGED, newId);
        },
        destroy() {
            delete globalThis.SillyTavern;
        },
    };
}
