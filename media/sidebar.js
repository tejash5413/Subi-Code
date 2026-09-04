// Subi Sidebar Webview Client Script — Stage 4A.2.2 true streaming + pickers
// Backend logic preserved: same validation, one-active-request, cost consent.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();

  let onboardingSection=null, onboardingWelcome=null, onboardingLearnSmart=null, onboardingFree=null, onboardingByok=null, onboardingLoading=null, onboardingError=null;
  let btnLearnSmart=null, btnFree=null, btnByok=null, btnBackLearnSmart=null, btnBackFree=null, btnBackFreeAlt=null, btnBackByok=null, btnBackByokAlt=null, btnErrorBack=null;
  let learnSmartEmail=null, learnSmartPassword=null, learnSmartForm=null, learnSmartMessage=null, errorMessage=null, loadingMessage=null;
  let btnLearnSmartSignIn=null, btnFreeContinue=null, btnByokConfigure=null, byokProviderSelect=null;
  let authBusy=false, currentIdentity={ type:'guest' }, settingsAccountSummary=null, btnAccountSignout=null;

  // Chat-first shell
  let topbar=null, topbarProject=null, btnSettings=null;
  let aiStatusRow=null, aiStatusBtn=null, aiStatusLabel=null;
  let mainChatView=null, chatEmptyState=null, chatEmptyTitle=null, btnEmptyConfigure=null;
  let chatFooter=null;
  let btnAddContext=null, contextMenu=null, btnAttachFile=null, btnAttachImage=null, attachStrip=null;
  let settingsOverlay=null, settingsTitle=null, btnSettingsBack=null, btnSettingsClose=null;
  let settingsHome=null, viewAi=null, viewProviderPicker=null, viewModelPicker=null, viewProject=null, viewFiles=null, viewSearch=null, viewAbout=null;
  let settingsAiSummary=null, settingsProjectSummary=null, btnResetOnboarding=null;

  // Relocated (same IDs, now inside settings views)
  let projectSection=null, filesSection=null, searchSection=null, previewSection=null;
  let noProjectState=null, projectCard=null, projectName=null, projectType=null, projectPath=null, projectMulti=null;
  let loadFilesBtn=null, filesLoading=null, fileList=null, showMoreBtn=null;
  let searchInput=null, searchModeFiles=null, searchModeContent=null, searchBtn=null, searchLoading=null, searchResultsContainer=null, searchResults=null, searchNoResults=null, searchError=null;
  let previewPath=null, previewCode=null, previewLoading=null;
  let chatInput=null, sendBtn=null, chatMessages=null, chatThinking=null, chatStatusValue=null, chatErrorEl=null, clearChatBtn=null;
  let aiProviderLabel=null, aiModelLabel=null, btnOpenProviderPicker=null, providerList=null;
  let btnConfigureProvider=null, btnRemoveProviderKey=null;
  let modelPickerBtn=null, modelSearch=null, modelFilterFree=null, modelFilterAll=null, modelList=null, btnRefreshModels=null, modelCatalogError=null;
  let costConfirm=null, costConfirmText=null, btnCostCancel=null, btnCostConfirm=null;

  // LearnSmart managed session panel (Phase 6: configuration display only)
  let managedPanel=null, managedStatusLine=null, managedModelRow=null, managedModelPickerBtn=null, managedModelLabel=null;
  let managedLimitRow=null, managedLimitLabel=null, managedActionsRow=null, managedRetryBtn=null, managedSignoutBtn=null;

  let allFiles=[], displayedCount=0, BATCH_SIZE=100, isLoadingFiles=false, isLoadingPreview=false, selectedFileId=null;
  let searchMode='files', isSearching=false, latestSearchRequestId=0, nextSearchRequestId=0;
  let nextChatRequestId=0, latestChatRequestId=0, isChatActive=false;

  // Phase 10A: agent shell
  let slashPopup=null, slashPopupList=null;
  let agentMode='ask';
  let activeAgentMode='ask';
  let slashPopupCommands=[]; // safe description array (host-provided)

  // Streaming DOM state: exactly ONE assistant node per active stream.
  let streamMsg=null, streamBody=null, streamTextNode=null, streamCaret=null, streamText='';
  let userNearBottom=true;

  // Multi-provider state (populated by host; never contains secrets)
  let providers=[], selectedProvider='openrouter', selectedModelId='openrouter/free';
  let catalogs={};
  let modelFilter='free';
  let pendingConfirmation=null;
  // Explicit attachment draft state (metadata only; bytes stay host-side).
  let pendingChips=[];
  let chipThumbs={};
  let pendingSendText='';
  let pendingSendMeta=[];
  let currentWorkspaceInfo=null;
  let settingsView='settingsHome';
  let settingsParent='settingsHome';
  let onboardingComplete=false;
  // Phase 7 Change 1: authoritative UI mode. 'learnsmart'|'byok'|'free'|null
  // (null until init). This — not identity — is the primary BYOK/UI gate,
  // so LearnSmart mode hides BYOK even while identity restore is pending.
  let currentAccessMode=null;

  // LearnSmart managed session (Phase 6: safe configuration snapshot only —
  // status, display fields, backend-safe models, selected key, limit).
  let managedSession=null;
  var MANAGED_SEND_DISABLED_TEXT='Managed chat will be enabled in the next SUBI phase.';
  // Phase 8 production gate mirror (host MANAGED_CHAT_ENABLED, false until
  // Phase 9 quota enforcement). The webview keeps Send disabled in
  // LearnSmart mode regardless; this flag only ever enables it when the
  // host explicitly reports availability. No user toggle exists.
  let managedChatAvailable=false;

  const FALLBACK_PROVIDERS=[
    { id:'openrouter', label:'OpenRouter', configured:false },
    { id:'openai', label:'OpenAI', configured:false },
    { id:'anthropic', label:'Anthropic / Claude', configured:false },
    { id:'google', label:'Google Gemini', configured:false },
    { id:'deepseek', label:'DeepSeek', configured:false }
  ];

  function init(){
    onboardingSection=document.getElementById('onboarding-section');
    onboardingWelcome=document.getElementById('onboarding-welcome');
    onboardingLearnSmart=document.getElementById('onboarding-learnsmart');
    onboardingFree=document.getElementById('onboarding-free');
    onboardingByok=document.getElementById('onboarding-byok');
    onboardingLoading=document.getElementById('onboarding-loading');
    onboardingError=document.getElementById('onboarding-error');
    btnLearnSmart=document.getElementById('btn-learnsmart');
    btnFree=document.getElementById('btn-free');
    btnByok=document.getElementById('btn-byok');
    btnLearnSmartSignIn=document.getElementById('btn-learnsmart-signin');
    btnFreeContinue=document.getElementById('btn-free-continue');
    btnByokConfigure=document.getElementById('btn-byok-configure');
    byokProviderSelect=document.getElementById('byok-provider-select');
    btnBackLearnSmart=document.getElementById('btn-back-learnsmart');
    btnBackFree=document.getElementById('btn-back-free');
    btnBackFreeAlt=document.getElementById('btn-back-free-alt');
    btnBackByok=document.getElementById('btn-back-byok');
    btnBackByokAlt=document.getElementById('btn-back-byok-alt');
    btnErrorBack=document.getElementById('btn-error-back');
    learnSmartEmail=document.getElementById('learnsmart-email');
    learnSmartPassword=document.getElementById('learnsmart-password');
    learnSmartForm=document.getElementById('learnsmart-form');
    learnSmartMessage=document.getElementById('learnsmart-message');
    settingsAccountSummary=document.getElementById('settings-account-summary');
    btnAccountSignout=document.getElementById('btn-account-signout');
    errorMessage=document.getElementById('error-message');
    loadingMessage=document.getElementById('loading-message');

    topbar=document.getElementById('topbar');
    topbarProject=document.getElementById('topbar-project');
    btnSettings=document.getElementById('btn-settings');
    aiStatusRow=document.getElementById('ai-status-row');
    aiStatusBtn=document.getElementById('ai-status-btn');
    aiStatusLabel=document.getElementById('ai-status-label');
    mainChatView=document.getElementById('main-chat-view');
    chatEmptyState=document.getElementById('chat-empty-state');
    chatEmptyTitle=document.getElementById('chat-empty-title');
    btnEmptyConfigure=document.getElementById('btn-empty-configure');
    chatFooter=document.getElementById('chat-footer');
    btnAddContext=document.getElementById('btn-add-context');
    contextMenu=document.getElementById('context-menu');
    btnAttachFile=document.getElementById('btn-attach-file');
    btnAttachImage=document.getElementById('btn-attach-image');
    attachStrip=document.getElementById('attachment-strip');
    settingsOverlay=document.getElementById('settings-overlay');
    settingsTitle=document.getElementById('settings-title');
    btnSettingsBack=document.getElementById('btn-settings-back');
    btnSettingsClose=document.getElementById('btn-settings-close');
    settingsHome=document.getElementById('settings-home');
    viewAi=document.getElementById('view-ai');
    viewProviderPicker=document.getElementById('view-provider-picker');
    viewModelPicker=document.getElementById('view-model-picker');
    viewProject=document.getElementById('view-project');
    viewFiles=document.getElementById('view-files');
    viewSearch=document.getElementById('view-search');
    viewAbout=document.getElementById('view-about');
    settingsAiSummary=document.getElementById('settings-ai-summary');
    settingsProjectSummary=document.getElementById('settings-project-summary');
    btnResetOnboarding=document.getElementById('btn-reset-onboarding');

    projectSection=document.getElementById('project-section');
    filesSection=document.getElementById('files-section');
    searchSection=document.getElementById('search-section');
    previewSection=document.getElementById('preview-section');
    noProjectState=document.getElementById('no-project-state');
    projectCard=document.getElementById('project-card');
    projectName=document.getElementById('project-name');
    projectType=document.getElementById('project-type');
    projectPath=document.getElementById('project-path');
    projectMulti=document.getElementById('project-multi');
    loadFilesBtn=document.getElementById('load-files-btn');
    filesLoading=document.getElementById('files-loading');
    fileList=document.getElementById('file-list');
    showMoreBtn=document.getElementById('show-more-btn');
    searchInput=document.getElementById('search-input');
    searchModeFiles=document.getElementById('search-mode-files');
    searchModeContent=document.getElementById('search-mode-content');
    searchBtn=document.getElementById('search-btn');
    searchLoading=document.getElementById('search-loading');
    searchResultsContainer=document.getElementById('search-results-container');
    searchResults=document.getElementById('search-results');
    searchNoResults=document.getElementById('search-no-results');
    searchError=document.getElementById('search-error');
    previewPath=document.getElementById('preview-path');
    previewCode=document.getElementById('preview-code');
    previewLoading=document.getElementById('preview-loading');
    chatInput=document.getElementById('chat-input');
    sendBtn=document.getElementById('send-btn');
    chatMessages=document.getElementById('chat-messages');
    chatThinking=document.getElementById('chat-thinking');
    chatStatusValue=document.getElementById('chat-status-value');
    chatErrorEl=document.getElementById('chat-error');
    clearChatBtn=document.getElementById('clear-chat-btn');
    aiProviderLabel=document.getElementById('ai-provider-label');
    aiModelLabel=document.getElementById('ai-model-label');
    btnOpenProviderPicker=document.getElementById('btn-open-provider-picker');
    providerList=document.getElementById('provider-list');
    btnConfigureProvider=document.getElementById('btn-configure-provider');
    btnRemoveProviderKey=document.getElementById('btn-remove-provider-key');
    modelPickerBtn=document.getElementById('model-picker-btn');
    modelSearch=document.getElementById('model-search');
    modelFilterFree=document.getElementById('model-filter-free');
    modelFilterAll=document.getElementById('model-filter-all');
    modelList=document.getElementById('model-list');
    btnRefreshModels=document.getElementById('btn-refresh-models');
    modelCatalogError=document.getElementById('model-catalog-error');
    costConfirm=document.getElementById('cost-confirm');
    costConfirmText=document.getElementById('cost-confirm-text');
    btnCostCancel=document.getElementById('btn-cost-cancel');
    btnCostConfirm=document.getElementById('btn-cost-confirm');
    managedPanel=document.getElementById('managed-panel');
    managedStatusLine=document.getElementById('managed-status-line');
    managedModelRow=document.getElementById('managed-model-row');
    managedModelPickerBtn=document.getElementById('managed-model-picker-btn');
    managedModelLabel=document.getElementById('managed-model-label');
    managedLimitRow=document.getElementById('managed-limit-row');
    managedLimitLabel=document.getElementById('managed-limit-label');
    managedActionsRow=document.getElementById('managed-actions-row');
    managedRetryBtn=document.getElementById('managed-retry-btn');
    managedSignoutBtn=document.getElementById('managed-signout-btn');

    // Phase 10A: agent shell — slash popup elements
    slashPopup=document.getElementById('slash-popup');
    slashPopupList=document.getElementById('slash-popup-list');

    if(!chatInput || !sendBtn){ console.error('Subi: Required DOM elements not found'); return; }
    setupEventListeners();
    updateSendButtonState();
    setSearchState('idle');
    setOnboardingState('welcome');
    vscode.postMessage({ type: 'ready' });
  }

  function setupEventListeners(){
    chatInput.addEventListener('input', function(){
      // Phase 10A: detect leading slash for command mode.
      const val = this.value || '';
      // Only show command mode when input starts with "/" followed by a letter,
      // not during streaming, not in managed mode, and only when no space has
      // been typed after the command name (that implies the user is typing
      // arguments, not selecting from the popup).
      if (val.length > 0 && val[0] === '/' && val.length > 1 && /[A-Za-z]/.test(val[1]) && !isChatActive && !isLearnSmartMode()) {
        // Show slash popup
        showSlashPopup();
      } else if (slashPopup && !slashPopup.classList.contains('subi-hidden') && val.length === 0) {
        hideSlashPopup();
      }
      this.style.height='auto';
      this.style.height=Math.min(this.scrollHeight,120)+'px';
      updateSendButtonState();
    });
    chatInput.addEventListener('keydown', handleKeydown);
    sendBtn.addEventListener('click', handleSendClick);
    if(chatMessages) chatMessages.addEventListener('scroll', ()=>{ userNearBottom=isNearBottom(); });
    if(clearChatBtn) clearChatBtn.addEventListener('click', handleClearChat);
    if(loadFilesBtn) loadFilesBtn.addEventListener('click', handleLoadFiles);
    if(showMoreBtn) showMoreBtn.addEventListener('click', handleShowMore);
    if(searchInput) searchInput.addEventListener('keydown', handleSearchKeydown);
    if(searchModeFiles) searchModeFiles.addEventListener('click', ()=>setSearchMode('files'));
    if(searchModeContent) searchModeContent.addEventListener('click', ()=>setSearchMode('content'));
    if(searchBtn) searchBtn.addEventListener('click', handleSearch);
    if(btnLearnSmart) btnLearnSmart.addEventListener('click', ()=>handleSelectAccessMode('learnsmart'));
    if(btnFree) btnFree.addEventListener('click', ()=>handleSelectAccessMode('free'));
    if(btnByok) btnByok.addEventListener('click', ()=>handleSelectAccessMode('byok'));
    if(learnSmartForm) learnSmartForm.addEventListener('submit', handleLearnSmartSubmit);
    if(btnAccountSignout) btnAccountSignout.addEventListener('click', ()=>vscode.postMessage({ type:'learnsmartSignOut' }));
    if(btnBackLearnSmart) btnBackLearnSmart.addEventListener('click', handleBackToWelcome);
    if(btnBackFree) btnBackFree.addEventListener('click', handleBackToWelcome);
    if(btnBackFreeAlt) btnBackFreeAlt.addEventListener('click', handleBackToWelcome);
    if(btnByokConfigure) btnByokConfigure.addEventListener('click', handleByokConfigure);
    if(btnBackByok) btnBackByok.addEventListener('click', handleBackToWelcome);
    if(btnBackByokAlt) btnBackByokAlt.addEventListener('click', handleBackToWelcome);
    if(btnErrorBack) btnErrorBack.addEventListener('click', handleBackToWelcome);
    if(btnFreeContinue) btnFreeContinue.addEventListener('click', handleFreeContinue);
    if(btnOpenProviderPicker) btnOpenProviderPicker.addEventListener('click', ()=>{ if(!isChatActive) openProviderPicker(); });
    if(btnConfigureProvider) btnConfigureProvider.addEventListener('click', handleConfigureProvider);
    if(btnRemoveProviderKey) btnRemoveProviderKey.addEventListener('click', handleRemoveProviderKey);
    if(modelPickerBtn) modelPickerBtn.addEventListener('click', ()=>{ if(!isChatActive) openModelPicker(); });
    if(modelSearch) modelSearch.addEventListener('input', function(){ if(isLearnSmartMode()){ renderManagedModelList(); } else { renderModelList(); } });
    if(modelFilterFree) modelFilterFree.addEventListener('click', ()=>setModelFilter('free'));
    if(modelFilterAll) modelFilterAll.addEventListener('click', ()=>setModelFilter('all'));
    if(btnRefreshModels) btnRefreshModels.addEventListener('click', handleRefreshModels);
    if(managedModelPickerBtn) managedModelPickerBtn.addEventListener('click', ()=>{ if(!isChatActive) openModelPicker(); });
    if(managedRetryBtn) managedRetryBtn.addEventListener('click', ()=>vscode.postMessage({ type: 'retryManagedSession' }));
    if(managedSignoutBtn) managedSignoutBtn.addEventListener('click', ()=>vscode.postMessage({ type: 'learnsmartSignOut' }));
    if(btnCostCancel) btnCostCancel.addEventListener('click', ()=>handleCostDecision(false));
    if(btnCostConfirm) btnCostConfirm.addEventListener('click', ()=>handleCostDecision(true));
    if(btnResetOnboarding) btnResetOnboarding.addEventListener('click', ()=>vscode.postMessage({ type: 'resetOnboarding' }));
    // Chat-first shell navigation (client-side only; no state loss)
    if(btnSettings) btnSettings.addEventListener('click', ()=>openSettings('settingsHome'));
    if(aiStatusBtn) aiStatusBtn.addEventListener('click', ()=>openModelPicker());
    if(btnSettingsClose) btnSettingsClose.addEventListener('click', closeSettings);
    if(btnSettingsBack) btnSettingsBack.addEventListener('click', ()=>showSettingsView(settingsParent));
    document.querySelectorAll('[data-nav]').forEach((el)=>{
      el.addEventListener('click', ()=>showSettingsView(el.getAttribute('data-nav')));
    });
    if(btnEmptyConfigure) btnEmptyConfigure.addEventListener('click', ()=>{
      vscode.postMessage({ type: 'configureProvider', provider: selectedProvider });
    });
    if(btnAddContext) btnAddContext.addEventListener('click', (e)=>{ e.stopPropagation(); toggleContextMenu(); });
    if(btnAttachFile) btnAttachFile.addEventListener('click', ()=>{ hideContextMenu(); vscode.postMessage({ type: 'requestAttachProjectFiles' }); });
    if(btnAttachImage) btnAttachImage.addEventListener('click', ()=>{ hideContextMenu(); vscode.postMessage({ type: 'requestAttachImages' }); });
    document.addEventListener('click', (e)=>{
      if(contextMenu && !contextMenu.classList.contains('subi-hidden')){
        const t=e.target;
        if(t!==btnAddContext && !contextMenu.contains(t)) hideContextMenu();
      }
    });
    document.addEventListener('keydown', (e)=>{
      if(e.key==='Escape' && settingsOverlay && !settingsOverlay.classList.contains('subi-hidden') && onboardingComplete){
        closeSettings();
      }
    });
  }

  // ---- settings navigation (pure client-side; preserves chat/project state) ----
  const SETTINGS_TITLES = {
    settingsHome: 'Settings',
    aiSettings: 'AI',
    providerPicker: 'Select Provider',
    modelPicker: 'Select Model',
    projectSettings: 'Project',
    projectFiles: 'Project files',
    projectSearch: 'Search project',
    about: 'About Subi'
  };
  const SETTINGS_PARENTS = {
    providerPicker: 'aiSettings',
    modelPicker: 'aiSettings'
  };

  function openSettings(view){
    if(!onboardingComplete) return;
    showSettingsView(view || 'settingsHome');
    if(settingsOverlay) settingsOverlay.classList.remove('subi-hidden');
  }

  function closeSettings(){
    if(settingsOverlay) settingsOverlay.classList.add('subi-hidden');
    settingsView='settingsHome';
    settingsParent='settingsHome';
  }

  function showSettingsView(view){
    view = view || 'settingsHome';
    // BYOK-only views are unreachable in LearnSmart mode (Change 1).
    if(isLearnSmartMode() && (view==='aiSettings' || view==='providerPicker')){
      view = 'settingsHome';
    }
    settingsParent = SETTINGS_PARENTS[view] || 'settingsHome';
    settingsView = view;
    const map = {
      settingsHome: settingsHome,
      aiSettings: viewAi,
      providerPicker: viewProviderPicker,
      modelPicker: viewModelPicker,
      projectSettings: viewProject,
      projectFiles: viewFiles,
      projectSearch: viewSearch,
      about: viewAbout
    };
    Object.keys(map).forEach((k)=>{
      const el = map[k];
      if(el) el.classList.toggle('subi-hidden', k!==settingsView);
    });
    if(settingsTitle) settingsTitle.textContent = SETTINGS_TITLES[settingsView] || 'Settings';
    if(btnSettingsBack) btnSettingsBack.style.visibility = settingsView==='settingsHome' ? 'hidden' : 'visible';
    if(settingsOverlay) settingsOverlay.classList.remove('subi-hidden');
  }

  // ---- slash command popup (Phase 10A) ----
  function showSlashPopup(){
    if(slashPopup && slashPopupList) {
      renderSlashPopup(slashPopupCommands);
      slashPopup.classList.remove('subi-hidden');
    }
  }
  function hideSlashPopup(){
    if(slashPopup) slashPopup.classList.add('subi-hidden');
  }
  function renderSlashPopup(list){
    if(!slashPopupList) return;
    slashPopupList.innerHTML='';
    if(!Array.isArray(list) || list.length===0) return;
    for(const cmd of list){
      if(!cmd || typeof cmd.name!=='string') continue;
      const btn=document.createElement('button');
      btn.type='button';
      btn.className='subi-slash-popup-item' + (cmd.locked ? ' subi-slash-locked' : '');
      btn.setAttribute('data-cmd', cmd.name);
      btn.innerHTML='<span class="subi-slash-cmd-name">'+cmd.name+'</span><span class="subi-slash-cmd-desc">'+(cmd.description||'')+'</span>';
      if(cmd.locked){
        btn.innerHTML+='<span class="subi-slash-badge">Locked</span>';
      }
      btn.addEventListener('click', function(){
        hideSlashPopup();
        const name = btn.getAttribute('data-cmd');
        // The argument is whatever remains in the input after the command.
        // For Phase 10A the webview sends only name + argument to the host.
        // The host dispatcher resolves the command and invokes the tool.
        vscode.postMessage({ type: 'executeSlashCommand', name, argument: '' });
      });
      slashPopupList.appendChild(btn);
    }
  }
  function settingsVisible(){
    return settingsOverlay && !settingsOverlay.classList.contains('subi-hidden');
  }

  function toggleContextMenu(){ if(contextMenu) contextMenu.classList.toggle('subi-hidden'); }
  function hideContextMenu(){ if(contextMenu) contextMenu.classList.add('subi-hidden'); }

  // ---- explicit attachments (metadata only; opaque IDs authorize host reads) ----
  function handleAttachmentsAdded(list){
    if(!Array.isArray(list)) return;
    for(const a of list){
      if(!a || typeof a.id!=='string') continue;
      if(!pendingChips.some(c=>c.id===a.id)) pendingChips.push(a);
    }
    renderStrip();
  }
  function handleAttachmentRemoved(id){
    pendingChips=pendingChips.filter(c=>c.id!==id);
    renderStrip();
  }
  function handleAttachmentsSync(list){
    pendingChips=Array.isArray(list) ? list.filter(a=>a && typeof a.id==='string') : [];
    renderStrip();
  }
  function handleAttachmentThumbnail(id, dataUrl){
    // Host-generated previews only; never accept markup or SVG.
    if(typeof id==='string' && typeof dataUrl==='string' && dataUrl.indexOf('data:image/')===0 && dataUrl.indexOf('svg')===-1){
      chipThumbs[id]=dataUrl;
      renderStrip();
    }
  }
  function handleAttachmentError(error){
    const msg=error && error.message ? error.message : 'Attachment failed.';
    showChatError(msg);
  }
  function renderStrip(){
    if(!attachStrip) return;
    attachStrip.innerHTML='';
    if(pendingChips.length===0){ attachStrip.classList.add('subi-hidden'); return; }
    attachStrip.classList.remove('subi-hidden');
    for(const a of pendingChips){
      const chip=document.createElement('span');
      chip.className='subi-chip'+(a.kind==='image' ? ' subi-chip-image' : '');
      if(a.kind==='image' && chipThumbs[a.id]){
        const img=document.createElement('img');
        img.className='subi-chip-thumb';
        img.alt=a.name;
        img.src=chipThumbs[a.id];
        chip.appendChild(img);
      } else {
        const icon=document.createElement('span');
        icon.className='subi-chip-icon';
        icon.textContent=a.kind==='image' ? '🖼' : '📄';
        chip.appendChild(icon);
      }
      const name=document.createElement('span');
      name.className='subi-chip-name';
      name.textContent=a.name;
      chip.appendChild(name);
      const x=document.createElement('button');
      x.type='button';
      x.className='subi-chip-x';
      x.textContent='×';
      x.setAttribute('aria-label','Remove attachment '+a.name);
      x.addEventListener('click', ()=>vscode.postMessage({ type: 'removeChatAttachment', attachmentId: a.id }));
      chip.appendChild(x);
    }
  }

  function handleKeydown(event){
    if(event.key==='Enter' && !event.shiftKey){
      event.preventDefault();
      // During streaming Enter must NOT submit the next draft.
      if(!isChatActive && !sendBtn.disabled) handleSend();
    }
  }

  function handleSendClick(){
    if(isLearnSmartMode()){
      showChatError(MANAGED_SEND_DISABLED_TEXT);
      return;
    }
    if(isChatActive){
      vscode.postMessage({ type: 'cancelChat', requestId: latestChatRequestId });
      return;
    }
    handleSend();
  }

  function handleSend(){
    if(isChatActive) return;
    // Managed users have no inference yet: never enter the BYOK pipeline.
    // Gated on access mode so the restore window stays shut too.
    if(isLearnSmartMode()){
      showChatError(MANAGED_SEND_DISABLED_TEXT);
      return;
    }
    const text=chatInput.value;
    const trimmed=text.trim();
    if(!trimmed) return;
    if(trimmed.length>20000){ showChatError('Message exceeds maximum length of 20,000 characters.'); return; }
    const requestId=++nextChatRequestId;
    latestChatRequestId=requestId;
    // Freeze the send snapshot; input + chips clear only on accept (chatStreamStarted),
    // so preflight failures keep the draft and create no chat turn.
    pendingSendText=trimmed;
    pendingSendMeta=pendingChips.slice();
    setStreamingUI(true);
    hideChatError();
    userNearBottom=true;
    ensureStreamMessage();
    scrollToBottom();
    vscode.postMessage({ type: 'sendMessage', requestId, provider: selectedProvider, modelId: selectedModelId, text: trimmed, attachmentIds: pendingChips.map(c=>c.id) });
  }

  function handleClearChat(){
    vscode.postMessage({ type: 'clearChat' });
  }

  function handleConfigureProvider(){
    if(isChatActive) return;
    if(isLearnSmartMode()) return;
    vscode.postMessage({ type: 'configureProvider', provider: selectedProvider });
  }

  function handleRemoveProviderKey(){
    if(isChatActive) return;
    if(isLearnSmartMode()) return;
    vscode.postMessage({ type: 'removeProviderKey', provider: selectedProvider });
  }

  function openProviderPicker(){
    if(isLearnSmartMode()) return;
    renderProviderList();
    showSettingsView('providerPicker');
  }

  function openModelPicker(){
    // LearnSmart MODE: picker source is ONLY the safe managed list, even
    // while identity restore is still pending.
    if(isLearnSmartMode()){
      showSettingsView('modelPicker');
      renderManagedModelList();
      return;
    }
    showSettingsView('modelPicker');
    vscode.postMessage({ type: 'requestModelCatalog', provider: selectedProvider });
    renderModelList();
  }

  function setModelFilter(f){
    modelFilter=f;
    if(modelFilterFree) modelFilterFree.classList.toggle('subi-active', f==='free');
    if(modelFilterAll) modelFilterAll.classList.toggle('subi-active', f==='all');
    renderModelList();
  }

  function handleRefreshModels(){
    // LearnSmart MODE: refresh means a fresh managed bootstrap.
    if(isLearnSmartMode()){
      vscode.postMessage({ type: 'retryManagedSession' });
      return;
    }
    vscode.postMessage({ type: 'refreshModelCatalog', provider: selectedProvider });
  }

  // Managed model picker: renders ONLY backend-safe records (modelKey,
  // displayName). No provider, cost, or upstream identifiers ever appear.
  function renderManagedModelList(){
    if(!modelList) return;
    modelList.innerHTML='';
    var models = (managedSession && Array.isArray(managedSession.models)) ? managedSession.models : [];
    var q = modelSearch ? modelSearch.value : '';
    var ql = q.trim().toLowerCase();
    var filtered = models.filter(function(m){
      if(!m || typeof m.modelKey!=='string' || typeof m.displayName!=='string') return false;
      if(ql && m.displayName.toLowerCase().indexOf(ql)<0 && m.modelKey.toLowerCase().indexOf(ql)<0) return false;
      return true;
    });
    for(var i=0;i<filtered.length && i<200;i++){
      (function(m){
        var b=document.createElement('button');
        b.type='button';
        b.className='subi-pick-row';
        var main=document.createElement('span');
        main.className='subi-pick-main';
        var label=document.createElement('span');
        label.className='subi-pick-name';
        label.textContent=m.displayName;
        var desc=document.createElement('span');
        desc.className='subi-pick-id';
        desc.textContent=m.modelKey;
        main.appendChild(label);
        main.appendChild(desc);
        b.appendChild(main);
        var badge=document.createElement('span');
        badge.className='subi-pick-badge subi-pick-ok';
        badge.textContent='MANAGED';
        b.appendChild(badge);
        if(managedSession && m.modelKey===managedSession.selectedModelKey){
          b.classList.add('subi-pick-selected');
          var check=document.createElement('span');
          check.className='subi-pick-check';
          check.textContent='✓';
          b.appendChild(check);
        }
        b.addEventListener('click', function(){
          if(isChatActive) return;
          vscode.postMessage({ type: 'setManagedModel', modelKey: m.modelKey });
        });
        modelList.appendChild(b);
      })(filtered[i]);
    }
    if(filtered.length===0){
      var d=document.createElement('div');
      d.className='subi-empty-state';
      d.textContent = models.length===0 ? 'No SUBI models are currently available for your account.' : 'No models found.';
      modelList.appendChild(d);
    }
  }

  function handleCostDecision(confirmed){
    if(!pendingConfirmation) return;
    const pc = pendingConfirmation;
    pendingConfirmation=null;
    if(costConfirm) costConfirm.classList.add('subi-hidden');
    vscode.postMessage({ type: 'confirmModelCost', provider: pc.provider, modelId: pc.modelId, confirmed });
  }

  function setStreamingUI(active){
    isChatActive=active;
    if(chatThinking) chatThinking.classList.add('subi-hidden');
    updateSendButtonState();
  }

  function updateSendButtonState(){
    if(isChatActive){
      // Streaming: textarea stays editable for the next draft; Send becomes Stop.
      sendBtn.disabled=false;
      sendBtn.textContent='■';
      sendBtn.setAttribute('aria-label','Stop generating');
      sendBtn.title='Stop generating';
      sendBtn.classList.add('subi-stop');
    } else if(isLearnSmartMode()){
      // LearnSmart mode: Send stays disabled while managedChatAvailable is
      // false (Phase 8 production gate; Phase 9 quota enforcement flips the
      // host capability). The host also rejects any sendMessage in this mode.
      sendBtn.disabled=true;
      sendBtn.textContent='↑';
      sendBtn.setAttribute('aria-label',MANAGED_SEND_DISABLED_TEXT);
      sendBtn.title=MANAGED_SEND_DISABLED_TEXT;
      sendBtn.classList.remove('subi-stop');
    } else {
      const hasText=chatInput.value.trim().length>0;
      sendBtn.disabled = !hasText;
      sendBtn.textContent='↑';
      sendBtn.setAttribute('aria-label','Send message');
      sendBtn.title='Send message';
      sendBtn.classList.remove('subi-stop');
    }
    if(chatInput) chatInput.disabled = false;
    if(btnOpenProviderPicker) btnOpenProviderPicker.disabled = isChatActive;
    if(modelPickerBtn) modelPickerBtn.disabled = isChatActive;
    if(btnConfigureProvider) btnConfigureProvider.disabled = isChatActive;
    if(btnRemoveProviderKey) btnRemoveProviderKey.disabled = isChatActive;
  }

  function setChatThinking(active){
    isChatActive=active;
    if(chatThinking) chatThinking.classList.toggle('subi-hidden', !active);
    updateSendButtonState();
  }

  // ---- message DOM (safe text rendering only) ----
  function appendChatMessage(role, content){
    if(!chatMessages) return;
    if(chatEmptyState) chatEmptyState.classList.add('subi-hidden');
    const wrapper=document.createElement('div');
    wrapper.className='subi-chat-message subi-chat-'+role;
    const label=document.createElement('div');
    label.className='subi-chat-role';
    label.textContent = role==='user' ? 'YOU' : 'SUBI';
    const body=document.createElement('div');
    body.className='subi-chat-content';
    if(window.SUBI_MD){
      try { window.SUBI_MD.renderToElement(body, content); }
      catch (_) { body.textContent = content; }
    } else {
      body.textContent = content;
    }
    wrapper.appendChild(label);
    wrapper.appendChild(body);
    chatMessages.appendChild(wrapper);
    userNearBottom=true;
    scrollToBottom();
  }

  function appendUserMessageWithAttachments(text, meta){
    if(!chatMessages || !text) return;
    if(chatEmptyState) chatEmptyState.classList.add('subi-hidden');
    const wrapper=document.createElement('div');
    wrapper.className='subi-chat-message subi-chat-user';
    const label=document.createElement('div');
    label.className='subi-chat-role';
    label.textContent='YOU';
    const body=document.createElement('div');
    body.className='subi-chat-content';
    body.textContent=text;
    wrapper.appendChild(label);
    wrapper.appendChild(body);
    for(const a of meta || []){
      if(a.kind==='image' && chipThumbs[a.id]){
        const img=document.createElement('img');
        img.className='subi-sent-thumb';
        img.alt=a.name;
        img.src=chipThumbs[a.id];
        wrapper.appendChild(img);
      }
      const line=document.createElement('div');
      line.className='subi-attach-meta';
      line.textContent=(a.kind==='image' ? '🖼 ' : '📄 ')+a.name;
      wrapper.appendChild(line);
    }
    chatMessages.appendChild(wrapper);
    userNearBottom=true;
    scrollToBottom();
  }

  function ensureStreamMessage(){
    if(streamMsg || !chatMessages) return;
    if(chatEmptyState) chatEmptyState.classList.add('subi-hidden');
    const wrapper=document.createElement('div');
    wrapper.className='subi-chat-message subi-chat-assistant subi-chat-streaming';
    const label=document.createElement('div');
    label.className='subi-chat-role';
    label.textContent='SUBI';
    const body=document.createElement('div');
    body.className='subi-chat-content';
    const textNode=document.createTextNode('');
    const caret=document.createElement('span');
    caret.className='subi-stream-caret';
    caret.setAttribute('aria-hidden','true');
    caret.textContent='▋';
    body.appendChild(textNode);
    body.appendChild(caret);
    wrapper.appendChild(label);
    wrapper.appendChild(body);
    chatMessages.appendChild(wrapper);
    streamMsg=wrapper; streamBody=body; streamTextNode=textNode; streamCaret=caret; streamText='';
  }

  function appendStreamDelta(delta){
    ensureStreamMessage();
    if(!streamTextNode) return;
    const stick=isNearBottom();
    // Text-node append only: streamed HTML displays literally, never parsed.
    streamTextNode.data += delta;
    streamText += delta;
    if(stick) scrollToBottom(); else userNearBottom=false;
  }

  function appendStreamNote(text){
    if(!streamMsg) return;
    const note=document.createElement('div');
    note.className='subi-stream-note';
    note.textContent=text;
    streamMsg.appendChild(note);
  }

  // Returns true when a visible partial message was kept.
  function endStreamMessage(outcome, meta){
    if(streamCaret && streamCaret.parentNode) streamCaret.parentNode.removeChild(streamCaret);
    streamCaret=null;
    const hadText = streamText.length>0;
    if(!hadText && streamMsg){
      streamMsg.remove();
    } else if(hadText && streamMsg){
      // Re-render the finalized streamed text as markdown (with math + code highlighting).
      if(streamBody && window.SUBI_MD){
        try { window.SUBI_MD.renderToElement(streamBody, streamText); }
        catch (_) { streamBody.textContent = streamText; }
      }
      if(outcome==='stopped') appendStreamNote('Stopped');
      else if(outcome==='interrupted') appendStreamNote('Response interrupted.');
      else if(outcome==='done' && meta && meta!==selectedModelId) appendStreamNote('via '+meta);
    }
    streamMsg=null; streamBody=null; streamTextNode=null; streamText='';
    scrollToBottom();
    return hadText;
  }

  function isNearBottom(){
    if(!chatMessages) return true;
    return (chatMessages.scrollHeight - (chatMessages.scrollTop + chatMessages.clientHeight)) < 48;
  }

  function scrollToBottom(){
    if(chatMessages){ chatMessages.scrollTop=chatMessages.scrollHeight; userNearBottom=true; }
  }

  function showChatError(message){
    if(!chatErrorEl) return;
    chatErrorEl.textContent=message;
    chatErrorEl.classList.remove('subi-hidden');
  }
  function hideChatError(){
    if(chatErrorEl){ chatErrorEl.textContent=''; chatErrorEl.classList.add('subi-hidden'); }
  }
  function clearChatUI(){
    if(chatMessages) chatMessages.innerHTML='';
    streamMsg=null; streamBody=null; streamTextNode=null; streamCaret=null; streamText='';
    hideChatError();
    setStreamingUI(false);
    syncEmptyState();
  }

  // ---- stream protocol handlers ----
  function handleStreamStarted(requestId){
    if(requestId!==latestChatRequestId) return;
    // Accept: render the frozen user turn, then clear input + composer chips.
    appendUserMessageWithAttachments(pendingSendText, pendingSendMeta);
    pendingSendText=''; pendingSendMeta=[];
    chatInput.value=''; chatInput.style.height='auto'; updateSendButtonState();
    pendingChips=[]; renderStrip();
    ensureStreamMessage();
    scrollToBottom();
  }
  function handleStreamDelta(requestId, delta){
    if(requestId!==latestChatRequestId) return;
    appendStreamDelta(delta);
  }
  function handleStreamCompleted(requestId, provider, modelId, actualModelId){
    if(requestId!==latestChatRequestId) return;
    endStreamMessage('done', actualModelId);
    setStreamingUI(false);
  }
  function handleStreamError(requestId, error){
    if(requestId!==latestChatRequestId) return;
    const msg = error && error.message ? error.message : 'An error occurred.';
    if(error && error.type==='confirmationRequired'){
      // Cost gate UI is shown separately; no error box duplication.
      endStreamMessage('error', null);
      setStreamingUI(false);
      return;
    }
    const kept = endStreamMessage('error', null);
    setStreamingUI(false);
    if(!kept) showChatError(msg);
  }
  function handleStreamCancelled(requestId){
    if(requestId!==latestChatRequestId) return;
    endStreamMessage('stopped', null);
    setStreamingUI(false);
  }

  function handleChatStarted(requestId){
    if(requestId!==latestChatRequestId) return;
    setChatThinking(true);
  }
  function handleChatResponse(requestId, content){
    if(requestId!==latestChatRequestId) return;
    setChatThinking(false);
    appendChatMessage('assistant', content);
  }
  function handleChatError(requestId, error){
    if(requestId!==latestChatRequestId) return;
    setChatThinking(false);
    const msg = error && error.message ? error.message : 'An error occurred.';
    showChatError(msg);
  }
  function handleChatHistoryCleared(){
    chipThumbs={};
    clearChatUI();
  }

  // ---- provider / catalog rendering (all remote text via textContent) ----
  function handleInit(payload){
    if(!payload) return;
    // Authoritative UI mode arrives with init, before identity restore.
    if(payload.accessMode==='learnsmart' || payload.accessMode==='byok' || payload.accessMode==='free'){
      currentAccessMode=payload.accessMode;
    } else if(payload.accessMode===null || payload.accessMode===undefined){
      currentAccessMode=null;
    }
    if(payload.providers) providers=payload.providers;
    if(payload.selection){
      selectedProvider=payload.selection.provider;
      selectedModelId=payload.selection.modelId;
    }
    // Phase 8 production gate mirror (false until Phase 9). Send stays
    // disabled in LearnSmart mode while this is false.
    managedChatAvailable = payload.managedChatAvailable===true;
    applyModeVisibility();
    syncProviderUI();
  }

  function handleProviderStatus(payload){
    if(!payload) return;
    if(payload.providers) providers=payload.providers;
    if(payload.selectedProvider) selectedProvider=payload.selectedProvider;
    if(payload.selectedModelId) selectedModelId=payload.selectedModelId;
    syncProviderUI();
  }

  function isSelectedConfigured(){
    return providers.some(p=>p.id===selectedProvider && p.configured);
  }

  function syncEmptyState(){
    if(!chatEmptyState || !chatMessages) return;
    if(!onboardingComplete){ chatEmptyState.classList.add('subi-hidden'); return; }
    const configured = isSelectedConfigured();
    const hasMessages = chatMessages.childElementCount>0;
    if(hasMessages){ chatEmptyState.classList.add('subi-hidden'); return; }
    // LearnSmart MODE owns the empty state even before identity restores:
    // never flash BYOK setup while accessMode is learnsmart.
    if(isLearnSmartMode() && !isLearnSmartIdentity()){
      chatEmptyState.classList.remove('subi-hidden');
      if(btnEmptyConfigure) btnEmptyConfigure.classList.add('subi-hidden');
      if(chatEmptyTitle) chatEmptyTitle.textContent='Restoring your LearnSmart session…';
      return;
    }
    // LearnSmart managed mode owns the empty state: no BYOK configure CTA.
    if(isLearnSmartIdentity()){
      chatEmptyState.classList.remove('subi-hidden');
      if(btnEmptyConfigure) btnEmptyConfigure.classList.add('subi-hidden');
      if(chatEmptyTitle){
        if(!managedSession || managedSession.status==='loading' || managedSession.status==='idle'){
          chatEmptyTitle.textContent='Checking your SUBI access…';
        } else if(managedSession.status==='blocked'){
          chatEmptyTitle.textContent='SUBI access is currently disabled for your account.';
        } else if(managedSession.status==='unavailable'){
          chatEmptyTitle.textContent='SUBI is temporarily unavailable.';
        } else if(!managedSession.models || managedSession.models.length===0){
          chatEmptyTitle.textContent='No SUBI models are currently available for your account.';
        } else {
          chatEmptyTitle.textContent=MANAGED_SEND_DISABLED_TEXT;
        }
      }
      return;
    }
    chatEmptyState.classList.remove('subi-hidden');
    if(!configured){
      if(chatEmptyTitle) chatEmptyTitle.textContent='Connect an AI provider to start chatting.';
      if(btnEmptyConfigure) btnEmptyConfigure.classList.remove('subi-hidden');
    } else {
      if(chatEmptyTitle) chatEmptyTitle.textContent='What are you building?';
      if(btnEmptyConfigure) btnEmptyConfigure.classList.add('subi-hidden');
    }
  }

  function syncProviderUI(){
    if(byokProviderSelect) byokProviderSelect.value=selectedProvider;
    const configured = isSelectedConfigured();
    const label = providerLabel(selectedProvider);
    if(chatStatusValue){
      chatStatusValue.textContent = configured ? (label+' • Configured') : (label+' • Not configured');
    }
    const item = findSelectedItem();
    const modelLabel = item ? item.label : selectedModelId;
    if(aiStatusLabel){
      aiStatusLabel.textContent = configured ? (label+' • '+modelLabel) : (label+' • Not configured');
    }
    if(aiProviderLabel) aiProviderLabel.textContent = label;
    if(aiModelLabel){ aiModelLabel.textContent = modelLabel; }
    if(modelPickerBtn){ modelPickerBtn.title = selectedModelId; }
    if(settingsAiSummary){
      settingsAiSummary.textContent = configured ? (label+' • '+modelLabel) : (label+' • Not configured');
    }
    if(settingsView==='providerPicker' && settingsVisible()) renderProviderList();
    syncEmptyState();
    updateChatEnabledState(configured);
    // Managed labels win while a LearnSmart session is active; BYOK labels
    // resume automatically after sign-out (managedSession cleared).
    if(isLearnSmartIdentity()){ syncManagedLabels(); }
  }

  function providerLabel(id){
    const found = providers.find(p=>p.id===id);
    if(found) return found.label;
    const fb = FALLBACK_PROVIDERS.find(p=>p.id===id);
    return fb ? fb.label : id;
  }

  function findSelectedItem(){
    const list = catalogs[selectedProvider] || [];
    return list.find(m=>m.modelId===selectedModelId);
  }

  function updateChatEnabledState(configured){
    if(modelPickerBtn) modelPickerBtn.disabled = isChatActive || !configured;
    if(btnOpenProviderPicker) btnOpenProviderPicker.disabled = isChatActive;
    // LearnSmart mode: BYOK entry points stay shut from accessMode alone
    // (identity may still be restoring); the managed picker (rendered from
    // the safe backend list) is the only selector.
    if(isLearnSmartMode()){
      var managedOk = !!(managedSession && managedSession.status==='allowed');
      if(modelPickerBtn) modelPickerBtn.disabled = isChatActive || !managedOk;
      if(btnOpenProviderPicker) btnOpenProviderPicker.disabled = true;
      if(btnConfigureProvider) btnConfigureProvider.disabled = true;
      if(btnRemoveProviderKey) btnRemoveProviderKey.disabled = true;
    } else {
      if(btnConfigureProvider) btnConfigureProvider.disabled = false;
      if(btnRemoveProviderKey) btnRemoveProviderKey.disabled = false;
    }
    updateSendButtonState();
  }

  function renderProviderList(){
    if(!providerList) return;
    providerList.innerHTML='';
    const rows = providers.length>0 ? providers : FALLBACK_PROVIDERS;
    for(const p of rows){
      const b=document.createElement('button');
      b.type='button';
      b.className='subi-pick-row';
      const name=document.createElement('span');
      name.className='subi-pick-name';
      name.textContent=p.label;
      const status=document.createElement('span');
      status.className='subi-pick-badge'+(p.configured ? ' subi-pick-ok' : '');
      status.textContent=p.configured ? 'Configured' : 'Not configured';
      b.appendChild(name);
      b.appendChild(status);
      if(p.id===selectedProvider) b.classList.add('subi-pick-selected');
      b.addEventListener('click', ()=>{
        if(isChatActive) return;
        if(p.configured){
          vscode.postMessage({ type: 'setProvider', provider: p.id });
          vscode.postMessage({ type: 'requestModelCatalog', provider: p.id });
          showSettingsView('aiSettings');
        } else {
          vscode.postMessage({ type: 'configureProvider', provider: p.id });
        }
      });
      providerList.appendChild(b);
    }
  }

  function handleModelCatalog(provider, models){
    catalogs[provider]=models;
    if(provider===selectedProvider) renderModelList();
    syncProviderUI();
    if(modelCatalogError) modelCatalogError.classList.add('subi-hidden');
  }

  function handleModelCatalogError(provider, message){
    if(provider!==selectedProvider || !modelCatalogError) return;
    modelCatalogError.textContent=message;
    modelCatalogError.classList.remove('subi-hidden');
  }

  function renderModelList(){
    if(!modelList) return;
    modelList.innerHTML='';
    const q = modelSearch ? modelSearch.value : '';
    const all = catalogs[selectedProvider] || [];
    const ql = q.trim().toLowerCase();
    let filtered = all.filter(m=>{
      if(ql && !(m.label.toLowerCase().includes(ql) || m.modelId.toLowerCase().includes(ql))) return false;
      if(modelFilter==='free') return m.costClass==='free';
      return true;
    });
    const groups = [
      { title: 'AUTO', items: filtered.filter(m=>m.source==='builtin') },
      { title: 'FREE', items: filtered.filter(m=>m.source!=='builtin' && m.costClass==='free') },
      { title: 'MAY COST', items: filtered.filter(m=>m.costClass==='paid' || m.costClass==='unknown') },
    ];
    for(const g of groups){
      if(g.items.length===0) continue;
      const h=document.createElement('div');
      h.className='subi-section-title';
      h.textContent=g.title;
      modelList.appendChild(h);
      for(const m of g.items.slice(0,200)){
        const b=document.createElement('button');
        b.type='button';
        b.className='subi-pick-row';
        const main=document.createElement('span');
        main.className='subi-pick-main';
        const label=document.createElement('span');
        label.className='subi-pick-name';
        label.textContent=m.label;
        const desc=document.createElement('span');
        desc.className='subi-pick-id';
        desc.textContent=m.modelId;
        main.appendChild(label);
        main.appendChild(desc);
        const badge=document.createElement('span');
        badge.className='subi-pick-badge'+(m.costClass==='free' ? ' subi-pick-ok' : '');
        badge.textContent = m.costClass==='free' ? 'FREE' : 'MAY COST';
        b.appendChild(main);
        b.appendChild(badge);
        // Trusted host-side image-input state only; webview never decides this.
        const capState = m.capabilities ? m.capabilities.imageInput : undefined;
        const capBadge=document.createElement('span');
        if(capState==='supported'){ capBadge.className='subi-pick-badge subi-pick-vision'; capBadge.textContent='Vision'; }
        else if(capState==='unsupported'){ capBadge.className='subi-pick-badge subi-pick-muted'; capBadge.textContent='Text only'; }
        else { capBadge.className='subi-pick-badge subi-pick-muted'; capBadge.textContent='Image ?'; }
        b.appendChild(capBadge);
        if(m.modelId===selectedModelId){
          b.classList.add('subi-pick-selected');
          const check=document.createElement('span');
          check.className='subi-pick-check';
          check.textContent='✓';
          b.appendChild(check);
        }
        b.addEventListener('click', ()=>{
          if(isChatActive) return;
          vscode.postMessage({ type: 'setModel', provider: m.provider, modelId: m.modelId });
        });
        modelList.appendChild(b);
      }
    }
    if(filtered.length===0){
      const d=document.createElement('div');
      d.className='subi-empty-state';
      d.textContent='No models found.';
      modelList.appendChild(d);
    }
  }

  function handleConfirmationRequired(payload){
    // Cost consent is BYOK-only; never surface it in LearnSmart mode.
    if(isLearnSmartMode()) return;
    pendingConfirmation={ provider: payload.provider, modelId: payload.modelId };
    if(costConfirmText) costConfirmText.textContent=payload.message || 'This model may use API credits or incur charges from your provider.';
    if(costConfirm) costConfirm.classList.remove('subi-hidden');
    if(!settingsVisible() && onboardingComplete) openSettings('aiSettings');
    setStreamingUI(false);
  }

  function handleModelChanged(provider, modelId){
    // BYOK selection must never overwrite managed UI while LearnSmart MODE is
    // active (identity may still be restoring); managed selection lives in
    // managedSession.selectedModelKey.
    if(isLearnSmartMode()){ return; }
    selectedProvider=provider;
    selectedModelId=modelId;
    pendingConfirmation=null;
    if(costConfirm) costConfirm.classList.add('subi-hidden');
    syncProviderUI();
    renderModelList();
  }

  // ---- files / search (Stage 3A/3B logic unchanged, UI now inside settings) ----
  function handleLoadFiles(){ if(isLoadingFiles) return; isLoadingFiles=true; setFilesLoadingState(true); vscode.postMessage({ type: 'requestFileList' }); }
  function handleShowMore(){ renderNextBatch(); }
  function setFilesLoadingState(loading){
    isLoadingFiles=loading;
    if(loadFilesBtn){ loadFilesBtn.disabled=loading; loadFilesBtn.textContent=loading?'Loading files...':'Load Files'; }
    if(filesLoading) filesLoading.style.display=loading?'block':'none';
    if(!loading && fileList) fileList.style.display='block';
  }
  function handleFileList(files){
    allFiles=files; displayedCount=0; if(fileList) fileList.innerHTML=''; renderNextBatch(); setFilesLoadingState(false);
    if(showMoreBtn) showMoreBtn.style.display=allFiles.length>BATCH_SIZE?'block':'none';
  }
  function renderNextBatch(){
    if(!fileList) return;
    const nextFiles=allFiles.slice(displayedCount, displayedCount+BATCH_SIZE);
    for(const file of nextFiles){ const li=document.createElement('li'); li.className='subi-file-item'; li.dataset.fileId=file.id; li.textContent=file.displayPath; li.title=file.displayPath; li.addEventListener('click', ()=>handleFileClick(file.id,file.displayPath)); fileList.appendChild(li); }
    displayedCount+=nextFiles.length;
    if(showMoreBtn){ showMoreBtn.textContent=`Show More (${allFiles.length-displayedCount})`; showMoreBtn.style.display=displayedCount<allFiles.length?'block':'none'; showMoreBtn.disabled=displayedCount>=allFiles.length; }
  }
  function handleFileClick(fileId, displayPath){
    if(isLoadingPreview) return;
    // Ensure the files view (with preview) is visible when invoked from search.
    if(onboardingComplete && settingsView==='projectSearch'){
      showSettingsView('projectFiles');
    }
    if(fileList){ const items=fileList.querySelectorAll('.subi-file-item'); items.forEach(item=>{ if(item.dataset.fileId===fileId) item.classList.add('subi-selected'); else item.classList.remove('subi-selected'); }); }
    if(searchResults){ const items=searchResults.querySelectorAll('.subi-search-result-item'); items.forEach(item=>item.classList.remove('subi-selected')); }
    selectedFileId=fileId; showPreview(displayPath); isLoadingPreview=true; if(previewLoading) previewLoading.style.display='block'; if(previewCode) previewCode.textContent=''; vscode.postMessage({ type: 'requestFileContent', fileId });
  }
  function showPreview(displayPath){ if(previewSection) previewSection.style.display='block'; if(previewPath){ previewPath.textContent=displayPath; previewPath.title=displayPath; } }
  function handleFileContent(result){ isLoadingPreview=false; if(previewLoading) previewLoading.style.display='none'; if(previewCode) previewCode.textContent=result.content; }
  function handleFileError(error){ isLoadingPreview=false; if(previewLoading) previewLoading.style.display='none'; if(previewCode) previewCode.textContent=error.message; if(previewPath) previewPath.textContent='(error)'; }
  function resetFileState(){
    allFiles=[]; displayedCount=0; selectedFileId=null; isLoadingFiles=false; isLoadingPreview=false;
    if(fileList) fileList.innerHTML=''; if(loadFilesBtn){ loadFilesBtn.style.display='block'; loadFilesBtn.disabled=false; loadFilesBtn.textContent='Load Files'; }
    if(filesLoading) filesLoading.style.display='none'; if(fileList) fileList.style.display='none'; if(showMoreBtn) showMoreBtn.style.display='none'; if(previewSection) previewSection.style.display='none'; if(previewCode) previewCode.textContent=''; if(previewLoading) previewLoading.style.display='none';
  }

  let currentSearchState='idle';
  function setSearchState(state, message){
    currentSearchState=state; isSearching=state==='loading';
    if(searchLoading) searchLoading.style.display='none'; if(searchResults) searchResults.style.display='none'; if(searchNoResults) searchNoResults.style.display='none'; if(searchError){ searchError.style.display='none'; searchError.textContent=''; } if(searchResultsContainer) searchResultsContainer.style.display='none';
    switch(state){
      case 'idle': break;
      case 'loading': if(searchLoading) searchLoading.style.display='block'; if(searchResultsContainer) searchResultsContainer.style.display='block'; if(searchBtn){ searchBtn.disabled=true; searchBtn.textContent='Searching...'; } if(searchInput) searchInput.disabled=true; break;
      case 'results': if(searchResultsContainer) searchResultsContainer.style.display='block'; if(searchResults) searchResults.style.display='block'; if(searchBtn){ searchBtn.disabled=false; searchBtn.textContent='Search'; } if(searchInput) searchInput.disabled=false; break;
      case 'empty': if(searchResultsContainer) searchResultsContainer.style.display='block'; if(searchNoResults) searchNoResults.style.display='block'; if(searchBtn){ searchBtn.disabled=false; searchBtn.textContent='Search'; } if(searchInput) searchInput.disabled=false; break;
      case 'error': if(searchResultsContainer) searchResultsContainer.style.display='block'; if(searchError){ searchError.textContent=message||'Search failed.'; searchError.style.display='block'; } if(searchBtn){ searchBtn.disabled=false; searchBtn.textContent='Search'; } if(searchInput) searchInput.disabled=false; break;
    }
  }
  function setSearchMode(mode){
    searchMode=mode;
    if(searchModeFiles) searchModeFiles.classList.toggle('subi-active', mode==='files');
    if(searchModeContent) searchModeContent.classList.toggle('subi-active', mode==='content');
    setSearchState('idle');
  }
  function handleSearchKeydown(event){ if(event.key==='Enter' && !event.shiftKey){ event.preventDefault(); handleSearch(); } }
  function validateSearchQuery(query){
    const trimmed=query.trim();
    if(trimmed.length===0) return { valid:false, error:'Enter a search query.' };
    if(trimmed.length<2) return { valid:false, error:'Enter at least 2 characters.' };
    if(trimmed.length>200) return { valid:false, error:'Search query must not exceed 200 characters.' };
    return { valid:true, query:trimmed };
  }
  function handleSearch(){
    if(isSearching) return;
    const validation=validateSearchQuery(searchInput?.value||'');
    if(!validation.valid){ setSearchState('error', validation.error); return; }
    latestSearchRequestId=++nextSearchRequestId; const requestId=latestSearchRequestId; setSearchState('loading');
    vscode.postMessage({ type:'requestSearch', requestId, query:validation.query, mode:searchMode });
  }
  function handleSearchResults(requestId, results){
    if(requestId!==latestSearchRequestId) return;
    if(results.length===0){ setSearchState('empty'); return; }
    if(!searchResults) return;
    searchResults.innerHTML='';
    for(const result of results){
      const li=document.createElement('li'); li.className='subi-search-result-item'; li.dataset.fileId=result.fileId;
      const pathDiv=document.createElement('div'); pathDiv.className='subi-search-result-path'; pathDiv.textContent=result.displayPath;
      li.appendChild(pathDiv);
      if(result.line){
        const meta=document.createElement('div'); meta.className='subi-search-result-meta';
        const line=document.createElement('span'); line.className='subi-search-result-line'; line.textContent='Line '+result.line;
        meta.appendChild(line); li.appendChild(meta);
        if(result.preview){ const prev=document.createElement('span'); prev.className='subi-search-result-preview'; prev.textContent=result.preview; li.appendChild(prev); }
      }
      li.addEventListener('click', ()=>handleFileClick(result.fileId,result.displayPath)); searchResults.appendChild(li);
    }
    setSearchState('results');
  }
  function handleSearchError(requestId, error){ if(requestId!==latestSearchRequestId) return; const message=error?.message||'Search failed.'; setSearchState('error', message); }

  function setOnboardingState(state, message){
    const cards=[onboardingWelcome,onboardingLearnSmart,onboardingFree,onboardingByok,onboardingLoading,onboardingError];
    cards.forEach(c=>{ if(c) c.classList.add('subi-hidden'); });
    const isComplete=state==='complete';
    onboardingComplete=isComplete;
    if(onboardingSection) onboardingSection.classList.toggle('subi-hidden', isComplete);
    if(topbar) topbar.classList.toggle('subi-hidden', !isComplete);
    if(aiStatusRow) aiStatusRow.classList.toggle('subi-hidden', !isComplete);
    if(mainChatView) mainChatView.classList.toggle('subi-hidden', !isComplete);
    if(chatFooter) chatFooter.classList.toggle('subi-hidden', !isComplete);
    if(!isComplete && settingsOverlay) settingsOverlay.classList.add('subi-hidden');
    if(isComplete) syncEmptyState();
    switch(state){
      case 'welcome': if(onboardingWelcome) onboardingWelcome.classList.remove('subi-hidden'); break;
      case 'learnsmartLogin': if(onboardingLearnSmart) onboardingLearnSmart.classList.remove('subi-hidden'); if(learnSmartEmail) learnSmartEmail.value=''; if(learnSmartPassword) learnSmartPassword.value=''; if(learnSmartMessage){ learnSmartMessage.textContent=''; learnSmartMessage.classList.add('subi-hidden'); } break;
      case 'freeConfirmation': if(onboardingFree) onboardingFree.classList.remove('subi-hidden'); break;
      case 'byokConfiguring': if(onboardingByok) onboardingByok.classList.remove('subi-hidden'); break;
      case 'loading': if(onboardingLoading) onboardingLoading.classList.remove('subi-hidden'); if(loadingMessage) loadingMessage.textContent=message||'Loading...'; break;
      case 'error': if(onboardingError) onboardingError.classList.remove('subi-hidden'); if(errorMessage) errorMessage.textContent=message||'An error occurred.'; break;
      case 'complete': break;
    }
  }
  function handleSelectAccessMode(mode){ vscode.postMessage({ type:'selectAccessMode', mode }); setOnboardingState(mode==='learnsmart'?'learnsmartLogin':mode==='free'?'freeConfirmation':'byokConfiguring'); }
  function handleBackToWelcome(){ if(learnSmartPassword) learnSmartPassword.value=''; if(learnSmartEmail) learnSmartEmail.value=''; if(learnSmartMessage){ learnSmartMessage.textContent=''; learnSmartMessage.classList.add('subi-hidden'); } setOnboardingState('welcome'); }
  function handleLearnSmartSubmit(event){
    event.preventDefault();
    if(authBusy) return;
    const email=learnSmartEmail?.value?.trim(); const password=learnSmartPassword?.value;
    if(!email||!password){ showLearnSmartMessage('Please enter both email and password.'); return; }
    // Password travels one time to the host; the field clears on every outcome.
    vscode.postMessage({ type:'learnsmartSignIn', email, password });
  }
  function showLearnSmartMessage(message){ if(learnSmartMessage){ learnSmartMessage.textContent=message; learnSmartMessage.classList.remove('subi-hidden'); } }
  function clearLearnSmartPassword(){ if(learnSmartPassword) learnSmartPassword.value=''; }
  function setLearnSmartBusy(busy){
    authBusy=busy;
    if(btnLearnSmartSignIn){ btnLearnSmartSignIn.disabled=busy; btnLearnSmartSignIn.textContent=busy?'Signing in...':'Sign In'; }
    if(learnSmartEmail) learnSmartEmail.disabled=busy;
    if(learnSmartPassword) learnSmartPassword.disabled=busy;
  }
  function handleLearnSmartBusy(busy){ setLearnSmartBusy(busy); }
  function handleLearnSmartError(message){
    showLearnSmartMessage(message || 'Unable to sign in to LearnSmart.');
    clearLearnSmartPassword();
  }
  function handleIdentityChanged(identity){
    currentIdentity=identity && identity.type==='learnsmart' ? identity : { type:'guest' };
    clearLearnSmartPassword();
    if(learnSmartMessage){ learnSmartMessage.textContent=''; learnSmartMessage.classList.add('subi-hidden'); }
    // Leaving LearnSmart must never leave managed models/limit visible.
    if(currentIdentity.type!=='learnsmart'){
      managedSession=null;
      if(managedPanel) managedPanel.classList.add('subi-hidden');
    }
    applyModeVisibility();
    syncAccountUI();
    syncEmptyState();
    updateSendButtonState();
  }
  function syncAccountUI(){
    if(!settingsAccountSummary) return;
    if(currentIdentity && currentIdentity.type==='learnsmart'){
      const u=currentIdentity.user;
      const roleLabel = u.role==='student' ? 'Student' : 'Teacher';
      settingsAccountSummary.textContent=(u.displayName || u.email)+' • '+roleLabel+' • LearnSmart';
      if(btnAccountSignout) btnAccountSignout.classList.remove('subi-hidden');
    } else {
      settingsAccountSummary.textContent='Guest';
      if(btnAccountSignout) btnAccountSignout.classList.add('subi-hidden');
    }
  }
  // ---- LearnSmart managed session UI (Phase 6: configuration display only) ----
  // Phase 7 Change 1: TWO concepts. isLearnSmartMode() (access mode only)
  // gates BYOK hiding/blocking. isAuthenticatedLearnSmart() (mode + identity)
  // gates identity-dependent managed features. isLearnSmartIdentity() is kept
  // for managed-session display paths that genuinely need the user object.
  function isLearnSmartMode(){
    return currentAccessMode==='learnsmart';
  }
  function isAuthenticatedLearnSmart(){
    return currentAccessMode==='learnsmart' && !!(currentIdentity && currentIdentity.type==='learnsmart');
  }
  function isLearnSmartIdentity(){
    return !!(currentIdentity && currentIdentity.type==='learnsmart');
  }
  function isManagedReady(){
    return isLearnSmartIdentity() && !!managedSession && managedSession.status==='allowed';
  }
  function setManagedRow(el, show){
    if(el) el.classList.toggle('subi-hidden', !show);
  }
  // Phase 7 Change 1: primary visibility branch. LearnSmart MODE alone hides
  // BYOK surfaces — even when identity is still guest (restore pending),
  // managed is loading, access is blocked, or the backend is unavailable.
  function applyModeVisibility(){
    var ls = isLearnSmartMode();
    var aiGroup = document.getElementById('settings-group-ai');
    if(aiGroup) aiGroup.classList.toggle('subi-hidden', ls);
    if(btnConfigureProvider) btnConfigureProvider.classList.toggle('subi-hidden', ls);
    if(btnRemoveProviderKey) btnRemoveProviderKey.classList.toggle('subi-hidden', ls);
    if(btnOpenProviderPicker) btnOpenProviderPicker.classList.toggle('subi-hidden', ls);
    // BYOK catalogue filter + cost + setup entry points stay shut in LS mode.
    if(modelFilterFree) modelFilterFree.classList.toggle('subi-hidden', ls);
    if(modelFilterAll) modelFilterAll.classList.toggle('subi-hidden', ls);
    if(costConfirm && ls) costConfirm.classList.add('subi-hidden');
    if(btnEmptyConfigure && ls) btnEmptyConfigure.classList.add('subi-hidden');
    // Never leave a BYOK-only settings view open in LearnSmart mode. The
    // shared model picker (managed branch) is allowed to stay.
    if(ls && (settingsView==='aiSettings' || settingsView==='providerPicker')){
      showSettingsView('settingsHome');
    }
  }
  function handleAccessModeChanged(mode){
    currentAccessMode = (mode==='learnsmart' || mode==='byok' || mode==='free') ? mode : null;
    applyModeVisibility();
    syncEmptyState();
    updateSendButtonState();
  }
  function handleManagedSessionChanged(state){
    managedSession = (state && typeof state.status==='string') ? state : null;
    renderManagedPanel();
    syncManagedLabels();
    syncEmptyState();
    updateSendButtonState();
  }
  function renderManagedPanel(){
    if(!isLearnSmartIdentity() || !managedSession || managedSession.status==='idle'){
      if(managedPanel) managedPanel.classList.add('subi-hidden');
      return;
    }
    if(!managedPanel || !managedStatusLine) return;
    managedPanel.classList.remove('subi-hidden');
    var st = managedSession.status;
    var showModel=false, showLimit=false, showActions=false;
    if(st==='loading'){
      managedStatusLine.textContent='Checking your SUBI access…';
    } else if(st==='blocked'){
      managedStatusLine.textContent='SUBI Access Disabled — SUBI access is currently disabled for your account.';
      showActions=true;
    } else if(st==='unavailable'){
      managedStatusLine.textContent='SUBI Temporarily Unavailable — Unable to verify your SUBI access right now. Please try again.';
      showActions=true;
    } else if(st==='allowed'){
      var models = Array.isArray(managedSession.models) ? managedSession.models : [];
      if(models.length===0){
        managedStatusLine.textContent='No SUBI models are currently available for your account.';
      } else {
        managedStatusLine.textContent='SUBI Managed AI is ready.';
      }
      showModel = models.length>0;
      showLimit = true;
      if(showModel && managedModelLabel){
        var sel=null;
        for(var i=0;i<models.length;i++){
          if(models[i] && models[i].modelKey===managedSession.selectedModelKey){ sel=models[i]; break; }
        }
        managedModelLabel.textContent = sel ? sel.displayName : 'No model selected';
      }
      if(managedLimitLabel){
        var lim = managedSession.monthlyLimit;
        if(lim && lim.configured===true && typeof lim.monthlyTokenLimit==='number'){
          managedLimitLabel.textContent=lim.monthlyTokenLimit.toLocaleString('en-US')+' tokens / month';
        } else {
          managedLimitLabel.textContent='Not Configured';
        }
      }
    } else {
      managedStatusLine.textContent='SUBI Temporarily Unavailable — Unable to verify your SUBI access right now. Please try again.';
      showActions=true;
    }
    setManagedRow(managedModelRow, showModel);
    setManagedRow(managedLimitRow, showLimit);
    setManagedRow(managedActionsRow, showActions);
  }
  function syncManagedLabels(){
    if(!isManagedReady()) return;
    var models = managedSession.models || [];
    var sel=null;
    for(var i=0;i<models.length;i++){
      if(models[i] && models[i].modelKey===managedSession.selectedModelKey){ sel=models[i]; break; }
    }
    var label = sel ? sel.displayName : 'No model selected';
    if(aiStatusLabel) aiStatusLabel.textContent='LearnSmart • '+label;
    if(chatStatusValue) chatStatusValue.textContent='LearnSmart • '+label;
    if(aiModelLabel) aiModelLabel.textContent=label;
    if(settingsAiSummary) settingsAiSummary.textContent='LearnSmart • '+label;
  }
  function handleFreeContinue(){ setOnboardingState('loading','Free AI connection will be enabled in Stage 4A.4.'); setTimeout(()=>setOnboardingState('error','Free AI connection will be enabled in Stage 4A.4.'),500); }
  function handleByokConfigure(){ const p = byokProviderSelect ? byokProviderSelect.value : 'openrouter'; vscode.postMessage({ type:'configureProvider', provider:p }); }

  window.addEventListener('message', (event)=>{
    const message=event.data;
    switch(message.type){
      case 'init': handleInit(message); break;
      case 'workspaceInfo': handleWorkspaceInfo(message.payload); break;
      case 'fileList': handleFileList(message.payload); break;
      case 'fileContent': handleFileContent(message.payload); break;
      case 'fileError': handleFileError(message.payload); break;
      case 'searchResults': handleSearchResults(message.requestId, message.payload); break;
      case 'searchError': handleSearchError(message.requestId, message.payload); break;
      case 'onboardingState': setOnboardingState(message.state, message.message); break;
      case 'accessModeChanged': handleAccessModeChanged(message.mode); break;
      case 'providerStatus': handleProviderStatus(message.payload); break;
      case 'modelCatalog': handleModelCatalog(message.provider, message.models); break;
      case 'modelCatalogError': handleModelCatalogError(message.provider, message.message); break;
      case 'modelCatalogLoading': break;
      case 'confirmationRequired': handleConfirmationRequired(message); break;
      case 'modelChanged': handleModelChanged(message.provider, message.modelId); break;
      case 'chatStarted': handleChatStarted(message.requestId); break;
      case 'chatResponse': handleChatResponse(message.requestId, message.content); break;
      case 'chatError': handleChatError(message.requestId, message.error); break;
      case 'chatStreamStarted': handleStreamStarted(message.requestId); break;
      case 'chatStreamDelta': handleStreamDelta(message.requestId, message.delta); break;
      case 'chatStreamCompleted': handleStreamCompleted(message.requestId, message.provider, message.modelId, message.actualModelId); break;
      case 'chatStreamError': handleStreamError(message.requestId, message.error); break;
      case 'chatStreamCancelled': handleStreamCancelled(message.requestId); break;
      case 'learnsmartAuthBusy': handleLearnSmartBusy(message.busy); break;
      case 'learnsmartAuthError': handleLearnSmartError(message.message); break;
      case 'identityChanged': handleIdentityChanged(message.identity); break;
      case 'managedSessionChanged': handleManagedSessionChanged(message.state); break;
      case 'agentModeChanged': agentMode = message.mode || 'ask'; syncUIForAgentMode(); break;
      case 'slashCommands': slashPopupCommands = (Array.isArray(message.commands) ? message.commands : []).map((cmd) => ({
        name: String(cmd.name ?? ''),
        aliases: Array.isArray(cmd.aliases) ? cmd.aliases.map(String) : undefined,
        description: String(cmd.description ?? ''),
        category: String(cmd.category ?? 'session'),
        argumentHint: cmd.argumentHint ? String(cmd.argumentHint) : undefined,
        available: !!cmd.available,
        unavailableReason: cmd.unavailableReason ? String(cmd.unavailableReason) : undefined,
      })); break;
      case 'toolCatalog': break; // handled by /tools command flow (host sends, webview renders independently if needed)
      case 'toolStarted': showToolCard({ type:'started', callId: message.callId, toolName: message.toolName, category: message.category, label: message.label }); break;
      case 'toolCompleted': showToolCard({ type:'completed', callId: message.callId, toolName: message.toolName, category: message.category, label: message.label, ok: message.ok, summary: message.summary, payload: message.result?.payload, durationMs: message.durationMs }); break;
      case 'toolFailed': showToolCard({ type:'failed', callId: message.callId, toolName: message.toolName, category: message.category, label: message.label, code: message.code, message: message.message, durationMs: message.durationMs }); break;
      case 'slashResult': showSlashResult(message); break;
      case 'contextSummary': renderContextSummary(message.payload); break;
      case 'attachmentsAdded': handleAttachmentsAdded(message.attachments); break;
      case 'attachmentRemoved': handleAttachmentRemoved(message.attachmentId); break;
      case 'attachmentsSync': handleAttachmentsSync(message.attachments); break;
      case 'attachmentError': handleAttachmentError(message.error); break;
      case 'attachmentThumbnail': handleAttachmentThumbnail(message.attachmentId, message.dataUrl); break;
      case 'chatHistoryCleared': handleChatHistoryCleared(); break;
      default: break;
    }
  });

  function syncUIForAgentMode(){
    if(topbar) topbar.classList.remove('subi-hidden');
    // Phase 10A: agent mode is shown as a small pill next to brand when not ask.
    // For now, the UI remains compact; the mode is visible through the settings
    // and the slash popup behavior.
  }

  function showToolCard(eventData){
    // Phase 10A: compact tool result card shown briefly at the bottom of
    // the chat area (or overlaid as a small card). Uses safe metadata only.
    // Not yet wired to persistent cards; this is the event handler placeholder.
  }

  function showSlashResult(message){
    // Phase 10A: render a brief status line (or open the tool card) based
    // on the slash command result from the host.
    const resultMessage = message && message.message ? message.message : '';
    // If the result has a payload with kind 'toolCards', render it.
    if(message && message.payload && message.payload.kind === 'toolCards'){
      // Placeholder for future card rendering.
      return;
    }
    // Otherwise show a small toast-style message (reuse chat-thinking area briefly).
    if(chatErrorEl && resultMessage){
      chatErrorEl.textContent = resultMessage;
      chatErrorEl.classList.remove('subi-hidden');
      setTimeout(()=>hideChatError(), 3000);
    }
  }

  function renderContextSummary(payload){
    // Phase 10A: safe context display (agentMode, accessMode, workspace,
    // selected model, recent tool activity). No secrets.
    if(settingsProjectSummary && payload && payload.workspaceName){
      settingsProjectSummary.textContent = payload.workspaceName + ' • ' + (payload.projectType || 'project');
    }
  }

  function handleWorkspaceInfo(info){
    currentWorkspaceInfo=info;
    if(!info){ syncTopbarProject(null); resetFileState(); resetSearchState(); return; }
    syncTopbarProject(info); showProjectCard(info);
  }
  function syncTopbarProject(info){
    if(topbarProject){
      const typeLabel = info ? formatProjectType(info.projectType) : '';
      topbarProject.textContent = info ? (typeLabel ? (typeLabel+' • '+info.name) : info.name) : 'No project';
      topbarProject.title = info ? info.path : 'No project open';
    }
    if(settingsProjectSummary){
      if(!info){ settingsProjectSummary.textContent='No project open'; }
      else { settingsProjectSummary.textContent=info.name+' • '+formatProjectType(info.projectType); }
    }
  }
  function resetSearchState(){ setSearchState('idle'); if(searchInput) searchInput.value=''; setSearchMode('files'); latestSearchRequestId=0; nextSearchRequestId=0; }
  function showProjectCard(info){
    if(noProjectState) noProjectState.style.display='none'; if(projectCard) projectCard.style.display='block';
    if(projectName) projectName.textContent=info.name; if(projectType){ projectType.textContent=formatProjectType(info.projectType); projectType.title=info.projectType; }
    if(projectPath){ projectPath.textContent=info.path; projectPath.title=info.path; }
    if(info.isMultiRoot && projectMulti){ projectMulti.textContent=`${info.workspaceFolderCount} workspace folders`; projectMulti.style.display='block'; } else if(projectMulti) projectMulti.style.display='none';
  }
  function formatProjectType(type){
    const labels={'vscode-extension':'VS Code Extension','node':'Node.js','react':'React','nextjs':'Next.js','python':'Python','flutter':'Flutter','rust':'Rust','go':'Go','java':'Java','generic':'Generic Project'};
    return labels[type]||type;
  }

  if(document.readyState==='loading'){ document.addEventListener('DOMContentLoaded', init); } else { init(); }
})();
