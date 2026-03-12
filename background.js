let state = {
  isRunning: false,
  isPaused: false,
  tabIds: [],
  refreshSettings: {},
  intervalSettings: {},
  currentIndex: 0
};

let lastSwitchTime = 0;
const COOLDOWN_MS = 500;

// Load state on startup
chrome.storage.local.get(['backgroundState'], (result) => {
  if (result.backgroundState) {
    state = result.backgroundState;
  }
});

async function saveState() {
  await chrome.storage.local.set({ backgroundState: state });
}

async function refreshState() {
  const result = await chrome.storage.local.get(['backgroundState']);
  if (result.backgroundState) {
    state = result.backgroundState;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Ensure we work with latest state for any action
  refreshState().then(() => {
    switch (message.action) {
      case 'start':
        startSwitch(message).then(() => sendResponse({ success: true }));
        break;
      case 'stop':
        stopSwitch().then(() => sendResponse({ success: true }));
        break;
      case 'getStatus':
        sendResponse({
          isRunning: state.isRunning,
          isPaused: state.isPaused,
          currentIndex: state.currentIndex
        });
        break;
      case 'userActivity':
        handleUserActivity().then(() => sendResponse({ success: true }));
        break;
      case 'updateConfig':
        updateConfig(message).then(() => sendResponse({ success: true }));
        break;
    }
  });
  return true; // Keep channel open
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  await refreshState();
  
  if (alarm.name === 'switchAlarm') {
    await doSwitch();
  } else if (alarm.name === 'resumeAlarm') {
    await resumeSwitch();
  }
});

async function updateConfig(config) {
  if (!state.isRunning) return;
  if (config.tabIds) {
    state.tabIds = config.tabIds;
    state.currentIndex = 0;
  }
  if (config.refreshSettings) {
    state.refreshSettings = config.refreshSettings;
  }
  if (config.intervalSettings) {
    state.intervalSettings = config.intervalSettings;
    if (!state.isPaused) {
      await scheduleNextSwitch();
    }
  }
  await saveState();
}

async function injectContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });
  } catch (e) {}
}

async function startSwitch(config) {
  state.tabIds = config.tabIds;
  state.refreshSettings = config.refreshSettings || {};
  state.intervalSettings = config.intervalSettings || {};
  state.currentIndex = 0;
  state.isRunning = true;
  state.isPaused = false;
  lastSwitchTime = Date.now();

  await saveState();

  for (const tabId of state.tabIds) {
    await injectContentScript(tabId);
  }

  if (state.tabIds.length > 0) {
    try {
      await chrome.tabs.update(state.tabIds[0], { active: true });
    } catch (e) {}
  }

  await scheduleNextSwitch();
}

function getCurrentTabInterval() {
  if (state.tabIds.length === 0) return 6;
  const currentTabId = state.tabIds[state.currentIndex];
  return Math.max(state.intervalSettings[currentTabId] || 6, 6);
}

async function scheduleNextSwitch() {
  await chrome.alarms.clear('switchAlarm');
  
  if (!state.isRunning || state.isPaused) return;
  
  const interval = getCurrentTabInterval();
  chrome.alarms.create('switchAlarm', {
    when: Date.now() + (interval * 1000)
  });
}

async function stopSwitch() {
  state.isRunning = false;
  state.isPaused = false;
  await saveState();
  await chrome.alarms.clearAll();
}

async function doSwitch() {
  if (!state.isRunning || state.isPaused) return;

  const validTabIds = [];
  for (const tabId of state.tabIds) {
    try {
      await chrome.tabs.get(tabId);
      validTabIds.push(tabId);
    } catch (e) {}
  }

  if (validTabIds.length < 2) {
    await stopSwitch();
    return;
  }

  state.tabIds = validTabIds;
  
  // Update index
  state.currentIndex = (state.currentIndex + 1) % state.tabIds.length;
  const nextTabId = state.tabIds[state.currentIndex];
  const previousTabId = state.tabIds[(state.currentIndex - 1 + state.tabIds.length) % state.tabIds.length];

  try {
    lastSwitchTime = Date.now();
    await chrome.tabs.update(nextTabId, { active: true });
    if (state.refreshSettings[previousTabId]) {
       // Use setTimeout for reload to avoid blocking flow, or just await it
       chrome.tabs.reload(previousTabId).catch(() => {});
    }
  } catch (e) {}
  
  await saveState();
  await scheduleNextSwitch();
}

async function handleUserActivity() {
  if (!state.isRunning) return;
  if (Date.now() - lastSwitchTime < COOLDOWN_MS) return;

  if (!state.isPaused) {
    state.isPaused = true;
    await chrome.alarms.clear('switchAlarm');
    await saveState();
  }

  // Reset resume timer
  await chrome.alarms.clear('resumeAlarm');
  const resumeInterval = getCurrentTabInterval();
  chrome.alarms.create('resumeAlarm', {
    when: Date.now() + (resumeInterval * 1000)
  });
}

async function resumeSwitch() {
  if (state.isRunning && state.isPaused) {
    state.isPaused = false;
    await saveState();
    await scheduleNextSwitch();
  }
}

chrome.tabs.onActivated.addListener(async () => {
  await refreshState();
  if (!state.isRunning) return;
  if (Date.now() - lastSwitchTime < COOLDOWN_MS) return;
  await handleUserActivity();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await refreshState();
  if (state.isRunning && state.tabIds.includes(tabId)) {
    state.tabIds = state.tabIds.filter(id => id !== tabId);
    delete state.refreshSettings[tabId];
    delete state.intervalSettings[tabId];
    
    if (state.currentIndex >= state.tabIds.length) {
      state.currentIndex = 0;
    }
    
    await saveState();
    
    if (state.tabIds.length < 2) {
      await stopSwitch();
    }
  }
});
