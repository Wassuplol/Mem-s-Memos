/**
 * Test host — wraps the mockST context with the same host-adapter contract
 * index.js expects, WITHOUT touching the DOM (no launcher, no drawer).
 */

export function createHostForTest(ctx, deps = {}) {
    return {
        kind: 'test',
        ctx,
        _testDeps: deps,
        getSettings: () => ctx.extensionSettings['mems-memos'],
        setSettings: (v) => { ctx.extensionSettings['mems-memos'] = v; },
        saveSettings: () => ctx.saveSettingsDebounced(),
        inject: (text, { depth = 1 } = {}) => {
            ctx.setExtensionPrompt('mems-memos', text, 1, Math.max(0, depth), false, 0);
            return true;
        },
        clearInjection: () => ctx.setExtensionPrompt('mems-memos', '', 1, 1, false, 0),
        getScope: () => ({
            chatId: String(ctx.chatId),
            chatName: String(ctx.chatId),
            characterId: ctx.characters?.[ctx.characterId]?.name || null,
            characterName: ctx.characters?.[ctx.characterId]?.name || ctx.name2 || null,
            personaId: ctx.name1 || null,
            userId: ctx.name1 || null,
            date: 'test-date',
            isGroup: false,
        }),
        getRecentMessages: (n = 8) => (ctx.chat || []).slice(-n).map((m) => ({ name: m.name, text: m.mes, isUser: !!m.is_user })),
        getLastUserMessage: () => [...(ctx.chat || [])].reverse().find((m) => m.is_user)?.mes || '',
        messageText: (i) => ctx.chat?.[i]?.mes || '',
        messageInfo: (i) => {
            const m = ctx.chat?.[i];
            return m ? { name: m.name, isUser: !!m.is_user } : null;
        },
        on: (evt, fn) => {
            ctx.eventSource.on(ctx.event_types?.[evt] || evt, fn);
            return () => ctx.eventSource.off(ctx.event_types?.[evt] || evt, fn);
        },
        chatContainer: () => null,
        messageSelector: () => '.mes',
        messageIndexFor: () => -1,
        mountLauncher: () => ({ remove: () => {} }),
        drawerHost: () => null,
    };
}
