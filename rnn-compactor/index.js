const extensionName = "rnn-chunk-dropper";
const extensionFolderPath = import.meta.url.substring(0, import.meta.url.lastIndexOf('/'));

const defaultSettings = {
    enabled: false,
    autoThreshold: true,
    thresholdTokens: 7000,
    dropPercentage: 60,
    preservePairs: true,
    compactionEnabled: true,
    currentStartIndex: 0,
    anchorMessageId: null,
    currentSummary: "", 
    lastChatId: null
};

let settings = Object.assign({}, defaultSettings);

function getSTContext() {
    if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) return SillyTavern.getContext();
    if (typeof getContext === 'function') return getContext();
    return {};
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

/**
 * Robustly calculates the threshold by looking at SillyTavern's internal settings
 */
function getActiveThreshold() {
    if (settings.autoThreshold) {
        const context = getSTContext();
        
        // Target the actual slider values from the DOM or settings
        let maxContext = parseInt($('#max_context').val()) || context.settings?.max_context;
        let maxLength = parseInt($('#amount_gen').val()) || context.settings?.amount_gen;

        // Fallbacks
        maxContext = parseInt(maxContext) || 8192;
        maxLength = parseInt(maxLength) || 800;

        // Formula: Total Context - Response Room - Safety Buffer (400)
        const calculated = maxContext - maxLength - 400;
        
        return Math.max(1000, calculated); 
    }
    return settings.thresholdTokens;
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
    
    // Update the visual calculation
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
    let prompt = "Write a concise summary of the following narrative events. Focus on important plot points, character states, and decisions. Do not include dialogue, just the facts.\n\n";
    
    if (settings.currentSummary) {
        prompt += `[PREVIOUS SUMMARY]\n${settings.currentSummary}\n\n`;
        prompt += `[NEW EVENTS TO ADD]\n${textToSummarize}\n\n`;
        prompt += "Combine the previous summary and the new events into a single, updated, concise summary.";
    } else {
        prompt += `[EVENTS]\n${textToSummarize}\n\nSummary:`;
    }

    try {
        if (typeof generateRaw === 'function') {
            const result = await generateRaw(prompt, true);
            return result ? result.trim() : "";
        } else {
            console.warn("[RNN Chunk Dropper] generateRaw function not found.");
            return "";
        }
    } catch (e) {
        console.error("[RNN Chunk Dropper] Summarization failed:", e);
        return "";
    }
}

globalThis.rnnChunkDropperInterceptor = async function(chat) {
    if (!settings.enabled) return;

    const context = getSTContext();
    const currentChatId = context.chatId;

    if (settings.lastChatId !== currentChatId) {
        settings.lastChatId = currentChatId;
        settings.currentStartIndex = 0;
        settings.anchorMessageId = null;
        settings.currentSummary = "";
        if (context.extensionPrompts) delete context.extensionPrompts[extensionName];
        saveSettings();
    }

    let actualStartIndex = settings.currentStartIndex; 
    if (settings.anchorMessageId) {
        const foundIndex = chat.findIndex(m => 
            (m._id && m._id === settings.anchorMessageId) || 
            (m.send_date && m.send_date === settings.anchorMessageId) || 
            (m.mes && m.mes === settings.anchorMessageId)
        );
        if (foundIndex !== -1) actualStartIndex = foundIndex;
    }

    if (actualStartIndex >= chat.length) actualStartIndex = Math.max(0, chat.length - 1);

    let activeChat = chat.slice(actualStartIndex);
    let activeText = activeChat.map(m => (m.name ? m.name + ': ' : '') + m.mes).join('\n');
    let tokenCount = await getTokenCount(activeText);
    let activeThreshold = getActiveThreshold();

    if (tokenCount >= activeThreshold) {
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
            while (newStartIndex < chat.length) {
                const msg = chat[newStartIndex];
                if (msg.is_user && !msg.is_system && !msg.extra?.type) {
                    break;
                }
                newStartIndex++;
            }
        }

        if (newStartIndex >= chat.length) newStartIndex = Math.max(0, chat.length - 1);
        
        if (settings.compactionEnabled) {
            toastr.info("Context limit reached. Compacting memory...", "RNN Compactor", {timeOut: 5000});
            const droppedMessages = chat.slice(actualStartIndex, newStartIndex);
            const textToSummarize = droppedMessages.map(m => `${m.name}: ${m.mes}`).join('\n\n');
            
            const newSummary = await summarizeText(textToSummarize);
            if (newSummary) {
                settings.currentSummary = newSummary;
                toastr.success("Memory compacted successfully!");
            }
        }

        actualStartIndex = newStartIndex;
        settings.currentStartIndex = actualStartIndex;

        const anchorMsg = chat[actualStartIndex];
        if (anchorMsg) settings.anchorMessageId = anchorMsg._id || anchorMsg.send_date || anchorMsg.mes;

        console.log(`[RNN Chunk Dropper] Dropped ${dropIndex} messages. Locked onto new anchor.`);
        saveSettings();
    }

    if (actualStartIndex > 0) {
        chat.splice(0, actualStartIndex);
    }

    if (settings.compactionEnabled && settings.currentSummary) {
        const summaryBlock = `\n\n[Prior Events Summary: ${settings.currentSummary}]`;
        if (context.extensionPrompts) {
            context.extensionPrompts[extensionName] = summaryBlock;
        } else {
            chat.unshift({
                name: 'System', is_user: false, is_system: true,
                mes: summaryBlock, extra: { type: 'rnn_compaction_summary' }
            });
        }
    } else if (context.extensionPrompts) {
        delete context.extensionPrompts[extensionName];
    }
};

jQuery(async () => {
    try {
        await loadSettings();
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        $('#extensions_settings').append(settingsHtml);

        // --- NEW: LISTEN TO CORE SILLYTAVERN SLIDERS ---
        $(document).on('input change', '#max_context, #amount_gen', function() {
            if (settings.autoThreshold) {
                updateUI(); // Refresh the numbers in our menu instantly
            }
        });

        $('#rnn_cd_enabled').on('change', function() { settings.enabled = !!$(this).prop('checked'); saveSettings(); });
        $('#rnn_cd_auto_threshold').on('change', function() { settings.autoThreshold = !!$(this).prop('checked'); saveSettings(); updateUI(); });
        $('#rnn_cd_compaction').on('change', function() { settings.compactionEnabled = !!$(this).prop('checked'); saveSettings(); });
        $('#rnn_cd_threshold').on('input', function() { settings.thresholdTokens = parseInt($(this).val()); $('#rnn_cd_threshold_val').text(settings.thresholdTokens); });
        $('#rnn_cd_threshold').on('change', () => saveSettings());
        $('#rnn_cd_percentage').on('input', function() { settings.dropPercentage = parseInt($(this).val()); $('#rnn_cd_percentage_val').text(settings.dropPercentage); });
        $('#rnn_cd_percentage').on('change', () => saveSettings());
        $('#rnn_cd_preserve_pairs').on('change', function() { settings.preservePairs = !!$(this).prop('checked'); saveSettings(); });
        
        $('#rnn_cd_reset').on('click', function() {
            settings.currentStartIndex = 0;
            settings.anchorMessageId = null;
            settings.currentSummary = "";
            const context = getSTContext();
            if (context.extensionPrompts) delete context.extensionPrompts[extensionName];
            saveSettings();
            toastr.success("State reset.");
        });

        updateUI();
    } catch (error) {
        console.error("[RNN Chunk Dropper] Failed to load extension UI.", error);
    }
});