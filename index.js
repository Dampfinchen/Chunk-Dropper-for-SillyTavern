const extensionName = "chunk-dropper-for-sillytavern";
const extensionFolderPath = import.meta.url.substring(0, import.meta.url.lastIndexOf('/'));

const defaultSettings = {
    enabled: true,
    autoThreshold: true,
    thresholdTokens: 7000,
    dropPercentage: 40,
    preservePairs: true,
    compactionEnabled: false,
    currentStartIndex: 0,
    anchorMessageId: null,
    currentSummary: "", 
    lastChatId: null
};

let settings = Object.assign({}, defaultSettings);
let isCompacting = false; 

// --- DYNAMIC MODULE LOADER ---
let ST_eventSource;
let ST_event_types;
let ST_generateRaw;
let ST_setExtensionPrompt;

async function initializeSTModules() {
    const paths =[
        '/script.js',
        '../../../../script.js',
        '../../../script.js'
    ];
    for (const path of paths) {
        try {
            const mod = await import(path);
            if (mod.eventSource && mod.event_types) {
                ST_eventSource = mod.eventSource;
                ST_event_types = mod.event_types;
                ST_generateRaw = mod.generateRaw;
                ST_setExtensionPrompt = mod.setExtensionPrompt;
                console.log(`[Chunk Dropper] Successfully hooked into SillyTavern core via ${path}`);
                return true;
            }
        } catch (e) {
            // Ignore and try next path
        }
    }
    console.error("[Chunk Dropper] CRITICAL: Failed to load SillyTavern core modules.");
    return false;
}
// -----------------------------

function getSTContext() {
    if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) return SillyTavern.getContext();
    if (typeof getContext === 'function') return getContext();
    return {};
}

/**
 * Officially registers the summary with SillyTavern's Prompt Builder
 */
function updateSummaryInjection() {
    if (typeof ST_setExtensionPrompt === 'function') {
        const text = (settings.compactionEnabled && settings.currentSummary) 
            ? `[Prior Events Summary: ${settings.currentSummary}]` 
            : '';
        
        // (name, text, position: 0=After Main Prompt, depth: 0, scan: false, role: 0=System)
        ST_setExtensionPrompt(extensionName, text, 0, 0, false, 0);
    }
}

async function loadSettings() {
    const context = getSTContext();
    let extSettings = context.extensionSettings || context.extension_settings;
    if (!extSettings && typeof extension_settings !== 'undefined') extSettings = extension_settings;
    if (!extSettings) return;

    if (extSettings[extensionName]) {
        Object.assign(settings, extSettings[extensionName]);
    } else {
        extSettings[extensionName] = settings;
    }
    updateSummaryInjection();
}

function saveSettings() {
    const context = getSTContext();
    let extSettings = context.extensionSettings || context.extension_settings;
    if (!extSettings && typeof extension_settings !== 'undefined') extSettings = extension_settings;
    if (extSettings) extSettings[extensionName] = settings;

    if (typeof context.saveSettingsDebounced === 'function') context.saveSettingsDebounced();
    else if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();
    else if (typeof context.saveSettings === 'function') context.saveSettings();
    
    updateUI();
}

function getActiveThreshold() {
    if (!settings.autoThreshold) return settings.thresholdTokens;

    const context = getSTContext();
    const mainApi = $('#main_api').val() || context.settings?.main_api || 'textgenerationwebui';

    let maxContext = 8192;
    let maxLength = 800;

    const apiPrefixes = {
        'openai': 'openai',
        'claude': 'claude',
        'maker': 'maker',
        'mistral': 'mistral',
        'cohere': 'cohere',
        'scale': 'scale'
    };

    if (apiPrefixes[mainApi]) {
        const prefix = apiPrefixes[mainApi];
        maxContext = $(`#${prefix}_max_context`).val() || context.settings?.[`${prefix}_settings`]?.max_context;
        maxLength = $(`#${prefix}_max_tokens`).val() || context.settings?.[`${prefix}_settings`]?.max_tokens;
    } else {
        maxContext = $('#max_context').val() || context.settings?.max_context;
        maxLength = $('#amount_gen').val() || context.settings?.amount_gen;
    }

    maxContext = parseInt(maxContext) || 8192;
    maxLength = parseInt(maxLength) || 800;

    const calculated = maxContext - maxLength - 400;
    return Math.max(1000, calculated);
}

function updateUI() {
    $('#rnn_cd_enabled').prop('checked', settings.enabled);
    $('#rnn_cd_auto_threshold').prop('checked', settings.autoThreshold);
    $('#rnn_cd_compaction').prop('checked', settings.compactionEnabled);
    $('#rnn_cd_threshold').val(settings.thresholdTokens);
    $('#rnn_cd_threshold_val').text(settings.thresholdTokens);
    $('#rnn_cd_percentage').val(settings.dropPercentage);
    $('#rnn_cd_percentage_val').text(settings.dropPercentage);
    $('#rnn_cd_preserve_pairs').prop('checked', settings.preservePairs);
    $('#rnn_cd_dropped_count').text(settings.currentStartIndex);
    $('#rnn_cd_active_calc').text(getActiveThreshold());

    if (settings.autoThreshold) {
        $('#rnn_cd_manual_threshold_container').hide();
    } else {
        $('#rnn_cd_manual_threshold_container').show();
    }
}

async function getTokenCount(text) {
    const context = getSTContext();
    if (typeof context.getTokenCount === 'function') return await Promise.resolve(context.getTokenCount(text));
    return Math.ceil(text.length / 3.5);
}

async function summarizeText(textToSummarize) {
    let systemInstructions = "Write a concise summary of the following narrative events. Focus on important plot points, character states, and decisions. Do not include dialogue, just the facts.";
    if (settings.currentSummary) {
        systemInstructions += `\n\n[PREVIOUS SUMMARY]\n${settings.currentSummary}\n\nCombine the previous summary and the new events into a single, updated, concise summary.`;
    }

    try {
        if (typeof ST_generateRaw === 'function') {
            const result = await ST_generateRaw({ prompt: textToSummarize, systemPrompt: systemInstructions });
            return result ? result.trim() : "";
        } else {
            console.warn("[Chunk Dropper] ST_generateRaw is missing. Cannot summarize.");
        }
        return "";
    } catch (e) {
        console.error("[Chunk Dropper] Summarization failed:", e);
        return "";
    }
}

/**
 * HELPER: Safely finds the actual start index based on the anchor ID
 */
function getActualStartIndex(chatArray) {
    let actualStartIndex = settings.currentStartIndex; 
    if (settings.anchorMessageId) {
        const foundIndex = chatArray.findIndex(m => 
            (m._id && m._id === settings.anchorMessageId) || 
            (m.send_date && m.send_date === settings.anchorMessageId) || 
            (m.mes && m.mes === settings.anchorMessageId)
        );
        if (foundIndex !== -1) actualStartIndex = foundIndex;
    }
    return Math.min(Math.max(0, actualStartIndex), chatArray.length > 0 ? chatArray.length - 1 : 0);
}

/**
 * HELPER: Performs the math to drop the chunk and returns the dropped messages
 */
async function performDrop(chatArray, activeThreshold) {
    let actualStartIndex = getActualStartIndex(chatArray);
    let activeChat = chatArray.slice(actualStartIndex);
    
    const targetTokensToDrop = activeThreshold * (settings.dropPercentage / 100);
    let droppedTokens = 0;
    let dropIndex = 0;

    for (let i = 0; i < activeChat.length; i++) {
        const msgText = (activeChat[i].name ? activeChat[i].name + ': ' : '') + activeChat[i].mes;
        droppedTokens += await getTokenCount(msgText);
        dropIndex = i + 1;
        if (droppedTokens >= targetTokensToDrop) break;
    }

    let newStartIndex = actualStartIndex + dropIndex;

    if (settings.preservePairs) {
        while (newStartIndex < chatArray.length) {
            const msg = chatArray[newStartIndex];
            if (msg.is_user && !msg.is_system && !msg.extra?.type) break;
            newStartIndex++;
        }
    }

    newStartIndex = Math.min(newStartIndex, Math.max(0, chatArray.length - 1));
    
    const droppedMessages = chatArray.slice(actualStartIndex, newStartIndex);
    
    settings.currentStartIndex = newStartIndex;
    const anchorMsg = chatArray[newStartIndex];
    if (anchorMsg) settings.anchorMessageId = anchorMsg._id || anchorMsg.send_date || anchorMsg.mes;
    
    return droppedMessages;
}

/**
 * BACKGROUND TASK: Runs quietly after the AI finishes generating its reply.
 */
async function backgroundDropCheck() {
    if (!settings.enabled || isCompacting) return;
    
    const context = getSTContext();
    if (!context.chat || !context.chat.length) return;

    let actualStartIndex = getActualStartIndex(context.chat);
    let activeChat = context.chat.slice(actualStartIndex);
    let activeText = activeChat.map(m => (m.name ? m.name + ': ' : '') + m.mes).join('\n');
    let tokenCount = await getTokenCount(activeText);
    let activeThreshold = getActiveThreshold();

    if (tokenCount >= activeThreshold) {
        isCompacting = true; 
        try {
            const droppedMessages = await performDrop(context.chat, activeThreshold);
            
            if (settings.compactionEnabled) {
                toastr.info("Compacting memory in background...", "Chunk Dropper", {timeOut: 5000});
                const textToSummarize = droppedMessages.map(m => `${m.name}: ${m.mes}`).join('\n\n');
                
                const newSummary = await summarizeText(textToSummarize);
                if (newSummary) {
                    settings.currentSummary = newSummary;
                    updateSummaryInjection();
                    toastr.success("Memory compacted successfully!");
                }
            }

            console.log(`[Chunk Dropper] Background drop complete. Dropped ${droppedMessages.length} messages.`);
            saveSettings();
        } finally {
            isCompacting = false; 
        }
    }
}

/**
 * INTERCEPTOR: Runs instantly when you click Send.
 */
globalThis.rnnChunkDropperInterceptor = async function(chat) {
    if (!settings.enabled) return;

    if (isCompacting) {
        toastr.info("Please wait until context compaction is finished. Your message will be sent automatically afterwards.", "Chunk Dropper", {timeOut: 10000});
        while (isCompacting) { 
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    const context = getSTContext();
    const currentChatId = context.chatId;

    if (settings.lastChatId !== currentChatId) {
        settings.lastChatId = currentChatId;
        settings.currentStartIndex = 0;
        settings.anchorMessageId = null;
        settings.currentSummary = "";
        updateSummaryInjection();
        saveSettings();
    }

    let actualStartIndex = getActualStartIndex(chat);
    let activeChat = chat.slice(actualStartIndex);
    let activeText = activeChat.map(m => (m.name ? m.name + ': ' : '') + m.mes).join('\n');
    let tokenCount = await getTokenCount(activeText);
    let activeThreshold = getActiveThreshold();

    // EMERGENCY FALLBACK (If user pastes a massive message skipping the background check)
    if (tokenCount >= activeThreshold) {
        console.warn("[Chunk Dropper] Emergency drop triggered to prevent context overflow.");
        
        const droppedMessages = await performDrop(chat, activeThreshold);
        
        if (settings.compactionEnabled) {
            toastr.info("Emergency memory compaction. Please wait...", "Chunk Dropper", {timeOut: 10000});
            const textToSummarize = droppedMessages.map(m => `${m.name}: ${m.mes}`).join('\n\n');
            const newSummary = await summarizeText(textToSummarize);
            if (newSummary) {
                settings.currentSummary = newSummary;
                updateSummaryInjection();
            }
        }
        
        saveSettings();
        actualStartIndex = settings.currentStartIndex; // Update to the newly calculated index
    }

    // SLICE THE ARRAY (This is the ONLY thing the interceptor does to the chat array now!)
    if (actualStartIndex > 0) chat.splice(0, actualStartIndex);

    // FALLBACK INJECTION (Only if ST_setExtensionPrompt completely failed to load)
    if (typeof ST_setExtensionPrompt !== 'function' && settings.compactionEnabled && settings.currentSummary) {
        const summaryBlock = `\n\n[Prior Events Summary: ${settings.currentSummary}]`;
        chat.unshift({ name: 'System', is_user: false, is_system: true, mes: summaryBlock, extra: { type: 'rnn_compaction_summary' } });
    }
};

jQuery(async () => {
    try {
        await initializeSTModules();
        await loadSettings();
        
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        $('#extensions_settings').append(settingsHtml);

        const sliderSelectors =[
            '#main_api', '#api_button',
            '#max_context', '#amount_gen',
            '#openai_max_context', '#openai_max_tokens',
            '#claude_max_context', '#claude_max_tokens',
            '#maker_max_context', '#maker_max_tokens',
            '#mistral_max_context', '#mistral_max_tokens',
            '#cohere_max_context', '#cohere_max_tokens'
        ].join(', ');

        $(document).on('input change', sliderSelectors, function() {
            if (settings.autoThreshold) {
                setTimeout(updateUI, 150); 
            }
        });

        if (ST_eventSource && ST_event_types) {
            // ONLY listen to events that happen AFTER generation is fully complete
            ST_eventSource.on(ST_event_types.CHARACTER_MESSAGE_RENDERED, backgroundDropCheck);
            ST_eventSource.on(ST_event_types.MESSAGE_DELETED, backgroundDropCheck);
            ST_eventSource.on(ST_event_types.MESSAGE_SWIPED, backgroundDropCheck);
        }

        $('#rnn_cd_enabled').on('change', function() { settings.enabled = !!$(this).prop('checked'); saveSettings(); });
        $('#rnn_cd_auto_threshold').on('change', function() { settings.autoThreshold = !!$(this).prop('checked'); saveSettings(); updateUI(); });
        $('#rnn_cd_compaction').on('change', function() { settings.compactionEnabled = !!$(this).prop('checked'); updateSummaryInjection(); saveSettings(); });
        $('#rnn_cd_threshold').on('input', function() { settings.thresholdTokens = parseInt($(this).val()); $('#rnn_cd_threshold_val').text(settings.thresholdTokens); });
        $('#rnn_cd_threshold').on('change', () => saveSettings());
        $('#rnn_cd_percentage').on('input', function() { settings.dropPercentage = parseInt($(this).val()); $('#rnn_cd_percentage_val').text(settings.dropPercentage); });
        $('#rnn_cd_percentage').on('change', () => saveSettings());
        $('#rnn_cd_preserve_pairs').on('change', function() { settings.preservePairs = !!$(this).prop('checked'); saveSettings(); });
        
        $('#rnn_cd_reset').on('click', function() {
            settings.currentStartIndex = 0;
            settings.anchorMessageId = null;
            settings.currentSummary = "";
            updateSummaryInjection();
            saveSettings();
            toastr.success("State reset.");
        });

        updateUI();
    } catch (error) {
        console.error("[Chunk Dropper] UI failed to load.", error);
    }
});