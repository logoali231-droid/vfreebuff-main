// VFreeBuff PWA — Frontend (app.js)
// Connects the HTML UI to all server API endpoints.
// All secrets stay server-side; the browser never sees API keys.

import { publicConfig, loadConfig } from './config.js';
import { publicRegistry } from './providers.js';
import { runs, getStatus } from './pipeline.js';
import { readQuestbook, readChaptersLayout } from './questbook.js';
import { searchCatalog, getModDetail } from './catalog.js';

// ── DOM elements ──────────────────────────────────────────────────────
const providerSelect = document.getElementById('provider');
const apiKeyInput = document.getElementById('apiKey');
const apiModelInput = document.getElementById('apiModel');
const apiBaseUrlInput = document.getElementById('apiBaseUrl');
const apiModelsList = document.getElementById('apiModels');
const mcVersionInput = document.getElementById('mcVersion');
const mcVersionsList = document.getElementById('mcVersions');
const modLoaderSelect = document.getElementById('modLoader');
const instanceDirInput = document.getElementById('instanceDir');
const validateDirBtn = document.getElementById('validateDirBtn');
const dirStatus = document.getElementById('dirStatus');
const modCountInput = document.getElementById('modCount');
const exportSnbtCheckbox = document.getElementById('exportSnbt');
const promptTextarea = document.getElementById('prompt');
const generateBtn = document.getElementById('generateBtn');
const saveBtn = document.getElementById('saveBtn');
const phasesEl = document.getElementById('phases');
const summaryEl = document.getElementById('summary');
const terminal = document.getElementById('terminal');
const copyLogBtn = document.getElementById('copyLogBtn');
clearLogBtn = document.getElementById('clearLogBtn');
previewBtn = document.getElementById('previewBtn');
generateOverlay = document.getElementById('questbookOverlay');
closeQuestbookBtn = document.getElementById('closeQuestbookBtn');
previewOverlay = document.getElementById('previewOverlay');
closePreviewBtn = document.getElementById('closePreviewBtn');
catOverlay = document.getElementById('catalogOverlay');
closeCatalogBtn = document.getElementById('closeCatalogBtn');
catQuery = document.getElementById('catQuery');
catSort = document.getElementById('catSort');
catSearchBtn = document.getElementById('catSearchBtn');
catResults = document.getElementById('catResults');
catStatus = document.getElementById('catStatus');
catPager = document.getElementById('catPager');
cfProposal = document.getElementById('cfProposal');
cfInstruction = document.getElementById('cfInstruction');
cfProposeBtn = document.getElementById('cfProposeBtn');
cfTabConfigure = document.querySelector('[data-cf-tab="configure"]');
cfTabTroubleshoot = document.querySelector('[data-cf-tab="troubleshoot"]');
cfLog = document.getElementById('cfLog');
cfAnalyzeBtn = document.getElementById('cfAnalyzeBtn');
cfResult = document.getElementById('cfResult');
const exampleChips = document.getElementById('exampleChips');

// ── State ─────────────────────────────────────────────────────────────
let sseWs = null;
let runId = null;

// ── init on page load ────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Initialize auth status first, then load everything else
  checkAuthAndLoad();
});

// Check auth status and proceed
async function checkAuthAndLoad() {
  const statusResp = await fetch('/api/auth/status');
  const statusData = await statusResp.json();

  if (statusData.enabled && !statusData.authed) {
    // Redirect to login if auth is enabled and user not logged in
    window.location.href = '/login';
    return;
  }

  // Load config and providers
  await loadConfigAndProviders();

  // Set up event listeners
  setupEventListeners();

  // Initial status update
  updateRunStatus();
}

// Load config and populate UI
async function loadConfigAndProviders() {
  // Populate provider registry
  const registry = await publicRegistry();
  providerSelect.innerHTML = '';
  providerSelect.disabled = false;

  // Build provider options from the registry
  const providers = Object.entries(registry).map(([key, info]) => ({ key, ...info }));

  for (const p of providers) {
    const opt = document.createElement('option');
    opt.value = p.key;
    opt.label = p.label;
    // Set data attributes for hints
    opt.dataset.keyHint = p.keyHint || '';
    opt.dataset.noKey = p.noKey || false;
    opt.dataset.models = JSON.stringify(p.models || []);
    opt.dataset.baseUrl = p.defaultBaseUrl || '';
    providerSelect.appendChild(opt);
  }

  // Set default provider if only one available or if config has one
  const cfg = await loadConfig();
  if (cfg.provider && registry[cfg.provider]) {
    providerSelect.value = cfg.provider;
  } else if (providers.length > 0) {
    providerSelect.value = providers[0].key;
  }

  // Populate models list for the selected provider
  updateModelList(providerSelect.value);

  // Set up model datalist options initially
  const firstProvider = providerSelect.value;
  updateModelList(firstProvider);

  // Set up Minecraft version datalist
  mcVersionsList.innerHTML = `
    <option value="1.20.1"></option>
    <option value="1.19.2"></option>
    <option value="1.18.2"></option>
    <option value="1.21.1"></option>
    <option value="1.16.5"></option>
  `;

  // Set mod loader defaults
  modLoaderSelect.value = cfg.modLoader || 'forge';

  // Set instance dir from config if available
  if (cfg.instanceDir) {
    instanceDirInput.value = cfg.instanceDir;
  }

  // Set mod count from config
  modCountInput.value = cfg.modCount !== undefined ? cfg.modCount : 18;

  // Set export SNBT from config
  exportSnbtCheckbox.checked = cfg.exportFtbSnbt !== false;

  // Set prompt from config if available
  if (cfg.lastPrompt) {
    promptTextarea.value = cfg.lastPrompt;
  }
}

// Update model datalist based on selected provider
function updateModelList(providerKey) {
  const registry = publicRegistry();
  const provider = registry[providerKey];
  if (!provider || !provider.models) return;

  apiModelsList.innerHTML = '';
  const models = Array.isArray(provider.models) ? provider.models : [provider.models];
  models.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m;
    apiModelsList.appendChild(opt);
  });

  // Set the model input value if it's not already set
  if (!apiModelInput.value && provider.defaultModel) {
    apiModelInput.value = provider.defaultModel;
  }
}

// Setup all event listeners
function setupEventListeners() {
  // Provider change — update model list and API key hint
  providerSelect.addEventListener('change', (e) => {
    const key = e.target.value;
    updateModelList(key);

    // Show/hide API key field based on whether the provider needs a key
    const provider = providerSelect.options[providerSelect.selectedIndex];
    const noKey = provider.dataset.noKey === 'true';
    const keyLabel = document.getElementById('apiKeyLabel');
    const apiKeyHint = document.getElementById('apiKeyHint');

    if (noKey) {
      apiKeyInput.type = 'text';
      apiKeyInput.value = 'no key needed (local Ollama)';
      apiKeyInput.disabled = true;
      apiKeyHint.textContent = 'This provider does not require an API key (e.g., local Ollama)';
    } else {
      apiKeyInput.type = 'password';
      apiKeyInput.disabled = false;
      apiKeyHint.textContent = provider.dataset.keyHint || 'Add your API key for this provider';
    }
  });

  // API model change
  apiModelInput.addEventListener('change', () => {
    // Model is set, nothing special needed here
  });

  // MC version change — update catalog filter
  mcVersionInput.addEventListener('change', () => {
    // Could update catalog search default here
  });

  // Mod loader change
  modLoaderSelect.addEventListener('change', () => {
    // Update catalog search default
  });

  // Validate instance directory
  validateDirBtn.addEventListener('click', async () => {
    const dir = instanceDirInput.value.trim();
    if (!dir) {
      showToast('Please enter an instance directory path', 'error');
      return;
    }

    const resp = await fetch('/api/instance/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir })
    });
    const data = await resp.json();

    if (data.ok) {
      showToast('Instance directory is valid and writable', 'success');
      dirStatus.textContent = '✓ valid and writable';
      dirStatus.className = 'pill pill-online';
    } else {
      showToast(`Error: ${data.error || data.hasMods === false ? 'directory not found' : 'directory is not writable'}`, 'error');
      dirStatus.textContent = '✗ invalid';
      dirStatus.className = 'pill pill-offline';
    }
  });

  // Save settings
  saveBtn.addEventListener('click', async () => {
    const cfg = {
      provider: providerSelect.value,
      apiKey: apiKeyInput.value,
      apiModel: apiModelInput.value,
      apiBaseUrl: apiBaseUrlInput.value,
      minecraftVersion: mcVersionInput.value,
      modLoader: modLoaderSelect.value,
      instanceDir: instanceDirInput.value.trim() || undefined,
      modCount: Number(modCountInput.value),
      exportFtbSnbt: exportSnbtCheckbox.checked,
      lastPrompt: promptTextarea.value
    };

    const resp = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg)
    });
    const data = await resp.json();

    if (data.ok) {
      showToast('Settings saved', 'success');
      // Update model list after config save
      updateModelList(providerSelect.value);
    } else {
      showToast(`Save failed: ${data.error}`, 'error');
    }
  });

  // Generate modpack & quests
  generateBtn.addEventListener('click', async () => {
    const prompt = promptTextarea.value.trim();
    if (!prompt) {
      showToast('Please enter a modpack theme description', 'error');
      return;
    }

    // Disable generate button and show phases
    generateBtn.disabled = true;
    generateBtn.classList.add('disabled');
    phasesEl.classList.remove('hidden');

    // Reset phases
    document.querySelectorAll('.phase').forEach(ph => {
      ph.textContent = ph.dataset.default || 'queued';
    });

    // Clear terminal
    terminal.innerHTML = '';
    runId = null;

    // Start the generation run
    const resp = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt })
    });
    const data = await resp.json();

    if (!data.ok) {
      showToast(`Generation failed: ${data.error}`, 'error');
      generateBtn.disabled = false;
      generateBtn.classList.remove('disabled');
      phasesEl.classList.add('hidden');
      return;
    }

    runId = data.runId;
    pollRunStatus();
  });

  // Preview quest tree
  previewBtn.addEventListener('click', async () => {
    const cfg = await loadConfig();
    if (!cfg.instanceDir) {
      showToast('Please set an instance directory first', 'error');
      return;
    }

    const chaptersLayout = await fetch('/api/chapters', {
      // No body needed - just GET
    }).then(r => r.json());

    // Show in preview overlay
    showQuestTree(chaptersLayout);
  });

  // Questbook close buttons
  closeQuestbookBtn.addEventListener('click', () => {
    generateOverlay.classList.add('hidden');
  });

  closePreviewBtn.addEventListener('click', () => {
    previewOverlay.classList.add('hidden');
  });

  closeCatalogBtn.addEventListener('click', () => {
    catOverlay.classList.add('hidden');
  });

  // Copy terminal log
  copyLogBtn.addEventListener('click', () => {
    const text = terminal.innerText || terminal.textContent;
    navigator.clipboard.writeText(text).then(() => {
      showToast('Log copied to clipboard', 'success');
    });
  });

  // Clear terminal log
  clearLogBtn.addEventListener('click', () => {
    terminal.innerHTML = '';
  });

  // Catalog search
  catSearchBtn.addEventListener('click', async () => {
    const query = catQuery.value.trim();
    if (!query) {
      showToast('Enter a search term', 'error');
      return;
    }

    const mcVersion = mcVersionInput.value || '1.20.1';
    const loader = modLoaderSelect.value || 'forge';
    const limit = 24;

    const resp = await fetch(`/api/catalog?q=${encodeURIComponent(query)}&mc=${mcVersion}&loader=${loader}&limit=${limit}`);
    const data = await resp.json();

    if (data.error) {
      showCatalogResults(data);
    } else {
      showCatalogResults(data);
    }
  });

  // Catalog search on Enter key
  catQuery.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      catSearchBtn.click();
    }
  });

  // Config propose changes
  cfProposeBtn.addEventListener('click', async () => {
    const instruction = cfInstruction.value.trim();
    if (!instruction) {
      showToast('Enter a configuration change description', 'error');
      return;
    }

    const cfg = await loadConfig();
    const resp = await fetch('/api/config/propose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instanceDir: cfg.instanceDir,
        instruction
      })
    });
    const data = await resp.json();

    if (data.error) {
      showToast(`Propose failed: ${data.error}`, 'error');
    } else {
      cfProposal.innerHTML = '';
      // Render the proposal
      if (data.proposal && data.proposal.changes) {
        for (const change of data.proposal.changes) {
          const div = document.createElement('div');
          div.className = 'cf-proposal-change';
          div.innerHTML = `<strong>${change.file}:</strong> ${change.oldValue} → ${change.newValue}`;
          cfProposal.appendChild(div);
        }
      }
      cfProposal.classList.remove('hidden');
      showToast('Changes proposed — review before applying', 'success');
    }
  });

  // Config apply proposal
  // (Need to add an Apply button listener if needed)

  // Config troubleshoot analyze
  cfAnalyzeBtn.addEventListener('click', async () => {
    const logText = cfLog.value.trim();
    if (!logText) {
      showToast('Paste a crash report or log', 'error');
      return;
    }

    const cfg = await loadConfig();
    const resp = await fetch('/api/troubleshoot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ log: logText, cfg, instanceDir: cfg.instanceDir })
    });
    const data = await resp.json();

    if (data.error) {
      showToast(`Analysis failed: ${data.error}`, 'error');
    } else {
      cfResult.innerHTML = '';
      if (data.fixes && data.fixes.length > 0) {
        for (const fix of data.fixes) {
          const div = document.createElement('div');
          div.className = 'cf-fix-item';
          div.innerHTML = `<strong>${fix.title}:</strong> ${fix.description}`;
          cfResult.appendChild(div);
        }
      }
      if (data.suggestedChanges && data.suggestedChanges.length > 0) {
        const h4 = document.createElement('h4');
        h4.textContent = 'Suggested config changes:';
        cfResult.appendChild(h4);
        for (const change of data.suggestedChanges) {
          const div = document.createElement('div');
          div.className = 'cf-fix-item';
          div.innerHTML = `<strong>${change.title}:</strong> ${change.description}`;
          cfResult.appendChild(div);
        }
      }
      if (data.diagnosis) {
        const div = document.createElement('div');
        div.className = 'cf-fix-item';
        div.textContent = data.diagnosis;
        cfResult.appendChild(div);
      }
      cfResult.classList.remove('hidden');
      showToast('Crash analysis complete', 'success');
    }
  });

  // Tab switching
  cfTabConfigure.addEventListener('click', () => {
    cfTabConfigure.classList.add('active');
    cfTabTroubleshoot.classList.remove('active');
    cfTabConfigure.parentElement.querySelector('.cf-tab').classList.add('hidden') || null;
    document.getElementById('cfTabConfigure').classList.remove('hidden');
    document.getElementById('cfTabTroubleshoot').classList.add('hidden');
  });

  cfTabTroubleshoot.addEventListener('click', () => {
    cfTabTroubleshoot.classList.add('active');
    cfTabConfigure.classList.remove('active');
    document.getElementById('cfTabTroubleshoot').classList.remove('hidden');
    document.getElementById('cfTabConfigure').classList.add('hidden');
  });

  // Example chips
  exampleChips.addEventListener('click', (e) => {
    if (e.target.classList.contains('chip')) {
      const text = e.target.textContent;
      promptTextarea.value = text;
    }
  });
}

// Poll run status via SSE or API
async function pollRunStatus() {
  if (!runId) return;

  // Try SSE first, fall back to API polling
  try {
    const statusResp = await fetch(`/api/status`);
    const statusData = await statusResp.json();

    displayRunStatus(statusData);

    if (statusData.running && statusData.runId === runId) {
      // Wait and poll again
      await new Promise(r => setTimeout(r, 2000));
      pollRunStatus();
    } else if (!statusData.running && statusData.lastResult) {
      // Run completed
      displayRunResult(statusData.lastResult);
    }
  } catch (e) {
    // Fall back to simple API polling
    await pollRunStatusApi();
  }
}

async function pollRunStatusApi() {
  if (!runId) return;

  const statusResp = await fetch('/api/status');
  const statusData = await statusResp.json();

  displayRunStatus(statusData);

  if (statusData.running && statusData.runId === runId) {
    await new Promise(r => setTimeout(r, 2000));
    pollRunStatusApi();
  } else if (!statusData.running && statusData.lastResult) {
    displayRunResult(statusData.lastResult);
  }
}

// Display run status in terminal
function displayRunStatus(status) {
  const phase = status.phase || 'init';
  const phaseElements = document.querySelectorAll('.phase');
  
  // Update phase display
  phaseElements.forEach(ph => {
    if (ph.dataset.phase === phase) {
      ph.textContent = getPhaseLabel(phase);
      ph.className = `phase ${getPhaseClass(phase)}`;
    }
  });

  // Add log entries
  if (status.running && status.runId === runId) {
    // We add log lines via SSE, but if not available, show basic status
    addTerminalLog(`Status: ${phase} — ${status.ok ? 'running...' : 'error: ' + (status.error || '')}`, 'info');
  }
}

// Get phase label
function getPhaseLabel(phase) {
  const labels = {
    'init': 'queued',
    'mods': 'AI mods',
    'download': '⬇ Modrinth',
    'quests': '📜 quests',
    'validate': '🛡 validate',
    'done': 'done',
    'failed': 'failed'
  };
  return labels[phase] || phase;
}

// Get phase class
function getPhaseClass(phase) {
  const classes = {
    'init': 'pending',
    'mods': 'active',
    'download': 'active',
    'quests': 'active',
    'validate': 'active',
    'done': 'complete',
    'failed': 'error'
  };
  return classes[phase] || 'pending';
}

// Add a log line to the terminal
function addTerminalLog(message, type = 'info') {
  const time = new Date().toLocaleTimeString();
  const entry = document.createElement('div');
  entry.className = `terminal-entry terminal-${type}`;
  entry.innerHTML = `<span class="terminal-time">[${time}]</span> ${message}`;
  terminal.appendChild(entry);
  terminal.scrollTop = terminal.scrollHeight;
}

// Display run result after completion
function displayRunResult(result) {
  // Hide phases
  phasesEl.classList.add('hidden');
  generateBtn.disabled = false;
  generateBtn.classList.remove('disabled');

  // Show summary
  summaryEl.classList.remove('hidden');
  summaryEl.innerHTML = '';

  if (result.ok) {
    summaryEl.innerHTML = `
      <div class="summary-ok">
        <h3>✅ Modpack generated successfully!</h3>
        <p><strong>Mods downloaded:</strong> ${result.modsDownloaded}</p>
        <p><strong>Chapters:</strong> ${result.chapters.length}</p>
        <p><strong>Questbook:</strong> ${result.questbookPath}</p>
        <p><strong>Compatibility:</strong> ${result.compat.ok ? 'PASS' : 'FAIL'}</p>
        <p><strong>Elapsed:</strong> ${result.elapsedSec}s</p>
        <button class="btn btn-primary" id="viewQuestbookBtn">View Questbook</button>
      </div>
    `;

    // Add view questbook button handler
    const viewBtn = document.getElementById('viewQuestbookBtn');
    if (viewBtn) {
      viewBtn.addEventListener('click', async () => {
        // Fetch the questbook
        const cfg = await loadConfig();
        const qbResp = await fetch('/api/questbook');
        const qbData = await qbResp.json();

        if (qbData.questbook) {
          showQuestbook(qbData.questbook);
        } else {
          showToast('No questbook found', 'error');
        }
      });
    }

    // Also store the result for later use
    window.lastResult = result;
  } else {
    summaryEl.innerHTML = `
      <div class="summary-error">
        <h3>❌ Generation failed</h3>
        <p><strong>Error:</strong> ${result.error || 'Unknown error'}</p>
        <p><strong>Phase:</strong> ${result.phase || 'unknown'}</p>
        <button class="btn btn-secondary" id="tryAgainBtn">Try Again</button>
      </div>
    `;

    const tryAgainBtn = document.getElementById('tryAgainBtn');
    if (tryAgainBtn) {
      tryAgainBtn.addEventListener('click', () => {
        // Regenerate with same prompt
        promptTextarea.value = result.prompt || '';
        generateBtn.click();
      });
    }
  }
}

// Show questbook in the overlay
async function showQuestbook(questbook) {
  generateOverlay.classList.remove('hidden');
  document.getElementById('qbPackTitle').textContent = questbook.packTitle || 'Questbook';

  // Show meta
  const meta = document.getElementById('qbMeta');
  meta.innerHTML = `
    <span>Chapters: ${questbook.chapters.length}</span>
    <span>Quests: ${questbook.chapters.reduce((a, c) => a + c.quests.length, 0)}</span>
    <span>Format: ${questbook.format}</span>
  `;

  // Build chapters navigation
  const chaptersNav = document.getElementById('qbChapters');
  chaptersNav.innerHTML = '';

  questbook.chapters.forEach((chapter, ci) => {
    const btn = document.createElement('button');
    btn.className = `qb-chapter-btn ${ci === 0 ? 'active' : ''}`;
    btn.textContent = chapter.title;
    btn.dataset.chapterIndex = ci;
    btn.addEventListener('click', () => {
      // Remove active class from all buttons
      document.querySelectorAll('.qb-chapter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderChapterQuests(chapter, ci);
    });
    chaptersNav.appendChild(btn);
  });

  // Render first chapter's quests by default
  if (questbook.chapters.length > 0) {
    renderChapterQuests(questbook.chapters[0], 0);
  }
}

// Render quests for a chapter in the tree
function renderChapterQuests(chapter, chapterIndex) {
  const treeCanvas = document.getElementById('qbTree');
  treeCanvas.innerHTML = '';

  chapter.quests.forEach((quest, qi) => {
    const questEl = document.createElement('div');
    questEl.className = 'qb-quest';
    questEl.innerHTML = `
      <div class="qb-quest-header">
        <span class="qb-quest-title">${quest.title}</span>
        <span class="qb-quest-deps">${quest.dependencies?.length > 0 ? `Depends on: ${quest.dependencies.join(', ')}` : 'Free'} </span>
      </div>
      <div class="qb-quest-desc">${quest.description || 'No description'}</div>
      <div class="qb-quest-tasks">
        Tasks: ${quest.tasks?.length > 0 ? quest.tasks.map(t => `${t.type}: ${t.title}`).join(', ') : 'None'}
      </div>
      <div class="qb-quest-rewards">
        Rewards: ${quest.rewards?.length > 0 ? quest.rewards.map(r => `${r.type}`).join(', ') : 'None'}
      </div>
    `;
    treeCanvas.appendChild(questEl);
  });
}

// Show quest tree preview (FTB Quests style)
function showQuestTree(chaptersLayout) {
  previewOverlay.classList.remove('hidden');
  document.getElementById('previewInfo').textContent = `Quest tree layout for ${chaptersLayout.chapters.length} chapters`;

  // Build tabs for each chapter
  const tabsContainer = document.getElementById('previewTabs');
  tabsContainer.innerHTML = '';

  chaptersLayout.chapters.forEach((chapter, ci) => {
    const tab = document.createElement('button');
    tab.className = `chip ${ci === 0 ? 'active' : ''}`;
    tab.textContent = `Chapter ${ci + 1}: ${chapter.title}`;
    tab.dataset.chapter = ci;
    tab.addEventListener('click', () => {
      document.querySelectorAll('#previewTabs .chip').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      renderChapterPreview(chapter, ci);
    });
    tabsContainer.appendChild(tab);
  });

  // Render first chapter by default
  if (chaptersLayout.chapters.length > 0) {
    renderChapterPreview(chaptersLayout.chapters[0], 0);
  }
}

// Render chapter preview
function renderChapterPreview(chapter, chapterIndex) {
  const canvas = document.getElementById('previewCanvas');
  canvas.innerHTML = '';

  chapter.quests.forEach((quest, qi) => {
    const questEl = document.createElement('div');
    questEl.className = 'qb-preview-quest';
    questEl.innerHTML = `
      <div class="qb-quest-title-small">${quest.title}</div>
      <div class="qb-quest-info">
        x: ${quest.x}, y: ${quest.y}<br/>
        Tasks: ${quest.tasks?.length || 0}<br/>
        Rewards: ${quest.rewards?.length || 0}
      </div>
      <div class="qb-quest-deps-small">
        deps: ${quest.dependencies?.join(', ') || 'none'}
      </div>
    `;
    canvas.appendChild(questEl);
  });
}

// Show catalog results
function showCatalogResults(data) {
  if (data.error) {
    showCatalogStatus(data.error, 'error');
    return;
  }

  catResults.innerHTML = '';

  if (!data || data.length === 0) {
    catResults.innerHTML = '<p>No mods found matching your search.</p>';
    showCatalogStatus('', 'default');
    return;
  }

  // Render mod cards
  const fragment = document.createDocumentFragment();
  data.forEach(mod => {
    const modCard = document.createElement('div');
    modCard.className = 'cat-mod-card';
    modCard.innerHTML = `
      <h4>${mod.title || mod.slug}</h4>
      <p>${mod.description || 'No description available'}</p>
      <p><strong>Slug:</strong> ${mod.slug}</p>
      <p><strong>Version:</strong> ${mod.latestVersion?.mcVersion || 'N/A'} ${mod.latestVersion?.loader || ''}</p>
      <button class="btn btn-mini cat-select-btn" data-slug="${mod.slug}">Select</button>
    `;
    fragment.appendChild(modCard);
  });

  catResults.appendChild(fragment);
  showCatalogStatus(`${data.length} results`, 'success');
}

// Show catalog status
function showCatalogStatus(message, type = 'default') {
  catStatus.textContent = message;
  catStatus.className = `hint ${type}`;
}

// Show toast notification
function showToast(message, type = 'info') {
  const toastContainer = document.getElementById('toasts');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  toastContainer.appendChild(toast);

  // Auto-remove after 3 seconds
  setTimeout(() => {
    toast.remove();
  }, 3000);
}

// Initial auth check - already done in checkAuthAndLoad
// But we need to make sure the login page works too