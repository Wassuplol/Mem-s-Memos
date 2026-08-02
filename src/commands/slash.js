/**
 * /mm — the bureau's slash interface. Registered through the host adapter's
 * SlashCommandParser when available (modern API), degrading to a no-op in
 * the dev mock (commands still callable via bureau.runCommand()).
 *
 * /mm on | off | shadow | status · recall <query>
 * /mm forget last | chat | character <name> | entity <name>
 * /mm export | import | wipe | sleep | consolidate
 * /mm world | knows <entity> | trace <id> | eval | reembed
 */

import { logger } from '../utils/logger.js';

export function registerSlashCommands(bureau, host) {
    const parser = host?.ctx?.SlashCommandParser;
    const SlashCommand = host?.ctx?.SlashCommand;
    const SlashCommandNamedArgument = host?.ctx?.SlashCommandNamedArgument;
    const ARGUMENT_TYPE = host?.ctx?.ARGUMENT_TYPE;

    const commands = buildCommands(bureau);

    if (parser && SlashCommand?.fromProps) {
        for (const cmd of commands) {
            try {
                parser.addCommandObject(SlashCommand.fromProps({
                    name: cmd.name,
                    callback: async (named, unnamed) => cmd.run(unnamed?.toString?.() ?? ''),
                    aliases: cmd.aliases || [],
                    returns: cmd.returns,
                    helpString: cmd.help,
                    unnamedArgumentList: cmd.arg
                        ? [SlashCommandNamedArgument.fromProps({
                            name: cmd.arg,
                            description: cmd.argDescription || cmd.arg,
                            typeList: [ARGUMENT_TYPE?.STRING ?? 'string'],
                            isRequired: !!cmd.argRequired,
                        })]
                        : [],
                }));
            } catch (err) {
                logger.warn(`slash registration failed for /mm ${cmd.name}`, { err: String(err?.message || err) });
            }
        }
        // /mm dispatcher (subcommands) — the friendly entry point
        try {
            parser.addCommandObject(SlashCommand.fromProps({
                name: 'mm',
                callback: async (named, unnamed) => dispatch(bureau, String(unnamed ?? '')),
                aliases: ['memos', 'mem'],
                returns: "Mem's Memos bureau command output",
                helpString: [
                    "Mem's Memos — the memory bureau.",
                    '  /mm on|off|shadow|status · /mm recall <query>',
                    '  /mm forget last|chat|character <name>|entity <name>',
                    '  /mm export|import|wipe|sleep|consolidate',
                    '  /mm world|knows <entity>|trace <id>|eval|reembed',
                ].join('\n'),
                unnamedArgumentList: cmd0arg(SlashCommandNamedArgument, ARGUMENT_TYPE),
            }));
        } catch (err) {
            logger.warn('slash registration failed for /mm', { err: String(err?.message || err) });
        }
    }

    return {
        dispatch: (input) => dispatch(bureau, input),
        commands,
    };
}

function cmd0arg(SlashCommandNamedArgument, ARGUMENT_TYPE) {
    try {
        return [SlashCommandNamedArgument.fromProps({
            name: 'subcommand',
            description: 'bureau subcommand + args',
            typeList: [ARGUMENT_TYPE?.STRING ?? 'string'],
            isRequired: false,
        })];
    } catch {
        return [];
    }
}

function buildCommands(bureau) {
    return [
        { name: 'mm_on', run: async () => bureau.setMode('on'), returns: 'mode', help: 'Activate full memory pipeline with injection.' },
        { name: 'mm_off', run: async () => bureau.setMode('off'), returns: 'mode', help: 'Disable the bureau entirely.' },
        { name: 'mm_shadow', run: async () => bureau.setMode('shadow'), returns: 'mode', help: 'Store everything, inject nothing (copyable blocks).' },
        { name: 'mm_status', run: async () => bureau.statusReport(), returns: 'status receipt', help: 'Bureau status: lanes, store, counts, degradation.' },
        {
            name: 'mm_recall', arg: 'query', argRequired: true,
            run: async (q) => bureau.manualRecall(q),
            returns: 'recalled memories', help: '/mm recall <query> — hybrid recall with pipeline receipt.',
        },
        {
            name: 'mm_forget', arg: 'target', argRequired: true,
            run: async (q) => bureau.forget(q),
            returns: 'forget receipt', help: '/mm forget last | chat | character <name> | entity <name>',
        },
        { name: 'mm_export', run: async () => bureau.exportData(), returns: 'export receipt', help: 'Export the archives as JSON.' },
        { name: 'mm_import', run: async () => 'Open the Ledger tab → IMPORT JSONL.', returns: 'hint', help: 'Import via the Ledger tab file picker.' },
        { name: 'mm_wipe', run: async () => bureau.wipeAll().then(() => 'Archives burned. The desk is clean.'), returns: 'wipe receipt', help: 'Wipe ALL bureau data (irreversible).' },
        { name: 'mm_sleep', run: async () => bureau.sleepReport(), aliases: ['mm_consolidate'], returns: 'sleep receipt', help: 'Run the consolidation sleep cycle now.' },
        { name: 'mm_world', run: async () => bureau.worldReport(), returns: 'world state', help: 'Show the active world-state snapshot.' },
        {
            name: 'mm_knows', arg: 'entity', argRequired: true,
            run: async (q) => bureau.knowsReport(q),
            returns: 'epistemic slice', help: '/mm knows <entity> — what they know and what is sealed from them.',
        },
        {
            name: 'mm_trace', arg: 'id', argRequired: true,
            run: async (q) => bureau.traceReport(q),
            returns: 'provenance receipt', help: '/mm trace <memory-id> — full provenance trail.',
        },
        { name: 'mm_eval', run: async () => bureau.runEval(), returns: 'eval receipt', help: 'Run the golden-QA eval harness (recall@k, MRR, contradiction rate).' },
        { name: 'mm_reembed', run: async () => bureau.reembed({ mode: 'in-place' }).then(() => 'Re-embed job started — watch the Ledger.'), returns: 'job receipt', help: 'Re-embed all memories with the configured model.' },
    ];
}

/** /mm <subcommand> dispatcher. */
export async function dispatch(bureau, input) {
    const parts = String(input || '').trim().split(/\s+/).filter(Boolean);
    const sub = (parts.shift() || 'status').toLowerCase();
    const rest = parts.join(' ');
    switch (sub) {
        case 'on': return bureau.setMode('on');
        case 'off': return bureau.setMode('off');
        case 'shadow': return bureau.setMode('shadow');
        case 'status': return bureau.statusReport();
        case 'recall': return bureau.manualRecall(rest);
        case 'forget': return bureau.forget(rest);
        case 'export': return bureau.exportData();
        case 'import': return 'Open the Ledger tab → IMPORT JSONL.';
        case 'wipe': return bureau.wipeAll().then(() => 'Archives burned. The desk is clean.');
        case 'sleep':
        case 'consolidate': return bureau.sleepReport();
        case 'world': return bureau.worldReport();
        case 'knows': return bureau.knowsReport(rest);
        case 'trace': return bureau.traceReport(rest);
        case 'eval': return bureau.runEval();
        case 'reembed': return bureau.reembed({ mode: 'in-place' }).then(() => 'Re-embed job started — watch the Ledger.');
        default: return `Unknown bureau command "${sub}". Try: on|off|shadow|status|recall|forget|export|import|wipe|sleep|world|knows|trace|eval|reembed`;
    }
}
