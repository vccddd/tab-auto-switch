document.addEventListener('DOMContentLoaded', init);

let allTabs = [];
let isRunning = false;
let currentPresetId = null;
let currentPresetName = '';

function generatePresetId() {
  return `preset_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function getDefaultIntervalValue() {
  let defaultInterval = parseInt(document.getElementById('interval').value, 10) || 6;
  if (defaultInterval < 6) {
    defaultInterval = 6;
    document.getElementById('interval').value = 6;
  }
  return defaultInterval;
}

function buildSelectedTabsState(selectedTabs, defaultInterval) {
  return selectedTabs.map(tab => ({
    id: tab.id,
    url: tab.url,
    title: tab.title,
    refreshAfterSwitch: Boolean(tab.refreshAfterSwitch),
    interval: tab.interval || defaultInterval
  }));
}

async function persistSwitchState(selectedTabsOverride) {
  const defaultInterval = getDefaultIntervalValue();
  const selectedTabs = selectedTabsOverride || buildSelectedTabsState(allTabs.filter(tab => tab.selected), defaultInterval);

  await chrome.storage.local.set({
    switchState: {
      interval: defaultInterval,
      selectedTabs,
      currentPresetId,
      currentPresetName
    }
  });

  return { defaultInterval, selectedTabs };
}

function normalizePreset(rawPreset) {
  if (!rawPreset || typeof rawPreset !== 'object') {
    return null;
  }

  const name = typeof rawPreset.name === 'string' ? rawPreset.name.trim() : '';
  if (!name) {
    return null;
  }

  const interval = Math.max(parseInt(rawPreset.interval, 10) || 6, 6);
  const rawTabs = Array.isArray(rawPreset.tabs) ? rawPreset.tabs : [];
  const tabs = rawTabs
    .map(tab => {
      if (!tab || typeof tab.url !== 'string' || !tab.url.trim()) {
        return null;
      }

      return {
        url: tab.url,
        title: typeof tab.title === 'string' && tab.title.trim() ? tab.title : tab.url,
        refreshAfterSwitch: Boolean(tab.refreshAfterSwitch),
        interval: Math.max(parseInt(tab.interval, 10) || interval, 6)
      };
    })
    .filter(Boolean);

  if (tabs.length === 0) {
    return null;
  }

  return {
    id: typeof rawPreset.id === 'string' && rawPreset.id.trim() ? rawPreset.id : generatePresetId(),
    name,
    interval,
    tabs,
    createdAt: Number.isFinite(rawPreset.createdAt) ? rawPreset.createdAt : Date.now()
  };
}

async function getStoredPresets() {
  const result = await chrome.storage.local.get(['presets']);
  const rawPresets = Array.isArray(result.presets) ? result.presets : [];
  const presets = [];
  const usedIds = new Set();
  let needsPersist = false;

  rawPresets.forEach(rawPreset => {
    const normalizedPreset = normalizePreset(rawPreset);
    if (!normalizedPreset) {
      needsPersist = true;
      return;
    }

    if (usedIds.has(normalizedPreset.id)) {
      normalizedPreset.id = generatePresetId();
      needsPersist = true;
    }

    if (!rawPreset.id || rawPreset.id !== normalizedPreset.id) {
      needsPersist = true;
    }

    usedIds.add(normalizedPreset.id);
    presets.push(normalizedPreset);
  });

  if (needsPersist) {
    await chrome.storage.local.set({ presets });
  }

  return presets;
}

function updateCurrentPresetUI() {
  const label = document.getElementById('currentPresetLabel');
  const overwriteButton = document.getElementById('overwritePreset');

  if (!label || !overwriteButton) {
    return;
  }

  if (currentPresetId && currentPresetName) {
    label.textContent = `Linked preset: ${currentPresetName}. Changes stay local until you click Update Current.`;
    label.classList.remove('empty');
    overwriteButton.disabled = false;
    return;
  }

  label.textContent = 'No preset linked. Changes stay local unless you save a new preset or update a loaded one.';
  label.classList.add('empty');
  overwriteButton.disabled = true;
}

function createPresetFromSelection(name, selectedTabs, defaultInterval, existingPreset = {}) {
  return {
    id: existingPreset.id || generatePresetId(),
    name,
    interval: defaultInterval,
    tabs: selectedTabs.map(tab => ({
      url: tab.url,
      title: tab.title,
      refreshAfterSwitch: tab.refreshAfterSwitch,
      interval: tab.interval || defaultInterval
    })),
    createdAt: existingPreset.createdAt || Date.now()
  };
}

// popup 中的用户活动也通知 background
function notifyUserActivity() {
  chrome.runtime.sendMessage({ action: 'userActivity' }).catch(() => {});
}
document.addEventListener('mousemove', notifyUserActivity, { passive: true });
document.addEventListener('mousedown', notifyUserActivity, { passive: true });
document.addEventListener('keydown', notifyUserActivity, { passive: true });
document.addEventListener('scroll', notifyUserActivity, { passive: true });

async function init() {
  // Display version from manifest
  document.getElementById('appVersion').textContent = chrome.runtime.getManifest().version;

  await loadTabs();
  await loadState();
  await loadPresets();
  bindEvents();
}

async function loadTabs() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const defaultInterval = parseInt(document.getElementById('interval').value) || 6;
  allTabs = tabs.map(tab => ({
    id: tab.id,
    url: tab.url,
    title: tab.title,
    favIconUrl: tab.favIconUrl,
    selected: false,
    refreshAfterSwitch: false,
    interval: defaultInterval
  }));
  renderTabList();
}

async function loadState() {
  const result = await chrome.storage.local.get(['switchState', 'backgroundState']);
  const state = result.switchState || {};
  const backgroundState = result.backgroundState || {};
  const runningTabIds = Array.isArray(backgroundState.tabIds) ? backgroundState.tabIds : [];
  currentPresetId = typeof state.currentPresetId === 'string' && state.currentPresetId ? state.currentPresetId : null;
  currentPresetName = typeof state.currentPresetName === 'string' ? state.currentPresetName : '';
  
  document.getElementById('interval').value = Math.max(state.interval || 6, 6);
  
  if (state.selectedTabs) {
    const matchedTabIds = new Set();
    let migratedIds = false;

    state.selectedTabs.forEach(savedTab => {
      const expectedTabId = savedTab.id || runningTabIds.find(tabId => !matchedTabIds.has(tabId));
      const tab = allTabs.find(t => {
        if (matchedTabIds.has(t.id)) {
          return false;
        }

        if (expectedTabId && t.id === expectedTabId) {
          return true;
        }

        return t.url === savedTab.url;
      });

      if (tab) {
        if (!savedTab.id && expectedTabId === tab.id) {
          savedTab.id = tab.id;
          migratedIds = true;
        }

        matchedTabIds.add(tab.id);
        tab.selected = true;
        tab.refreshAfterSwitch = savedTab.refreshAfterSwitch || false;
        tab.interval = savedTab.interval || (state.interval || 6);
      }
    });
    renderTabList();

    if (migratedIds) {
      await persistSwitchState();
    }
  }

  updateCurrentPresetUI();
  
  const response = await chrome.runtime.sendMessage({ action: 'getStatus' });
  if (response) {
    isRunning = response.isRunning;
    document.getElementById('enableToggle').checked = isRunning;
    updateStatus(isRunning, response.isPaused);
  }
}

function renderTabList() {
  const list = document.getElementById('tabList');
  list.innerHTML = '';
  
  if (allTabs.length === 0) {
    list.innerHTML = '<li class="empty-state">No tabs available</li>';
    return;
  }
  
  allTabs.forEach((tab, index) => {
    const li = document.createElement('li');
    li.className = 'tab-item' + (tab.selected ? ' selected' : '');
    li.dataset.index = index;
    li.draggable = true;
    
    const favicon = tab.favIconUrl || 'icons/icon16.png';
    li.innerHTML = `
      <div class="check">
        <input type="checkbox" class="tab-check" data-index="${index}" ${tab.selected ? 'checked' : ''}>
      </div>
      <div class="title">
        <img src="${favicon}" onerror="this.style.display='none'">
        <span title="${tab.title || tab.url}">${tab.title || 'Untitled'}</span>
      </div>
      <div class="col-interval">
        <input type="number" class="tab-interval-input" data-index="${index}" min="6" value="${tab.interval || 6}">
      </div>
      <div class="refresh">
        <input type="checkbox" class="refresh-check" data-index="${index}" ${tab.refreshAfterSwitch ? 'checked' : ''}>
      </div>
    `;
    
    list.appendChild(li);
  });
  
  bindDragEvents();
}

function bindDragEvents() {
  const items = document.querySelectorAll('.tab-item');
  items.forEach(item => {
    item.addEventListener('dragstart', handleDragStart);
    item.addEventListener('dragend', handleDragEnd);
    item.addEventListener('dragover', handleDragOver);
    item.addEventListener('drop', handleDrop);
    item.addEventListener('dragleave', handleDragLeave);
  });
}

let draggedIndex = null;

function handleDragStart(e) {
  draggedIndex = parseInt(this.dataset.index);
  this.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}

function handleDragEnd() {
  this.classList.remove('dragging');
  document.querySelectorAll('.tab-item').forEach(item => item.classList.remove('drag-over'));
}

function handleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  this.classList.add('drag-over');
}

function handleDragLeave() {
  this.classList.remove('drag-over');
}

function handleDrop(e) {
  e.preventDefault();
  const targetIndex = parseInt(this.dataset.index);
  
  if (draggedIndex !== null && draggedIndex !== targetIndex) {
    const [movedTab] = allTabs.splice(draggedIndex, 1);
    allTabs.splice(targetIndex, 0, movedTab);
    renderTabList();
    saveState();
  }
  this.classList.remove('drag-over');
}

function bindEvents() {
  document.getElementById('tabList').addEventListener('change', (e) => {
    const index = parseInt(e.target.dataset.index);
    if (e.target.classList.contains('tab-check')) {
      allTabs[index].selected = e.target.checked;
      e.target.closest('.tab-item').classList.toggle('selected', e.target.checked);
    } else if (e.target.classList.contains('refresh-check')) {
      allTabs[index].refreshAfterSwitch = e.target.checked;
    } else if (e.target.classList.contains('tab-interval-input')) {
      let interval = parseInt(e.target.value) || 6;
      if (interval < 6) {
        interval = 6;
        e.target.value = 6;
      }
      allTabs[index].interval = interval;
    }
    saveState();
  });
  
  document.getElementById('refreshList').addEventListener('click', loadTabs);
  document.getElementById('interval').addEventListener('change', saveState);
  
  document.getElementById('enableToggle').addEventListener('change', async (e) => {
    if (e.target.checked) {
      await startSwitch();
    } else {
      await stopSwitch();
    }
  });
  
  document.getElementById('savePreset').addEventListener('click', savePreset);
  document.getElementById('overwritePreset').addEventListener('click', overwriteCurrentPreset);
  document.getElementById('importPreset').addEventListener('click', () => {
    const input = document.getElementById('presetImportFile');
    input.value = '';
    input.click();
  });
  document.getElementById('presetImportFile').addEventListener('change', handleImportPresetFile);
}

async function saveState() {
  const { defaultInterval, selectedTabs } = await persistSwitchState();
  
  if (isRunning) {
    const tabIds = selectedTabs.map(t => t.id);
    const refreshSettings = {};
    const intervalSettings = {};
    selectedTabs.forEach(t => { 
      refreshSettings[t.id] = t.refreshAfterSwitch;
      intervalSettings[t.id] = t.interval || defaultInterval;
    });
    
    await chrome.runtime.sendMessage({
      action: 'updateConfig',
      tabIds,
      refreshSettings,
      intervalSettings
    });
  }
}

async function startSwitch() {
  const selectedTabs = allTabs.filter(t => t.selected);
  if (selectedTabs.length < 2) {
    alert('Please select at least 2 tabs to switch between');
    document.getElementById('enableToggle').checked = false;
    return;
  }
  
  await saveState();
  
  const tabIds = selectedTabs.map(t => t.id);
  const refreshSettings = {};
  const intervalSettings = {};
  let defaultInterval = parseInt(document.getElementById('interval').value) || 6;
  if (defaultInterval < 6) defaultInterval = 6;
  
  selectedTabs.forEach(t => { 
    refreshSettings[t.id] = t.refreshAfterSwitch;
    intervalSettings[t.id] = t.interval || defaultInterval;
  });
  
  await chrome.runtime.sendMessage({
    action: 'start',
    tabIds,
    refreshSettings,
    intervalSettings
  });
  
  isRunning = true;
  updateStatus(true, false);
}

async function stopSwitch() {
  await chrome.runtime.sendMessage({ action: 'stop' });
  isRunning = false;
  updateStatus(false, false);
}

function updateStatus(running, paused) {
  const statusBar = document.getElementById('statusBar');
  const statusText = document.getElementById('statusText');
  
  if (running && paused) {
    statusBar.className = 'status-bar paused';
    statusText.textContent = 'Paused - User activity detected';
  } else if (running) {
    statusBar.className = 'status-bar active';
    statusText.textContent = 'Active - Switching tabs automatically';
  } else {
    statusBar.className = 'status-bar inactive';
    statusText.textContent = 'Disabled';
  }
}

function sanitizeFileName(name) {
  const sanitized = name.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return sanitized || 'preset';
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function downloadJsonFile(fileName, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function extractPresetFromPayload(payload) {
  if (payload && typeof payload === 'object' && payload.preset && typeof payload.preset === 'object') {
    return payload.preset;
  }
  return payload;
}

function normalizeImportedPreset(rawPreset) {
  if (!rawPreset || typeof rawPreset !== 'object') {
    throw new Error('Invalid preset file format');
  }

  const name = typeof rawPreset.name === 'string' ? rawPreset.name.trim() : '';
  if (!name) {
    throw new Error('Preset name is required');
  }

  const defaultInterval = Math.max(parseInt(rawPreset.interval, 10) || 6, 6);
  const rawTabs = Array.isArray(rawPreset.tabs) ? rawPreset.tabs : [];

  const tabs = rawTabs
    .map(tab => {
      if (!tab || typeof tab.url !== 'string' || !tab.url.trim()) {
        return null;
      }
      return {
        url: tab.url,
        title: typeof tab.title === 'string' && tab.title.trim() ? tab.title : tab.url,
        refreshAfterSwitch: Boolean(tab.refreshAfterSwitch),
        interval: Math.max(parseInt(tab.interval, 10) || defaultInterval, 6)
      };
    })
    .filter(Boolean);

  if (tabs.length === 0) {
    throw new Error('Preset must contain at least one valid tab');
  }

  return {
    id: generatePresetId(),
    name,
    interval: defaultInterval,
    tabs,
    createdAt: Date.now()
  };
}

function getSuggestedImportedName(baseName, presets) {
  let counter = 1;
  let candidate = `${baseName} (Imported)`;
  while (presets.some(preset => preset.name === candidate)) {
    counter += 1;
    candidate = `${baseName} (Imported ${counter})`;
  }
  return candidate;
}

function resolvePresetNameConflict(baseName, presets) {
  let suggestedName = getSuggestedImportedName(baseName, presets);

  while (true) {
    const enteredName = prompt(
      `Preset "${baseName}" already exists. Enter a new name for the imported preset:`,
      suggestedName
    );

    if (enteredName === null) {
      return null;
    }

    const name = enteredName.trim();
    if (!name) {
      alert('Preset name cannot be empty');
      continue;
    }

    if (presets.some(preset => preset.name === name)) {
      alert(`Preset "${name}" already exists`);
      suggestedName = getSuggestedImportedName(name, presets);
      continue;
    }

    return name;
  }
}

async function exportPreset(index) {
  const presets = await getStoredPresets();
  const preset = presets[index];

  if (!preset) {
    alert('Preset not found');
    return;
  }

  const exportPayload = {
    format: 'tab-auto-switch-preset',
    version: 1,
    exportedAt: Date.now(),
    preset
  };

  const fileName = `${sanitizeFileName(preset.name)}.tab-auto-switch.json`;
  downloadJsonFile(fileName, exportPayload);
}

async function importPresetFile(file) {
  const text = await file.text();
  let parsed;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error('Invalid JSON file');
  }

  const presetToImport = normalizeImportedPreset(extractPresetFromPayload(parsed));
  const presets = await getStoredPresets();
  const existingIndex = presets.findIndex(preset => preset.name === presetToImport.name);
  let finalName = presetToImport.name;

  if (existingIndex >= 0) {
    const shouldOverwrite = confirm(
      `Preset "${presetToImport.name}" already exists.\nPress OK to overwrite, or Cancel to import with a new name.`
    );

    if (shouldOverwrite) {
      presets[existingIndex] = {
        ...presetToImport,
        id: presets[existingIndex].id,
        name: presets[existingIndex].name,
        createdAt: presets[existingIndex].createdAt
      };
    } else {
      const renamed = resolvePresetNameConflict(presetToImport.name, presets);
      if (!renamed) {
        throw new Error('Import cancelled');
      }
      finalName = renamed;
      presets.push({ ...presetToImport, name: finalName });
    }
  } else {
    presets.push(presetToImport);
  }

  await chrome.storage.local.set({ presets });
  return finalName;
}

async function handleImportPresetFile(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  try {
    const importedName = await importPresetFile(file);
    await loadPresets();
    alert(`Preset "${importedName}" imported successfully`);
  } catch (error) {
    if (error && error.message !== 'Import cancelled') {
      alert(error.message || 'Failed to import preset');
    }
  } finally {
    event.target.value = '';
  }
}

async function savePreset() {
  const name = document.getElementById('presetName').value.trim();
  if (!name) {
    alert('Please enter a preset name');
    return;
  }
  
  const selectedTabs = allTabs.filter(t => t.selected);
  if (selectedTabs.length === 0) {
    alert('Please select at least one tab');
    return;
  }
  
  const defaultInterval = getDefaultIntervalValue();
  const presets = await getStoredPresets();
  const existingIndex = presets.findIndex(preset => preset.name === name);
  const existingPreset = existingIndex >= 0 ? presets[existingIndex] : null;

  if (existingPreset) {
    const shouldOverwrite = confirm(`Preset "${name}" already exists. Press OK to overwrite it.`);
    if (!shouldOverwrite) {
      return;
    }
  }

  const preset = createPresetFromSelection(name, selectedTabs, defaultInterval, existingPreset || undefined);
  if (existingIndex >= 0) {
    presets[existingIndex] = preset;
  } else {
    presets.push(preset);
  }

  await chrome.storage.local.set({ presets });
  currentPresetId = preset.id;
  currentPresetName = preset.name;
  await persistSwitchState();
  updateCurrentPresetUI();
  
  document.getElementById('presetName').value = '';
  loadPresets();
}

async function overwriteCurrentPreset() {
  if (!currentPresetId) {
    alert('No linked preset to update');
    return;
  }

  const selectedTabs = allTabs.filter(tab => tab.selected);
  if (selectedTabs.length === 0) {
    alert('Please select at least one tab');
    return;
  }

  const presets = await getStoredPresets();
  const presetIndex = presets.findIndex(preset => preset.id === currentPresetId);
  if (presetIndex < 0) {
    currentPresetId = null;
    currentPresetName = '';
    await persistSwitchState();
    updateCurrentPresetUI();
    alert('The linked preset no longer exists');
    await loadPresets();
    return;
  }

  const defaultInterval = getDefaultIntervalValue();
  presets[presetIndex] = createPresetFromSelection(
    presets[presetIndex].name,
    selectedTabs,
    defaultInterval,
    presets[presetIndex]
  );

  await chrome.storage.local.set({ presets });
  currentPresetName = presets[presetIndex].name;
  await persistSwitchState();
  updateCurrentPresetUI();
  await loadPresets();
  alert(`Preset "${currentPresetName}" updated`);
}

async function loadPresets() {
  const presets = await getStoredPresets();
  const list = document.getElementById('presetList');

  if (currentPresetId && !presets.some(preset => preset.id === currentPresetId)) {
    currentPresetId = null;
    currentPresetName = '';
    await persistSwitchState();
  }

  updateCurrentPresetUI();
  
  if (presets.length === 0) {
    list.innerHTML = '<li class="empty-state">No presets saved</li>';
    return;
  }
  
  list.innerHTML = presets.map((preset, index) => `
    <li class="preset-item">
      <div>
        <div class="preset-name">${escapeHtml(preset.name)}${preset.id === currentPresetId ? ' <span class="preset-current-badge">Current</span>' : ''}</div>
        <div class="preset-info">${preset.tabs.length} tabs / ${preset.interval}s interval</div>
      </div>
      <div class="preset-actions">
        <button class="btn-load" data-index="${index}">Load</button>
        <button class="btn-export" data-index="${index}">Export</button>
        <button class="btn-delete" data-index="${index}">Delete</button>
      </div>
    </li>
  `).join('');
  
  list.querySelectorAll('.btn-load').forEach(btn => {
    btn.addEventListener('click', () => loadPreset(parseInt(btn.dataset.index)));
  });
  
  list.querySelectorAll('.btn-delete').forEach(btn => {
    btn.addEventListener('click', () => deletePreset(parseInt(btn.dataset.index)));
  });

  list.querySelectorAll('.btn-export').forEach(btn => {
    btn.addEventListener('click', () => exportPreset(parseInt(btn.dataset.index)));
  });
}

async function loadPreset(index) {
  const presets = await getStoredPresets();
  const preset = presets[index];
  if (!preset) return;
  
  await stopSwitch();
  document.getElementById('enableToggle').checked = false;
  
  document.getElementById('interval').value = preset.interval;
  currentPresetId = preset.id;
  currentPresetName = preset.name;
  updateCurrentPresetUI();
  
  const newTabIds = [];
  const refreshSettings = {};
  const intervalSettings = {};
  
  const firstTabInfo = preset.tabs[0];
  const newWindow = await chrome.windows.create({ 
    url: firstTabInfo.url,
    focused: true 
  });
  
  const firstTabId = newWindow.tabs[0].id;
  newTabIds.push(firstTabId);
  refreshSettings[firstTabId] = firstTabInfo.refreshAfterSwitch;
  intervalSettings[firstTabId] = firstTabInfo.interval || preset.interval;
  
  for (let i = 1; i < preset.tabs.length; i++) {
    const tabInfo = preset.tabs[i];
    const tab = await chrome.tabs.create({ 
      windowId: newWindow.id,
      url: tabInfo.url, 
      active: false 
    });
    newTabIds.push(tab.id);
    refreshSettings[tab.id] = tabInfo.refreshAfterSwitch;
    intervalSettings[tab.id] = tabInfo.interval || preset.interval;
  }

  const selectedTabs = preset.tabs.map((tabInfo, tabIndex) => ({
    id: newTabIds[tabIndex],
    url: tabInfo.url,
    title: tabInfo.title,
    refreshAfterSwitch: tabInfo.refreshAfterSwitch,
    interval: tabInfo.interval || preset.interval
  }));

  await persistSwitchState(selectedTabs);
  
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  await chrome.runtime.sendMessage({
    action: 'start',
    tabIds: newTabIds,
    refreshSettings,
    intervalSettings
  });
  
  isRunning = true;
  document.getElementById('enableToggle').checked = true;
  updateStatus(true, false);
}

async function deletePreset(index) {
  if (!confirm('Delete this preset?')) return;
  
  const presets = await getStoredPresets();
  const preset = presets[index];
  presets.splice(index, 1);
  await chrome.storage.local.set({ presets });

  if (preset && preset.id === currentPresetId) {
    currentPresetId = null;
    currentPresetName = '';
    await persistSwitchState();
    updateCurrentPresetUI();
  }

  loadPresets();
}
