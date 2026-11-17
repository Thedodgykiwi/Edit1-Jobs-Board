(function () {
  "use strict";

  const defaultEditors = [
    { id: "ed-shift-lead", name: "Brendan Gibbons", initials: "BG", onBreak: false }
  ];

  const suiteNumbers = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const suiteLabels = { 10: "MB 1", 11: "MB 2" };
  const suiteFullNames = { 10: "Millbank Edit 1", 11: "Millbank Edit 2" };
  let todayKey = dateKey(new Date());
  let selectedDateKey = todayKey;
  const STAGE_KEY = window.STAGE || "local";
  const uiStorageKey = "edit1-shift-board:display";
  const suiteUseLabels = { unused: "Unused", repair: "Repair needed", "in-use": "In use", meeting: "Meeting", filming: "Filming" };

  const freshDayState = (boardDate = todayKey) => ({
    version: 12,
    date: boardDate,
    editors: defaultEditors.map((editor) => ({ ...editor })),
    suites: Object.fromEntries(suiteNumbers.map((suite) => [suite, suite === 1 ? "ed-shift-lead" : null])),
    suiteModes: Object.fromEntries(suiteNumbers.map((suite) => [suite, "unused"])),
    daySheet: { html: "" },
    jobs: []
  });

  let state = freshDayState(selectedDateKey);
  let cloudRevision = 0;
  let cloudReady = false;
  let cloudBusy = false;
  let savedSnapshot = "";
  let pendingSave = null;
  let saveTimer = null;
  let pendingDateSelection = null;
  let remoteCheckInFlight = false;
  let syncRetryAction = null;
  let uiState = loadUiState();
  applySectionStartupPreference();
  let completedFilters = { type: "", editor: "", suite: "" };
  let biffingJobId = null;
  let actionConfirmationResolver = null;
  let editingJobId = null;
  let editingEditorId = null;
  let fastTrackTarget = null;
  let handoverManualJobs = [];
  let returnToQueueAfterAdd = false;
  let suiteStatusFilter = "all";
  let toastTimer;
  let todos = [];
  let todoRevision = 0;
  let todoReady = false;
  let todoSaving = false;
  let todoPendingSave = null;
  let todoRetryTimer = null;
  let editingTodoId = null;
  let reminderTodoId = null;

  const suiteGrid = document.getElementById("suiteGrid");
  const editorRadar = document.getElementById("editorRadar");
  const editorsPanel = document.getElementById("editorsPanel");
  const plannedJobs = document.getElementById("plannedJobs");
  const completedJobs = document.getElementById("completedJobs");
  const biffedJobs = document.getElementById("biffedJobs");
  const summaryStrip = document.getElementById("summaryStrip");
  const poolCount = document.getElementById("poolCount");
  const completedCount = document.getElementById("completedCount");
  const biffedCount = document.getElementById("biffedCount");
  const completedTypeFilter = document.getElementById("completedTypeFilter");
  const completedEditorFilter = document.getElementById("completedEditorFilter");
  const completedSuiteFilter = document.getElementById("completedSuiteFilter");
  const jobDialog = document.getElementById("jobDialog");
  const fastTrackDialog = document.getElementById("fastTrackDialog");
  const editJobDialog = document.getElementById("editJobDialog");
  const detailDialog = document.getElementById("detailDialog");
  const handoverDialog = document.getElementById("handoverDialog");
  const handoverForm = document.getElementById("handoverForm");
  const settingsDialog = document.getElementById("settingsDialog");
  const queueMetadataDialog = document.getElementById("queueMetadataDialog");
  const actionConfirmDialog = document.getElementById("actionConfirmDialog");
  const actionConfirmButton = document.getElementById("actionConfirmButton");
  const biffDialog = document.getElementById("biffDialog");
  const daySheetDialog = document.getElementById("daySheetDialog");
  const daySheetEditor = document.getElementById("daySheetEditor");
  const daySheetView = document.getElementById("daySheetView");
  const jobForm = document.getElementById("jobForm");
  const fastTrackForm = document.getElementById("fastTrackForm");
  const editJobForm = document.getElementById("editJobForm");
  const jobEditor = document.getElementById("jobEditor");
  const editJobEditor = document.getElementById("editJobEditor");
  const detailList = document.getElementById("detailList");
  const toast = document.getElementById("toast");
  const boardDateInput = document.getElementById("boardDateInput");
  const boardDateKicker = document.getElementById("boardDateKicker");
  const boardDateLabel = document.getElementById("boardDateLabel");
  const todayButton = document.getElementById("todayButton");
  const dayScopeBadge = document.getElementById("dayScopeBadge");
  const todoDialog = document.getElementById("todoDialog");
  const todoForm = document.getElementById("todoForm");
  const todoTitle = document.getElementById("todoTitle");
  const todoNote = document.getElementById("todoNote");
  const todoSubmitButton = document.getElementById("todoSubmitButton");
  const todoList = document.getElementById("todoList");
  const todoCompletedList = document.getElementById("todoCompletedList");
  const todoDialogDate = document.getElementById("todoDialogDate");
  const todoEditDialog = document.getElementById("todoEditDialog");
  const todoEditForm = document.getElementById("todoEditForm");
  const todoEditTitle = document.getElementById("todoEditTitle");
  const todoEditNote = document.getElementById("todoEditNote");
  const todoEditReminder = document.getElementById("todoEditReminder");
  const todoReminderDialog = document.getElementById("todoReminderDialog");


  function saveState() {
    if (!cloudReady || cloudBusy) return;
    state.date = selectedDateKey;
    const snapshot = JSON.stringify(state);
    if (snapshot === savedSnapshot) return;
    pendingSave = { board: JSON.parse(snapshot), revision: cloudRevision, mutationId: crypto.randomUUID() };
    try { localStorage.setItem(`edit1-cloud-draft:${STAGE_KEY}:${selectedDateKey}`, JSON.stringify(pendingSave)); } catch { /* The in-memory draft remains available for retry. */ }
    schedulePersist();
  }

  function schedulePersist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void persistBoard();
    }, 250);
  }

  function syncStatus(message, locked = false, retry = null, conflict = false) {
    document.getElementById("syncText").textContent = message;
    document.getElementById("syncBar").classList.toggle("sync-error", Boolean(retry || conflict));
    document.querySelector(".app-shell").inert = locked;
    document.querySelectorAll("dialog").forEach((dialog) => {
      dialog.inert = locked;
      if (locked && (retry || conflict) && dialog.open) dialog.close();
    });
    syncRetryAction = retry;
    document.getElementById("syncRetry").hidden = !retry;
    document.getElementById("syncReload").hidden = !conflict;
  }

  // Storage lives in cloud.js (Cloud Firestore); same results the old server API gave.
  function cloudRequest(date, payload, options = {}) {
    return window.Edit1Cloud.board(date, payload, options);
  }

  function todoCloudRequest(payload, options = {}) {
    return window.Edit1Cloud.tasks(payload, options);
  }

  function queueTodoSave() {
    if (!todoReady) return;
    todoPendingSave = { tasks: todos.map((task) => ({ ...task })), revision: todoRevision, mutationId: crypto.randomUUID() };
    try { localStorage.setItem(`edit1-supervisor-todo:${STAGE_KEY}:draft`, JSON.stringify(todoPendingSave)); } catch { /* The in-memory copy will still retry. */ }
    void persistTodos();
  }

  async function persistTodos() {
    if (!todoPendingSave || todoSaving) return;
    clearTimeout(todoRetryTimer);
    todoRetryTimer = null;
    const pending = todoPendingSave;
    todoPendingSave = null;
    pending.revision = todoRevision;
    todoSaving = true;
    try {
      const result = await todoCloudRequest(pending);
      todoRevision = result.revision;
      if (!todoPendingSave) {
        try { localStorage.removeItem(`edit1-supervisor-todo:${STAGE_KEY}:draft`); } catch { /* The saved server copy remains authoritative. */ }
      }
    } catch (error) {
      if (error.status === 409) {
        await loadTodos(false);
        showToast("Checklist updated from your other device — review the latest list");
      } else {
        todoPendingSave = pending;
        showToast(error.message || "Checklist could not save yet — retrying", "danger");
        todoRetryTimer = setTimeout(() => void persistTodos(), 3000);
      }
    } finally {
      todoSaving = false;
      if (todoPendingSave && !todoRetryTimer) void persistTodos();
    }
  }

  function assignLegacyTodosToToday() {
    let changed = false;
    todos = todos.map((task) => {
      if (dateFromKey(task.date)) return task;
      changed = true;
      return { ...task, date: todayKey };
    });
    return changed;
  }

  async function loadTodos(recoverDraft = true) {
    try {
      const result = await todoCloudRequest();
      todos = Array.isArray(result.tasks) ? result.tasks : [];
      todoRevision = result.revision;
      todoReady = true;
      let draft;
      try { draft = recoverDraft && JSON.parse(localStorage.getItem(`edit1-supervisor-todo:${STAGE_KEY}:draft`)); } catch { draft = null; }
      if (draft?.tasks && draft.mutationId !== result.mutationId) {
        todos = draft.tasks;
        todoPendingSave = draft;
      }
      const migrated = assignLegacyTodosToToday();
      renderTodos();
      if (migrated || todoPendingSave) queueTodoSave();
      setTimeout(checkTaskReminders, 0);
    } catch (error) {
      console.warn("Checklist load failed", error);
      showToast(error.message || "Checklist could not load", "danger");
    }
  }

  function renderTodoItem(task, completed = false) {
    const starred = task.starred === true;
    const isNote = task.isNote === true;
    const reminder = task.reminderTime ? `<span class="todo-reminder-meta">Reminder · ${escapeHtml(task.reminderTime)}</span>` : "";
    return `<article class="todo-item${isNote ? " is-note" : ""}${completed ? " is-complete" : " has-star-action"}${starred && !completed ? " is-starred" : ""}" data-todo-id="${escapeHtml(task.id)}">
      ${isNote ? '<span class="todo-note-icon" title="Note" aria-label="Note"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h10l4 4v14H5zM15 3v5h4M8 12h8M8 16h6" /></svg></span>' : `<button class="todo-check" data-todo-action="${completed ? "restore" : "complete"}" type="button" aria-label="${completed ? "Restore" : "Complete"} ${escapeHtml(task.title)}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5 9.2 17 19 7" /></svg>
      </button>`}
      <button class="todo-copy" data-todo-action="edit" type="button" aria-label="Edit ${escapeHtml(task.title)}"><strong>${escapeHtml(task.title)}</strong>${task.note ? `<span>${escapeHtml(task.note)}</span>` : ""}${reminder}</button>
      ${completed ? "" : `<button class="todo-star${starred ? " is-active" : ""}" data-todo-action="star" type="button" aria-label="${starred ? "Unstar" : "Star"} ${escapeHtml(task.title)}" aria-pressed="${starred}" title="${starred ? "Remove from top" : "Keep at top"}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.75 5.57 6.15.9-4.45 4.33 1.05 6.12L12 17.03l-5.5 2.89 1.05-6.12L3.1 9.47l6.15-.9L12 3Z" /></svg>
      </button>`}
      <button class="todo-delete" data-todo-action="delete" type="button" aria-label="Delete ${escapeHtml(task.title)}" title="Delete ${isNote ? "note" : "task"}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" /></svg>
      </button>
    </article>`;
  }

  function renderTodos() {
    const dateTodos = todos.filter((task) => task.date === selectedDateKey);
    const active = dateTodos.filter((task) => !task.completedAt).sort((a, b) => {
      const starOrder = Number(b.starred === true) - Number(a.starred === true);
      if (starOrder) return starOrder;
      const aReminder = a.reminderTime || "";
      const bReminder = b.reminderTime || "";
      if (Boolean(aReminder) !== Boolean(bReminder)) return aReminder ? -1 : 1;
      if (aReminder !== bReminder) return aReminder.localeCompare(bReminder);
      return b.createdAt.localeCompare(a.createdAt);
    });
    const completed = dateTodos.filter((task) => task.completedAt).sort((a, b) => b.completedAt.localeCompare(a.completedAt));
    todoDialogDate.textContent = selectedDateKey === todayKey ? "Edit 1 · Today" : `Edit 1 · ${formattedBoardDate(selectedDateKey, { short: true })}`;
    todoList.innerHTML = active.length ? active.map((task) => renderTodoItem(task)).join("") : '<p class="todo-empty">Nothing waiting — you’re all caught up.</p>';
    todoCompletedList.innerHTML = completed.map((task) => renderTodoItem(task, true)).join("");
    document.getElementById("todoCompletedSection").hidden = completed.length === 0;
    document.getElementById("todoCompletedCount").textContent = completed.length;
    const badge = document.getElementById("todoCount");
    badge.textContent = active.length;
    badge.hidden = active.length === 0;
    document.getElementById("todoButton").classList.toggle("has-tasks", active.length > 0);
  }

  function openTodoDialog(showEntry = true) {
    if (!todoReady) {
      showToast("Checklist is still loading — try again in a moment");
      void loadTodos();
      return;
    }
    todoDialog.classList.toggle("todo-current-only", !showEntry);
    todoForm.hidden = !showEntry;
    const heading = document.getElementById("todoDialogTitle");
    heading.textContent = showEntry ? "To-do checklist" : "Current tasks";
    const viewButton = document.getElementById("todoViewButton");
    viewButton.textContent = showEntry ? "Current tasks" : "Add task";
    viewButton.setAttribute("aria-expanded", String(showEntry));
    if (!todoDialog.open) todoDialog.showModal();
    const focusTarget = showEntry ? todoTitle : heading;
    focusTarget.focus({ preventScroll: true });
    requestAnimationFrame(() => {
      if (todoDialog.open && todoForm.hidden === !showEntry) focusTarget.focus({ preventScroll: true });
    });
  }

  function parseBulkTodoItems(note) {
    return note.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("- ")).map((line) => {
      let title = line.slice(2).trim();
      const starred = /\*\s*$/.test(title);
      if (starred) title = title.replace(/\*\s*$/, "").trim();
      return title ? { title, starred } : null;
    }).filter(Boolean);
  }

  function updateTodoEntryMode() {
    todoTitle.setCustomValidity("");
    const bulkItems = todoTitle.value.trim() ? [] : parseBulkTodoItems(todoNote.value);
    const isNote = document.getElementById("todoIsNote").checked;
    todoSubmitButton.textContent = bulkItems.length ? `Add ${bulkItems.length} ${isNote ? "notes" : "tasks"}` : isNote ? "Add note" : "Add task";
    return bulkItems;
  }

  function showTodoTitleValidation() {
    todoTitle.setCustomValidity("Enter a task title or add bulk tasks using lines that start with - ");
    todoTitle.reportValidity();
    todoTitle.focus({ preventScroll: true });
  }

  function addTodo() {
    const title = todoTitle.value.trim();
    const bulkItems = title ? [] : updateTodoEntryMode();
    if (!title && !bulkItems.length) return showTodoTitleValidation();
    const createdAt = new Date().toISOString();
    const newTasks = title ? [{ title, note: todoNote.value.trim(), starred: false }] : bulkItems.map((item) => ({ ...item, note: "" }));
    todos.push(...newTasks.map((task) => ({ id: crypto.randomUUID(), ...task, isNote: document.getElementById("todoIsNote").checked, date: selectedDateKey, createdAt, completedAt: null })));
    todoForm.reset();
    updateTodoEntryMode();
    renderTodos();
    queueTodoSave();
    todoTitle.focus({ preventScroll: true });
  }

  function openTodoEditor(task) {
    editingTodoId = task.id;
    document.getElementById("todoEditDate").textContent = `Edit 1 · ${task.date === todayKey ? "Today" : formattedBoardDate(task.date, { short: true })}`;
    document.getElementById("todoEditIsNote").checked = task.isNote === true;
    updateTodoEditNoteMode();
    todoEditTitle.value = task.title;
    todoEditNote.value = task.note || "";
    todoEditReminder.value = task.isNote ? "" : task.reminderTime || "";
    todoEditDialog.showModal();
    requestAnimationFrame(() => todoEditTitle.focus({ preventScroll: true }));
  }

  function updateTodoEditNoteMode() {
    const isNote = document.getElementById("todoEditIsNote").checked;
    todoEditReminder.closest("label.field").hidden = isNote;
    document.getElementById("todoEditDialogTitle").textContent = isNote ? "Note details" : "Task details";
  }

  function saveTodoEdits() {
    const task = todos.find((candidate) => candidate.id === editingTodoId);
    if (!task) return;
    todoEditTitle.setCustomValidity(todoEditTitle.value.trim() ? "" : "Enter a task title.");
    if (!todoEditForm.reportValidity()) return;
    const isNote = document.getElementById("todoEditIsNote").checked;
    const reminderTime = isNote ? null : todoEditReminder.value || null;
    task.isNote = isNote;
    if (isNote) task.completedAt = null;
    if ((task.reminderTime || null) !== reminderTime) task.reminderAcknowledgedAt = null;
    task.title = todoEditTitle.value.trim();
    task.note = todoEditNote.value.trim();
    task.reminderTime = reminderTime;
    editingTodoId = null;
    todoEditDialog.close();
    renderTodos();
    queueTodoSave();
    showToast(reminderTime ? `Task saved · reminder ${reminderTime}` : "Task saved");
    setTimeout(checkTaskReminders, 0);
  }

  function taskReminderDueAt(task) {
    const date = dateFromKey(task.date);
    const match = /^(\d{2}):(\d{2})$/.exec(task.reminderTime || "");
    if (!date || !match) return null;
    date.setHours(Number(match[1]), Number(match[2]), 0, 0);
    return date;
  }

  function checkTaskReminders() {
    const blockingDialogOpen = Array.from(document.querySelectorAll("dialog[open]")).some((dialog) => dialog !== todoDialog && dialog !== todoReminderDialog);
    if (!todoReady || document.hidden || todoReminderDialog.open || blockingDialogOpen) return;
    const now = Date.now();
    const task = todos
      .filter((candidate) => !candidate.isNote && !candidate.completedAt && candidate.reminderTime && !candidate.reminderAcknowledgedAt)
      .map((candidate) => ({ task: candidate, dueAt: taskReminderDueAt(candidate) }))
      .filter((candidate) => candidate.dueAt && candidate.dueAt.getTime() <= now)
      .sort((a, b) => a.dueAt - b.dueAt)[0]?.task;
    if (!task) return;
    reminderTodoId = task.id;
    const reminderDate = task.date === todayKey ? "Today" : formattedBoardDate(task.date, { short: true });
    document.getElementById("todoReminderTime").textContent = `Task reminder · ${reminderDate} · ${task.reminderTime}`;
    document.getElementById("todoReminderTask").textContent = task.title;
    document.getElementById("todoReminderNote").textContent = task.note || "";
    todoReminderDialog.showModal();
  }

  function acknowledgeTodoReminder(complete = false) {
    const task = todos.find((candidate) => candidate.id === reminderTodoId);
    reminderTodoId = null;
    if (task) {
      const now = new Date().toISOString();
      task.reminderAcknowledgedAt = now;
      if (complete && !task.isNote) task.completedAt = now;
      renderTodos();
      queueTodoSave();
      showToast(complete ? "Task completed" : "Reminder dismissed", complete ? "complete" : undefined);
    }
    if (todoReminderDialog.open) todoReminderDialog.close();
    setTimeout(checkTaskReminders, 0);
  }

  function handleTodoAction(event) {
    const button = event.target.closest("[data-todo-action]");
    if (!button) return;
    const item = button.closest("[data-todo-id]");
    const task = todos.find((candidate) => candidate.id === item?.dataset.todoId);
    if (!task) return;
    if (button.dataset.todoAction === "edit") return openTodoEditor(task);
    if (button.dataset.todoAction === "complete") {
      if (task.isNote) return;
      item.classList.add("is-finishing");
      setTimeout(() => {
        task.completedAt = new Date().toISOString();
        renderTodos();
        queueTodoSave();
      }, 180);
      return;
    }
    if (button.dataset.todoAction === "restore") task.completedAt = null;
    if (button.dataset.todoAction === "star") task.starred = task.starred !== true;
    if (button.dataset.todoAction === "delete") todos = todos.filter((candidate) => candidate.id !== task.id);
    renderTodos();
    queueTodoSave();
  }

  async function persistBoard() {
    if (!pendingSave || cloudBusy) return;
    cloudBusy = true;
    cloudReady = false;
    syncStatus("Saving…", true);
    try {
      const result = await cloudRequest(pendingSave.board.date, pendingSave);
      cloudRevision = result.revision;
      state = pendingSave.board;
      savedSnapshot = JSON.stringify(pendingSave.board);
      try { localStorage.removeItem(`edit1-cloud-draft:${STAGE_KEY}:${pendingSave.board.date}`); } catch { /* A stale draft is detected against its revision on next load. */ }
      pendingSave = null;
      render();
      cloudReady = true;
      syncStatus("Saved · Shared board");
    } catch (error) {
      syncStatus(error.message || "Could not save. Retry before closing.", true, error.status === 409 ? null : persistBoard, error.status === 409);
    } finally {
      cloudBusy = false;
      if (cloudReady && pendingDateSelection && pendingDateSelection !== selectedDateKey) {
        const nextDate = pendingDateSelection;
        pendingDateSelection = null;
        void loadCloudBoard(nextDate);
      }
    }
  }

  async function loadCloudBoard(date, recoverDraft = true) {
    if (cloudBusy) return;
    cloudBusy = true;
    cloudReady = false;
    syncStatus("Loading shared board…", true);
    try {
      const result = await cloudRequest(date);
      selectedDateKey = date;
      remoteBoardChanges++;
      state = result.board || freshDayState(date);
      cloudRevision = result.revision;
      savedSnapshot = JSON.stringify(state);
      pendingSave = null;
      completedFilters = { type: "", editor: "", suite: "" };
      render();
      updateClock();
      cloudReady = true;
      syncStatus("Shared board · Up to date");
      let draft;
      try { draft = recoverDraft && JSON.parse(localStorage.getItem(`edit1-cloud-draft:${STAGE_KEY}:${date}`)); } catch { draft = null; }
      if (draft?.board && draft.mutationId !== result.mutationId) {
        pendingSave = draft;
        cloudReady = false;
        syncStatus("An unsaved copy is preserved on this device.", true, draft.revision === cloudRevision ? persistBoard : null, true);
      }
    } catch (error) {
      syncStatus(error.message || "Could not load shared board.", true, () => loadCloudBoard(date, recoverDraft));
    } finally { cloudBusy = false; }
  }


  function loadUiState() {
    try {
      const saved = JSON.parse(localStorage.getItem(uiStorageKey));
      if (saved && typeof saved.poolCollapsed === "boolean" && typeof saved.editorsCollapsed === "boolean") {
        return {
          ...saved,
          completedCollapsed: typeof saved.completedCollapsed === "boolean" ? saved.completedCollapsed : true,
          biffedCollapsed: typeof saved.biffedCollapsed === "boolean" ? saved.biffedCollapsed : true,
          emptySuitePresentation: ["full", "condensed", "hidden"].includes(saved.emptySuitePresentation) ? saved.emptySuitePresentation : saved.hideUnusedSuites ? "hidden" : "full",
          compactSuites: Boolean(saved.compactSuites),
          compactQueueCards: Boolean(saved.compactQueueCards),
          poolHidden: Boolean(saved.poolHidden),
          sectionStartup: ["remember", "collapsed", "queue", "expanded"].includes(saved.sectionStartup) ? saved.sectionStartup : "remember",
          queueSort: ["priority", "due", "type", "added"].includes(saved.queueSort) ? saved.queueSort : "priority",
          dueWarningMinutes: [0, 15, 30, 60].includes(Number(saved.dueWarningMinutes)) ? Number(saved.dueWarningMinutes) : 30,
          queueMetadata: normaliseQueueMetadata(saved),
          hideEmptyArchives: saved.hideEmptyArchives === undefined ? true : Boolean(saved.hideEmptyArchives),
          confirmJobActions: Boolean(saved.confirmJobActions),
          theme: ["auto", "light", "dark"].includes(saved.theme) ? saved.theme : "auto"
        };
      }
    } catch (error) {
      console.warn("Could not load display preferences", error);
    }
    return {
      poolCollapsed: true,
      editorsCollapsed: true,
      completedCollapsed: true,
      biffedCollapsed: true,
      emptySuitePresentation: "full",
      compactSuites: false,
      compactQueueCards: false,
      poolHidden: false,
      sectionStartup: "remember",
      queueSort: "priority",
      dueWarningMinutes: 30,
      queueMetadata: { priority: true, reporter: true, notes: true, workType: true, editFormat: true },
      hideEmptyArchives: true,
      confirmJobActions: false,
      theme: "auto"
    };
  }

  function normaliseQueueMetadata(saved) {
    const fields = ["priority", "reporter", "notes", "workType", "editFormat"];
    if (saved.queueMetadata && typeof saved.queueMetadata === "object") {
      return Object.fromEntries(fields.map((field) => [field, saved.queueMetadata[field] !== false]));
    }
    const legacy = ["both", "notes", "contact", "hidden"].includes(saved.jobCardDetails) ? saved.jobCardDetails : "both";
    return {
      priority: true,
      reporter: legacy === "both" || legacy === "contact",
      notes: legacy === "both" || legacy === "notes",
      workType: true,
      editFormat: true
    };
  }

  function saveUiState() {
    localStorage.setItem(uiStorageKey, JSON.stringify(uiState));
  }

  function applySectionStartupPreference() {
    if (uiState.sectionStartup === "remember") return;
    const expanded = uiState.sectionStartup === "expanded";
    uiState.poolCollapsed = !(expanded || uiState.sectionStartup === "queue");
    uiState.editorsCollapsed = !expanded;
    uiState.completedCollapsed = !expanded;
    uiState.biffedCollapsed = !expanded;
  }

  function editors() {
    return state.editors.filter((editor) => !editor.removedFromRoster);
  }

  function editorById(id) {
    return state.editors.find((editor) => editor.id === id) || null;
  }

  function suiteForEditor(editorId) {
    const entry = Object.entries(state.suites).find(([, assignedId]) => assignedId === editorId);
    return entry ? Number(entry[0]) : null;
  }

  const wheelDialog = document.getElementById("wheelDialog");
  const wheelSvg = document.getElementById("editorWheel");
  const wheelSpinButton = document.getElementById("wheelSpinButton");
  const wheelResult = document.getElementById("wheelResult");
  let wheelEntries = [];
  let wheelTurn = 0;
  let wheelRun = 0;
  let wheelAnimation = null;
  let wheelMisses = 0;
  let wheelHasEditor = false;

  function freeWheelEditors(board) {
    return board.editors.filter((editor) => !editor.removedFromRoster && !editor.onBreak &&
      Object.values(board.suites).includes(editor.id) &&
      !board.jobs.some((job) => job.status === "active" && job.editorId === editor.id));
  }

  function wheelRandomIndex(count) {
    const random = new Uint32Array(1);
    const limit = Math.floor(4294967296 / count) * count;
    do { crypto.getRandomValues(random); } while (random[0] >= limit);
    return random[0] % count;
  }

  function pickWheelEntry(entries) {
    const editorIndices = [];
    const jokeIndices = [];
    entries.forEach((entry, index) => (entry.editorId ? editorIndices : jokeIndices).push(index));
    // Choose the category first so editor odds stay at 1 in 5 for any roster size.
    const pool = editorIndices.length && (!jokeIndices.length || wheelRandomIndex(5) === 0) ? editorIndices : jokeIndices;
    return pool.length ? pool[wheelRandomIndex(pool.length)] : -1;
  }

  function wheelLabelLines(label) {
    const words = label.trim().split(/\s+/);
    if (words.length < 2) return words;
    let split = 1;
    let balance = Infinity;
    for (let i = 1; i < words.length; i++) {
      const difference = Math.abs(words.slice(0, i).join(" ").length - words.slice(i).join(" ").length);
      if (difference < balance) { balance = difference; split = i; }
    }
    return [words.slice(0, split).join(" "), words.slice(split).join(" ")];
  }

  function drawEditorWheel(board) {
    const free = freeWheelEditors(board);
    const jokes = ["Better luck next time", "Today is not your day", "Come back later"];
    wheelEntries = free.map((editor) => ({ label: editor.name, editorId: editor.id }));
    if (free.length) jokes.forEach((label, i) => wheelEntries.splice(Math.round((i + 1) * free.length / 3) + i, 0, { label }));
    const colours = ["#2463a6", "#a53f6c", "#237a69", "#8352b1", "#af5b2b", "#247b98"];
    const step = 360 / (wheelEntries.length || 1);
    const labelMeasure = document.createElement("canvas").getContext("2d");
    // Leave room between each two-line label and the segment borders.
    const labelWidth = Math.min(185, 2 * 170 * Math.tan(step * Math.PI / 360) - 16);
    const point = (angle, radius) => [300 + Math.cos(angle * Math.PI / 180) * radius, 300 + Math.sin(angle * Math.PI / 180) * radius];
    wheelSvg.innerHTML = wheelEntries.length ? wheelEntries.map((entry, i) => {
      const start = -90 + i * step;
      const [ax, ay] = point(start, 290);
      const [bx, by] = point(start + step, 290);
      const mid = start + step / 2;
      const [tx, ty] = point(mid, 196);
      const lines = wheelLabelLines(entry.label);
      if (labelMeasure) labelMeasure.font = '700 20px "DM Sans", sans-serif';
      const lineWidth = (text) => labelMeasure ? labelMeasure.measureText(text).width : text.length * 13;
      const widest = Math.max(...lines.map(lineWidth));
      const font = Math.min(20, Math.max(12, 20 * labelWidth / widest));
      return `<path d="M300 300 L${ax} ${ay} A290 290 0 ${step > 180 ? 1 : 0} 1 ${bx} ${by} Z" fill="${entry.editorId ? colours[i % colours.length] : "#39434f"}" stroke="#f4f7fa" stroke-width="2"/><text transform="translate(${tx} ${ty}) rotate(${mid + 90})" text-anchor="middle" fill="white" font-size="${font}" font-weight="700" dominant-baseline="middle">${lines.map((text, j) => `<tspan x="0" y="${(j - (lines.length - 1) / 2) * (font + 3)}"${lineWidth(text) * font / 20 > labelWidth ? ` textLength="${labelWidth}" lengthAdjust="spacingAndGlyphs"` : ""}>${escapeHtml(text)}</tspan>`).join("")}</text>`;
    }).join("") : '<circle cx="300" cy="300" r="290" fill="#39434f"/>';
    wheelSpinButton.disabled = !free.length;
    return free.length;
  }

  document.getElementById("wheelButton").addEventListener("click", () => {
    if (!cloudReady) return;
    wheelTurn = 0;
    wheelMisses = 0;
    wheelHasEditor = false;
    wheelSpinButton.hidden = false;
    wheelSvg.style.transform = "rotate(0deg)";
    const count = drawEditorWheel(state);
    wheelResult.textContent = count ? `${count} free editor${count === 1 ? "" : "s"} · Give it a spin` : "Nobody free right now. Come back later!";
    wheelSpinButton.textContent = "Spin that wheel";
    wheelDialog.showModal();
  });

  wheelSpinButton.addEventListener("click", async () => {
    if (wheelSpinButton.disabled || wheelSpinButton.hidden || !wheelDialog.open) return;
    const run = ++wheelRun;
    const date = selectedDateKey;
    wheelSpinButton.disabled = true;
    wheelResult.textContent = "Checking who’s free…";
    try {
      if (cloudBusy || pendingSave) throw new Error("wait");
      const latest = await cloudRequest(date);
      if (run !== wheelRun || !wheelDialog.open) return;
      const board = latest.board || freshDayState(date);
      if (!drawEditorWheel(board)) { wheelResult.textContent = "Nobody free right now. Come back later!"; return; }
      wheelSpinButton.disabled = true;
      const index = pickWheelEntry(wheelEntries);
      const winner = wheelEntries[index];
      const target = (360 - (index + 0.5) * 360 / wheelEntries.length) % 360;
      const end = wheelTurn + 360 * 6 + ((target - wheelTurn % 360 + 360) % 360);
      wheelResult.textContent = "Round and round…";
      wheelSpinButton.textContent = "Spinning…";
      wheelAnimation = wheelSvg.animate([{ transform: `rotate(${wheelTurn}deg)` }, { transform: `rotate(${end}deg)` }], { duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 150 : 5600, easing: "cubic-bezier(.12,.72,.12,1)", fill: "forwards" });
      await wheelAnimation.finished;
      if (run !== wheelRun || !wheelDialog.open) return;
      wheelTurn = end;
      wheelSvg.style.transform = `rotate(${end}deg)`;
      wheelAnimation.cancel(); wheelAnimation = null;
      if (winner.editorId) wheelHasEditor = true;
      else wheelMisses++;
      wheelResult.textContent = winner.editorId ? `${winner.label} — you’re up!` : winner.label;
      if (winner.editorId) {
        const check = await cloudRequest(date);
        if (run !== wheelRun || !wheelDialog.open) return;
        if (!freeWheelEditors(check.board || freshDayState(date)).some((editor) => editor.id === winner.editorId)) wheelResult.textContent = `${winner.label} is no longer free. Spin again!`;
      }
    } catch (error) {
      if (run !== wheelRun || !wheelDialog.open) return;
      wheelResult.textContent = error.message === "wait" ? "Let the board finish saving, then spin again." : "Couldn’t check availability. Try again.";
    } finally {
      if (run === wheelRun && wheelDialog.open) {
        const exhausted = wheelMisses >= 2 && !wheelHasEditor;
        if (exhausted) wheelResult.textContent = "No spins left";
        wheelSpinButton.hidden = exhausted;
        wheelSpinButton.disabled = exhausted || !wheelEntries.length;
        wheelSpinButton.textContent = "Spin again";
      }
    }
  });
  wheelDialog.addEventListener("click", (event) => { if (event.target === wheelDialog) wheelDialog.close(); });
  wheelDialog.addEventListener("close", () => { ++wheelRun; wheelAnimation?.cancel(); wheelAnimation = null; });

  const historySearchDialog = document.getElementById("historySearchDialog");
  const historySearchQuery = document.getElementById("historySearchQuery");
  const historySearchEditor = document.getElementById("historySearchEditor");
  const historySearchSuite = document.getElementById("historySearchSuite");
  const historySearchResults = document.getElementById("historySearchResults");
  const historySearchStatus = document.getElementById("historySearchStatus");
  const historySearchMore = document.getElementById("historySearchMore");
  const historySearchRetry = document.getElementById("historySearchRetry");
  let historySearchRows = [];
  let historySearchOffset = 0;
  let historySearchGeneration = 0;
  let historySearchController = null;
  let historySearchTimer = null;
  let historySearchLoading = false;
  let historySearchSelected = -1;
  let historySearchScroll = 0;
  let historySearchEditorOptions = null;
  let historyOptionsGeneration = 0;
  const historyStatusLabels = { planned: "In queue", parked: "Parked", queued: "Coming up", active: "Active", completed: "Completed", biffed: "Biffed" };
  historySearchSuite.innerHTML += suiteNumbers.map((suite) => `<option value="${suite}">${escapeHtml(suiteLabel(suite))}</option>`).join("");

  function historyJobPeople(row) {
    const ids = new Set([row.job.editorId, row.job.parkedFromEditorId]);
    const names = new Set([row.job.completedBy, row.job.biffedBy, row.job.parkedFromEditorName].filter(Boolean));
    (row.job.history || []).forEach((event) => {
      ids.add(event.editorId); ids.add(event.previousEditorId);
      if (event.editorName) names.add(event.editorName);
      if (event.previousEditorName) names.add(event.previousEditorName);
    });
    row.editors.forEach((editor) => { if (ids.has(editor.id)) names.add(editor.name); });
    return [...names].filter((name) => !/^unassigned( editor)?$/i.test(name));
  }

  function historyJobSuites(job) {
    const suites = new Set([job.suite, job.completedSuite, job.biffedSuite, job.parkedFromSuite].filter(Boolean).map(Number));
    (job.history || []).forEach((event) => {
      if (event.suite) suites.add(Number(event.suite));
      if (event.previousSuite) suites.add(Number(event.previousSuite));
    });
    return [...suites].sort((a, b) => a - b).map(suiteLabel);
  }

  function updateLinkedHistoryFilters(changed = "") {
    if (!historySearchEditorOptions) return;
    let editor = historySearchEditor.value;
    let suite = historySearchSuite.value;
    const selected = historySearchEditorOptions.find((option) => option.key === editor);
    if (editor && !selected) editor = "";
    if (editor && suite && !selected?.suites.includes(Number(suite))) {
      if (changed === "suite") editor = "";
      else suite = "";
    }
    const editors = suite ? historySearchEditorOptions.filter((option) => option.suites.includes(Number(suite))) : historySearchEditorOptions;
    const suites = editor ? historySearchEditorOptions.find((option) => option.key === editor).suites : suiteNumbers;
    historySearchEditor.innerHTML = '<option value="">All editors</option>' + editors.map((option) => `<option value="${escapeHtml(option.key)}">${escapeHtml(option.name)}</option>`).join("");
    historySearchSuite.innerHTML = '<option value="">All suites</option>' + suites.map((value) => `<option value="${value}">${escapeHtml(suiteLabel(value))}</option>`).join("");
    historySearchEditor.value = editor;
    historySearchSuite.value = suite;
  }

  async function loadHistoryEditorOptions() {
    const generation = ++historyOptionsGeneration;
    try {
      const data = await window.Edit1Cloud.facets();
      if (generation !== historyOptionsGeneration) return;
      const before = [historySearchEditor.value, historySearchSuite.value].join("|");
      historySearchEditorOptions = data.editors;
      updateLinkedHistoryFilters();
      if (historySearchDialog.open && before !== [historySearchEditor.value, historySearchSuite.value].join("|")) scheduleHistorySearch();
      document.getElementById("historyEditorOptionsError")?.remove();
    } catch {
      if (generation !== historyOptionsGeneration) return;
      if (!document.getElementById("historyEditorOptionsError")) {
        const message = document.createElement("button");
        message.id = "historyEditorOptionsError"; message.type = "button"; message.className = "button button-ghost";
        message.textContent = "Editor list unavailable · Retry";
        message.addEventListener("click", () => void loadHistoryEditorOptions());
        document.getElementById("historySearchFilters").append(message);
      }
    }
  }

  function showHistorySearchList(restoreFocus = false) {
    document.getElementById("historySearchListView").hidden = false;
    document.getElementById("historySearchDetailView").hidden = true;
    document.getElementById("historySearchBack").hidden = true;
    document.getElementById("historySearchTitle").textContent = "Search history";
    if (restoreFocus) {
      historySearchResults.scrollTop = historySearchScroll;
      historySearchResults.querySelector(`[data-history-result="${historySearchSelected}"]`)?.focus({ preventScroll: true });
    }
  }

  function openHistorySearch() {
    if (!cloudReady) return;
    showHistorySearchList();
    if (!historySearchDialog.open) historySearchDialog.showModal();
    historySearchQuery.focus({ preventScroll: true });
    void loadHistoryEditorOptions();
    void runHistorySearch();
  }

  function scheduleHistorySearch() {
    clearTimeout(historySearchTimer);
    historySearchController?.abort();
    ++historySearchGeneration;
    historySearchMore.hidden = true;
    historySearchRetry.hidden = true;
    historySearchResults.setAttribute("aria-busy", "true");
    historySearchResults.innerHTML = "";
    historySearchStatus.textContent = "Searching…";
    historySearchTimer = setTimeout(() => void runHistorySearch(), 250);
  }

  async function runHistorySearch(append = false) {
    clearTimeout(historySearchTimer);
    historySearchController?.abort();
    const controller = new AbortController();
    historySearchController = controller;
    const generation = ++historySearchGeneration;
    historySearchLoading = true;
    if (!append) { historySearchRows = []; historySearchOffset = 0; historySearchResults.innerHTML = ""; }
    historySearchResults.setAttribute("aria-busy", "true");
    historySearchMore.hidden = true; historySearchRetry.hidden = true;
    historySearchStatus.textContent = append ? "Loading more jobs…" : "Searching…";
    try {
      const data = await window.Edit1Cloud.search({ q: historySearchQuery.value.trim(), editor: historySearchEditor.value, suite: historySearchSuite.value, offset: historySearchOffset });
      if (generation !== historySearchGeneration || !historySearchDialog.open) return;
      historySearchRows.push(...data.results);
      historySearchOffset = data.nextOffset;
      renderHistorySearchResults();
      historySearchMore.hidden = !data.hasMore;
      historySearchStatus.textContent = historySearchRows.length ? `${historySearchRows.length} job${historySearchRows.length === 1 ? "" : "s"}${data.hasMore ? " shown · More available" : " found"} · Newest first` : "No matching jobs";
    } catch (error) {
      if (generation !== historySearchGeneration || !historySearchDialog.open) return;
      historySearchStatus.textContent = error.message || "Search unavailable. Try again.";
      historySearchRetry.hidden = false;
      historySearchRetry.onclick = () => void runHistorySearch(append);
    } finally {
      if (generation === historySearchGeneration) { historySearchLoading = false; historySearchResults.setAttribute("aria-busy", "false"); }
    }
  }

  function renderHistorySearchResults() {
    const scrollTop = historySearchResults.scrollTop;
    historySearchResults.innerHTML = historySearchRows.length ? historySearchRows.map((row, index) => {
      const people = historyJobPeople(row).join(", ") || "Unassigned";
      const suites = historyJobSuites(row.job).join(", ") || "No suite recorded";
      return `<button class="history-search-result" data-history-result="${index}" type="button"><span class="history-search-result-top"><strong>${escapeHtml(row.job.title)}</strong><span class="history-result-status">${escapeHtml(historyStatusLabels[row.job.status] || row.job.status)}</span></span><span class="history-result-date">${escapeHtml(formattedBoardDate(row.date, { short: true }))}</span><span>${escapeHtml(people)} · ${escapeHtml(suites)}</span></button>`;
    }).join("") : '<p class="todo-empty">No jobs match these filters. Try another title, editor or suite.</p>';
    historySearchResults.scrollTop = scrollTop;
  }

  function openSearchJobHistory(index) {
    const row = historySearchRows[index];
    if (!row) return;
    historySearchSelected = index;
    historySearchScroll = historySearchResults.scrollTop;
    document.getElementById("historySearchListView").hidden = true;
    document.getElementById("historySearchBack").hidden = false;
    document.getElementById("historySearchTitle").textContent = "Job history";
    const detail = document.getElementById("historySearchDetailView");
    detail.hidden = false;
    const meta = [formattedBoardDate(row.date, { short: true }), historyStatusLabels[row.job.status] || row.job.status, historyJobPeople(row).join(", ") || "Unassigned", historyJobSuites(row.job).join(", ") || "No suite recorded"];
    detail.innerHTML = `<h3>${escapeHtml(row.job.title)}</h3><p class="history-card-meta">${meta.map(escapeHtml).join(" · ")}</p>${row.job.note ? `<p class="history-card-note">${escapeHtml(row.job.note)}</p>` : ""}${jobHistoryCardMarkup(row.job, row.editors)}`;
    detail.scrollTop = 0;
    document.getElementById("historySearchBack").focus({ preventScroll: true });
  }

  document.getElementById("historySearchButton").addEventListener("click", openHistorySearch);
  document.getElementById("historySearchBack").addEventListener("click", () => showHistorySearchList(true));
  document.getElementById("historySearchFilters").addEventListener("submit", (event) => { event.preventDefault(); void runHistorySearch(); });
  historySearchQuery.addEventListener("input", scheduleHistorySearch);
  historySearchEditor.addEventListener("change", () => { updateLinkedHistoryFilters("editor"); scheduleHistorySearch(); });
  historySearchSuite.addEventListener("change", () => { updateLinkedHistoryFilters("suite"); scheduleHistorySearch(); });
  historySearchResults.addEventListener("click", (event) => {
    const result = event.target.closest("[data-history-result]");
    if (result && !historySearchLoading) openSearchJobHistory(Number(result.dataset.historyResult));
  });
  historySearchMore.addEventListener("click", () => { if (!historySearchLoading) void runHistorySearch(true); });
  document.getElementById("historySearchClear").addEventListener("click", () => {
    historySearchQuery.value = ""; historySearchEditor.value = ""; historySearchSuite.value = "";
    updateLinkedHistoryFilters();
    void runHistorySearch(); historySearchQuery.focus({ preventScroll: true });
  });
  historySearchDialog.addEventListener("close", () => {
    clearTimeout(historySearchTimer); ++historySearchGeneration; historySearchController?.abort(); historySearchLoading = false;
  });
  historySearchDialog.addEventListener("click", (event) => { if (event.target === historySearchDialog) historySearchDialog.close(); });

  function suiteLabel(suite) {
    return suiteLabels[suite] || `Edit ${suite}`;
  }

  function suiteFullLabel(suite) {
    return suiteFullNames[suite] || suiteLabel(suite);
  }

  function suiteModeFor(suite) {
    const mode = state.suiteModes?.[suite];
    return Object.hasOwn(suiteUseLabels, mode) ? mode : "unused";
  }

  function activeJobsForEditor(editorId) {
    return state.jobs.filter((job) => job.status === "active" && job.editorId === editorId);
  }

  function activeJobForEditor(editorId) {
    return activeJobsForEditor(editorId)[0] || null;
  }

  function activeJobsForSuite(suite) {
    return state.jobs.filter((job) => job.status === "active" && job.suite === suite);
  }

  function activeJobForSuite(suite) {
    return activeJobsForSuite(suite)[0] || null;
  }

  function allowsConcurrentRunning(editorId, suite = suiteForEditor(editorId)) {
    return editorId === "ed-shift-lead" && suite === 1;
  }

  function queuedJobsForEditor(editorId) {
    return state.jobs.filter((job) => job.status === "queued" && job.editorId === editorId);
  }

  function queuedJobsForSuite(suite) {
    return state.jobs.filter((job) => job.status === "queued" && job.suite === suite)
      // Paused jobs (issue #10) first, then in the order they were queued.
      .sort((a, b) => Number(Boolean(b.pausedInSuite)) - Number(Boolean(a.pausedInSuite)) || (a.queuedAt || "").localeCompare(b.queuedAt || ""));
  }

  function plannedJobsForEditor(editorId) {
    return state.jobs.filter((job) => (job.status === "planned" || job.status === "parked") && job.editorId === editorId);
  }

  function editorOptions(selectedId, includeUnassigned = true) {
    const first = includeUnassigned ? '<option value="">Unassigned</option>' : '<option value="">No editor</option>';
    return first + editors().map((editor) => {
      const selected = editor.id === selectedId ? " selected" : "";
      const suite = suiteForEditor(editor.id);
      const active = activeJobForEditor(editor.id);
      const queued = queuedJobsForEditor(editor.id).length;
      let status = "free";
      if (editor.onBreak) status = "break";
      else if (active) status = "busy";
      const suffix = suite ? ` · ${suiteLabel(suite)} · ${status}${queued ? ` · ${queued} next` : ""}` : ` · no suite · ${status}`;
      return `<option value="${editor.id}"${selected}>${escapeHtml(editor.name + suffix)}</option>`;
    }).join("");
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function sanitiseDaySheetHtml(value) {
    const source = document.createElement("template");
    source.innerHTML = String(value || "");
    const allowed = new Set(["P", "BR", "STRONG", "B", "EM", "I", "H3", "H4", "UL", "OL", "LI", "A"]);
    const walk = (node) => {
      [...node.childNodes].forEach((child) => {
        if (child.nodeType !== Node.ELEMENT_NODE) return;
        if (!allowed.has(child.tagName)) {
          const children = [...child.childNodes];
          child.replaceWith(...children);
          children.forEach(walk);
          return;
        }
        const href = child.tagName === "A" ? child.getAttribute("href") || "" : "";
        [...child.attributes].forEach((attribute) => child.removeAttribute(attribute.name));
        if (child.tagName === "A") {
          if (/^https?:\/\//i.test(href)) {
            child.setAttribute("href", href);
            child.setAttribute("target", "_blank");
            child.setAttribute("rel", "noreferrer");
          } else child.replaceWith(...child.childNodes);
        }
        walk(child);
      });
    };
    walk(source.content);
    return source.innerHTML.trim();
  }

  function daySheetHtml() {
    return sanitiseDaySheetHtml(state.daySheet?.html);
  }

  function openDaySheet() {
    daySheetEditor.innerHTML = daySheetHtml();
    setDaySheetMode(false);
    document.getElementById("daySheetDate").textContent = formattedBoardDate(selectedDateKey, { short: true });
    daySheetDialog.showModal();
  }

  function setDaySheetMode(editing) {
    const html = daySheetHtml();
    daySheetView.innerHTML = html || '<p class="day-sheet-empty">No Day Sheet added for this day.</p>';
    daySheetView.hidden = editing;
    daySheetEditor.hidden = !editing;
    document.getElementById("daySheetToolbar").hidden = !editing;
    document.getElementById("daySheetIntro").textContent = editing
      ? "Paste the newsroom agenda from Teams, then tidy the key headings and bullets."
      : "Today’s newsroom agenda and planned output.";
    document.getElementById("editDaySheetButton").hidden = editing;
    document.getElementById("closeDaySheetButton").hidden = editing;
    document.getElementById("saveDaySheetButton").hidden = !editing;
    if (editing) requestAnimationFrame(() => daySheetEditor.focus());
  }

  function saveDaySheet() {
    const html = sanitiseDaySheetHtml(daySheetEditor.innerHTML);
    state.daySheet = { html };
    document.getElementById("daySheetButton").classList.toggle("has-content", Boolean(html.replace(/<[^>]+>/g, "").trim()));
    daySheetDialog.close();
    saveState();
    showToast(html ? "Day Sheet saved" : "Day Sheet cleared", "info");
  }

  function insertDaySheetHtml(html) {
    document.execCommand("insertHTML", false, sanitiseDaySheetHtml(html));
  }

  function formatDaySheet(command) {
    daySheetEditor.focus();
    if (command === "heading") document.execCommand("formatBlock", false, "h3");
    else document.execCommand(command, false, null);
  }

  function initialsFor(name) {
    const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "?";
    return `${parts[0][0]}${parts.length > 1 ? parts.at(-1)[0] : ""}`.toUpperCase();
  }

  function cssSlug(value) {
    return String(value || "other").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  }

  function isEditOneAdmin(workType) {
    return workType === "Edit 1 admin";
  }

  function isProtectedWork(workType) {
    return ["booking", "special"].includes(String(workType || "").trim().toLowerCase());
  }

  function syncEditFormatForWorkType(workTypeId, formatId) {
    const workType = document.getElementById(workTypeId);
    const format = document.getElementById(formatId);
    if (!workType || !format) return;
    const isAdmin = isEditOneAdmin(workType.value);
    format.disabled = isAdmin;
    format.closest(".edit-format-row")?.classList.toggle("is-admin-work", isAdmin);
  }

  function render() {
    renderDateNavigator();
    renderTodos();
    renderSettingsState();
    renderSummary();
    renderEditorRadar();
    renderSuiteFilter();
    renderSuites();
    renderPlannedJobs();
    renderCompletedJobs();
    renderBiffedJobs();
    populateNewJobEditors();
    renderCollapseState();
    document.getElementById("daySheetButton").classList.toggle("has-content", Boolean(daySheetHtml().replace(/<[^>]+>/g, "").trim()));
    saveState();
  }

  function renderSuiteFilter() {
    const labels = { all: "All", free: "Free", busy: "Busy", assigned: "Assigned" };
    const next = { all: "free", free: "busy", busy: "assigned", assigned: "all" };
    const button = document.getElementById("suiteFilterButton");
    const eyebrow = document.getElementById("suiteFilterEyebrow");
    button.classList.remove("filter-all", "filter-free", "filter-busy", "filter-assigned");
    button.classList.add(`filter-${suiteStatusFilter}`);
    eyebrow.textContent = `Tap title to filter · ${labels[suiteStatusFilter]}`;
    button.setAttribute("aria-label", `Showing ${labels[suiteStatusFilter].toLowerCase()} suites. Tap to show ${labels[next[suiteStatusFilter]].toLowerCase()} suites`);
  }

  function cycleSuiteFilter() {
    suiteStatusFilter = { all: "free", free: "busy", busy: "assigned", assigned: "all" }[suiteStatusFilter];
    renderSuiteFilter();
    renderSuites();
  }

  function renderCollapseState() {
    const poolSection = document.getElementById("poolSection");
    const completedSection = document.getElementById("completedSection");
    const completedButton = document.getElementById("completedCollapseButton");
    const biffedSection = document.getElementById("biffedSection");
    const biffedButton = document.getElementById("biffedCollapseButton");
    const poolTotal = state.jobs.filter((job) => job.status === "planned" || job.status === "parked").length;
    const completedTotal = state.jobs.filter((job) => job.status === "completed").length;
    const biffedTotal = state.jobs.filter((job) => job.status === "biffed").length;

    completedSection.hidden = uiState.hideEmptyArchives && completedTotal === 0;
    biffedSection.hidden = uiState.hideEmptyArchives && biffedTotal === 0;

    poolSection.hidden = uiState.poolHidden;
    document.getElementById("showJobQueueCard").checked = !uiState.poolHidden;
    poolSection.classList.toggle("collapsed", uiState.poolCollapsed);

    editorsPanel.classList.toggle("collapsed-content", uiState.editorsCollapsed);

    completedSection.classList.toggle("collapsed", uiState.completedCollapsed);
    completedButton.setAttribute("aria-expanded", String(!uiState.completedCollapsed));
    completedButton.title = uiState.completedCollapsed ? "Show completed jobs" : "Hide completed jobs";

    biffedSection.classList.toggle("collapsed", uiState.biffedCollapsed);
    biffedButton.setAttribute("aria-expanded", String(!uiState.biffedCollapsed));
    biffedButton.querySelector("span").textContent = uiState.biffedCollapsed ? `Show ${biffedTotal} ${biffedTotal === 1 ? "job" : "jobs"}` : "Hide jobs";
    announceUi();
  }

  function renderSettingsState() {
    document.getElementById("emptySuitePresentation").value = uiState.emptySuitePresentation;
    document.getElementById("compactSuites").checked = uiState.compactSuites;
    document.getElementById("compactQueueCards").checked = uiState.compactQueueCards;
    document.getElementById("sectionStartup").value = uiState.sectionStartup;
    document.getElementById("queueSort").value = uiState.queueSort;
    document.getElementById("dueWarningMinutes").value = String(uiState.dueWarningMinutes);
    const metadataCount = Object.values(uiState.queueMetadata).filter(Boolean).length;
    document.getElementById("queueMetadataSummary").textContent = `${metadataCount} shown`;
    document.querySelectorAll("[data-queue-metadata]").forEach((input) => {
      input.checked = Boolean(uiState.queueMetadata[input.dataset.queueMetadata]);
    });
    document.getElementById("hideEmptyArchives").checked = uiState.hideEmptyArchives;
    document.getElementById("confirmJobActions").checked = uiState.confirmJobActions;
  }

  function setQueueVisibility(visible) {
    uiState.poolHidden = !visible;
    saveUiState();
    renderCollapseState();
  }

  function toggleQueueVisibility() {
    setQueueVisibility(uiState.poolHidden);
  }

  document.getElementById("showJobQueueCard").addEventListener("change", (event) => setQueueVisibility(event.target.checked));

  // ---- Board commands for the page shell (issue #22) ----------------------
  // shell.js (profile menu, Job Queue / Editors & suites headers) calls these
  // directly, and listens for "board:ui" to keep its controls in step.
  function uiSnapshot() {
    return {
      theme: uiState.theme,
      poolCollapsed: uiState.poolCollapsed,
      poolHidden: uiState.poolHidden,
      editorsCollapsed: uiState.editorsCollapsed,
      compactQueueCards: uiState.compactQueueCards,
    };
  }
  function announceUi() {
    document.dispatchEvent(new CustomEvent("board:ui", { detail: uiSnapshot() }));
  }
  window.Edit1Board = {
    ui: uiSnapshot,
    setTheme(mode) {
      if (!["auto", "light", "dark"].includes(mode)) return;
      uiState.theme = mode;
      saveUiState();
      applyTheme();
    },
    openSettings: () => settingsDialog.showModal(),
    togglePool: () => toggleSection("pool"),
    toggleEditors: () => toggleSection("editors"),
    toggleQueueShown: () => toggleQueueVisibility(),
    setCompactQueueCards: (on) => setCompactQueueCards(Boolean(on)),
  };

  function toggleSection(section) {
    if (section === "pool") uiState.poolCollapsed = !uiState.poolCollapsed;
    if (section === "editors") uiState.editorsCollapsed = !uiState.editorsCollapsed;
    if (section === "completed") uiState.completedCollapsed = !uiState.completedCollapsed;
    if (section === "biffed") uiState.biffedCollapsed = !uiState.biffedCollapsed;
    saveUiState();
    renderCollapseState();
  }

  function applyTheme() {
    const prefersDark = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)").matches : true;
    const resolved = uiState.theme === "auto" ? (prefersDark ? "dark" : "light") : uiState.theme;
    document.documentElement.dataset.theme = resolved;
    announceUi();
  }

  function renderSummary() {
    const busy = state.jobs.filter((job) => job.status === "active").length;
    const free = editors().filter((editor) => suiteForEditor(editor.id) && !activeJobForEditor(editor.id) && !editor.onBreak).length;
    const queued = state.jobs.filter((job) => job.status === "planned" || job.status === "parked").length;
    const unused = suiteNumbers.filter((suite) => !state.suites[suite] && suiteModeFor(suite) === "unused").length;

    summaryStrip.innerHTML = `
      ${summaryButton("busy", "Busy", busy, "red", "Current live jobs")}
      ${summaryButton("free", "Free", free, "green", "Editors ready now")}
      ${summaryButton("pool", "Queue", queued, "amber", "Incoming jobs")}
      ${summaryButton("unused", "Unused", unused, "grey", "Suites available to staff")}
    `;
    summaryStrip.querySelectorAll("[data-summary]").forEach((button) => {
      button.addEventListener("click", () => openSummary(button.dataset.summary));
    });
  }

  function summaryButton(key, label, value, tone, caption) {
    const icons = {
      busy: '<circle cx="12" cy="12" r="9"/><path d="m10 8 6 4-6 4Z"/>',
      free: '<circle cx="9" cy="7" r="4"/><path d="M3 21v-2a6 6 0 0 1 12 0v2m1-9 2 2 4-4"/>',
      pool: '<path d="m3 12 3-8h12l3 8v8H3ZM3 12h5l2 3h4l2-3h5"/>',
      unused: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M9 10h6m-3 7v4m-4 0h8"/>'
    };
    return `<button class="summary-item ${tone}" data-summary="${key}" type="button" aria-haspopup="dialog"${key === "busy" ? ' aria-keyshortcuts="B"' : key === "pool" ? ' aria-keyshortcuts="Q" title="Queue (Q)"' : ""}>
      <span class="summary-icon" aria-hidden="true"><svg viewBox="0 0 24 24">${icons[key]}</svg></span>
      <span class="summary-copy"><small>${label}</small><em>${caption}</em></span>
      <strong>${value}</strong>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
    </button>`;
  }

  function renderEditorRadar() {
    if (!editors().length) {
      editorRadar.innerHTML = emptyState("No editors on shift", "Add this day's first editor below.");
      return;
    }

    editorRadar.innerHTML = editors().map((editor) => {
      const suite = suiteForEditor(editor.id);
      const fixedShiftLead = editor.id === "ed-shift-lead";
      const assignmentLocked = fixedShiftLead || Boolean(activeJobForEditor(editor.id)) || editor.onBreak;
      const editing = editingEditorId === editor.id;
      return `
        <div class="editor-assignment-row" data-editor-row="${editor.id}">
          ${editing ? `
            <form class="editor-inline-rename" data-editor-rename-form="${editor.id}">
              <input name="editorName" value="${escapeHtml(editor.name)}" maxlength="80" required aria-label="Editor name" />
              <button class="editor-row-text-button save" type="submit">Save</button>
              <button class="editor-row-text-button" data-editor-rename-cancel type="button">Cancel</button>
            </form>
          ` : `
            <strong>${escapeHtml(editor.name)}</strong>
            <select data-editor-suite="${editor.id}" aria-label="Edit suite for ${escapeHtml(editor.name)}" ${assignmentLocked ? "disabled" : ""}>${suiteOptions(editor.id, suite)}</select>
            <details class="editor-row-menu">
              <summary aria-label="Actions for ${escapeHtml(editor.name)}" title="Editor actions">•••</summary>
              <div class="editor-row-menu-panel">
                <button data-editor-rename="${editor.id}" type="button">Rename</button>
                ${fixedShiftLead ? "" : `<button class="danger" data-editor-remove="${editor.id}" type="button">Remove from today</button>`}
              </div>
            </details>
          `}
        </div>
      `;
    }).join("");
    editorRadar.querySelectorAll("[data-editor-suite]").forEach((select) => {
      select.addEventListener("change", () => assignSuiteToEditor(select.dataset.editorSuite, select.value));
    });
    editorRadar.querySelectorAll("[data-editor-rename]").forEach((button) => {
      button.addEventListener("click", () => {
        editingEditorId = button.dataset.editorRename;
        renderEditorRadar();
        const input = editorRadar.querySelector(`[data-editor-rename-form="${editingEditorId}"] input`);
        input?.focus();
        input?.select();
      });
    });
    editorRadar.querySelectorAll("[data-editor-rename-form]").forEach((form) => {
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        renameEditor(form.dataset.editorRenameForm, new FormData(form).get("editorName"));
      });
    });
    editorRadar.querySelectorAll("[data-editor-rename-cancel]").forEach((button) => {
      button.addEventListener("click", () => {
        editingEditorId = null;
        renderEditorRadar();
      });
    });
    editorRadar.querySelectorAll("[data-editor-remove]").forEach((button) => {
      button.addEventListener("click", () => removeEditorFromToday(button.dataset.editorRemove));
    });
    document.getElementById("newEditorSuite").innerHTML = suiteOptions("new-editor", null);
  }

  function renderSuites() {
    suiteGrid.classList.toggle("compact-suites", uiState.compactSuites);
    suiteGrid.classList.toggle("condensed-empty-suites", uiState.emptySuitePresentation === "condensed");
    const visibleSuites = suiteNumbers.filter((suite) => {
      if (uiState.emptySuitePresentation === "hidden" && !state.suites[suite] && suiteModeFor(suite) === "unused") return false;
      if (suiteStatusFilter === "all") return true;
      const editor = editorById(state.suites[suite]);
      const activeJobs = activeJobsForSuite(suite);
      if (suiteStatusFilter === "free") return Boolean(editor) && !editor.onBreak && !activeJobs.length;
      if (suiteStatusFilter === "assigned") return Boolean(editor);
      return Boolean(activeJobs.length);
    });
    suiteGrid.classList.toggle("suite-filter-empty", visibleSuites.length === 0);
    if (!visibleSuites.length) {
      const emptyMessages = {
        free: ["Nobody free", "No staffed editors are currently available."],
        busy: ["Nobody busy", "No edit suites currently have live work."],
        assigned: ["Nobody assigned", "No editors are assigned to edit suites."]
      };
      const [title, message] = emptyMessages[suiteStatusFilter] || emptyMessages.busy;
      suiteGrid.innerHTML = emptyState(title, message);
      return;
    }
    suiteGrid.innerHTML = visibleSuites.map((suite) => {
      const editorId = state.suites[suite];
      const editor = editorById(editorId);
      const activeJobs = activeJobsForSuite(suite);
      const queued = queuedJobsForSuite(suite);
      const plannedAssignments = editor ? plannedJobsForEditor(editor.id) : [];
      const hasProtectedWork = activeJobs.some((job) => isProtectedWork(job.workType));
      const hasOffRotaWork = activeJobs.some((job) => job.priority === "off-rota");
      const showPlannedAssignments = Boolean(editor && !editor.onBreak && !activeJobs.length && !queued.length && plannedAssignments.length);
      const suiteMode = suiteModeFor(suite);
      const reserved = !editor && suiteMode !== "unused";
      const needsRepair = !editor && suiteMode === "repair";
      const status = editor?.onBreak ? "break" : hasOffRotaWork ? "off-rota" : activeJobs.length ? "busy" : editor ? "free" : reserved ? `reserved ${suiteMode}` : "empty";
      const statusText = editor?.onBreak ? "On break" : hasOffRotaWork ? "Off Rota" : activeJobs.length ? "Busy" : editor ? "Free" : suiteUseLabels[suiteMode];
      const statusMarkup = editor
        ? `<span class="status-label"><i></i>${statusText}</span>`
        : `<label class="suite-use-control mode-${suiteMode}"><i></i><select data-suite-use="${suite}" aria-label="Use of ${escapeHtml(suiteFullLabel(suite))}">${suiteUseOptions(suiteMode)}</select></label>`;
      const condensedEmpty = uiState.emptySuitePresentation === "condensed" && !editor && suiteMode === "unused";
      if (condensedEmpty) {
        return `
          <article class="suite-card empty condensed-empty" data-suite-card="${suite}">
            <div class="suite-condensed-empty-row">
              <span class="suite-number" title="${escapeHtml(suiteFullLabel(suite))}">${escapeHtml(suiteLabel(suite))}</span>
              ${statusMarkup}
            </div>
          </article>
        `;
      }
      const canFastTrack = editor && !editor.onBreak && (allowsConcurrentRunning(editor.id, suite) || !activeJobs.length);
      const fastTrackMarkup = editor ? `<button class="suite-break-icon suite-fast-track-icon" data-fast-track-suite="${suite}" type="button" ${canFastTrack ? "" : "disabled"} aria-label="Fast Track job for ${escapeHtml(editor.name)} in ${escapeHtml(suiteLabel(suite))}" title="${editor.onBreak ? "Editor is on break" : activeJobs.length && !allowsConcurrentRunning(editor.id, suite) ? "Finish or pause the current job first" : "Fast Track job"}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
      </button>` : "";
      const breakMarkup = editor ? `<button class="suite-break-icon ${editor.onBreak ? "active" : ""}" data-suite-break="${editor.id}" type="button" aria-label="${editor.onBreak ? "Return " + escapeHtml(editor.name) + " from break" : "Put " + escapeHtml(editor.name) + " on break"}" title="${editor.onBreak ? "Return from break" : "Take a break"}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8h11v5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5V8Z" /><path d="M16 10h1.5a2.5 2.5 0 0 1 0 5H16M7 4v2M11 4v2M15 4v2" /></svg>
      </button>` : "";
      const editorMarkup = editor
        ? `<div class="suite-editor">
            <button class="suite-editor-avatar editor-history-trigger" data-editor-history="${editor.id}" type="button" aria-label="View ${escapeHtml(editor.name)}'s work">${escapeHtml(editor.initials)}</button>
            <div><strong>${escapeHtml(editor.name)}</strong>${showPlannedAssignments ? `<span class="suite-assigned-status">Free · ${plannedAssignments.length} ${plannedAssignments.length === 1 ? "job" : "jobs"} assigned</span>` : ""}</div>
          </div>`
        : `<div class="suite-editor"><span class="suite-editor-avatar">—</span><div><strong>No editor</strong><span>${reserved ? "Unavailable for editor assignment" : "Assign in the editor list above"}</span></div></div>`;

      return `
        <article class="suite-card ${status} ${hasProtectedWork ? "protected-work" : ""} ${hasOffRotaWork ? "off-rota-work" : ""} ${editor ? "staffed" : ""} ${queued.length ? "has-queued-jobs" : ""} ${showPlannedAssignments ? "has-assigned-jobs" : ""}" data-suite-card="${suite}">
          <div class="suite-inner">
            <div class="suite-identity-row">
              ${editorMarkup}
              <div class="suite-control-stack">
                <div class="suite-heading-row">${fastTrackMarkup}${breakMarkup}<span class="suite-number" title="${escapeHtml(suiteFullLabel(suite))}">${escapeHtml(suiteLabel(suite))}</span></div>
                <div class="suite-top-actions">${statusMarkup}</div>
              </div>
            </div>
            ${needsRepair ? '<div class="suite-repair-banner" role="status"><span>Not in use</span><strong>Repair needed</strong></div>' : ""}
            ${renderSuiteWork(editor, activeJobs, queued)}
          </div>
        </article>
      `;
    }).join("");

    suiteGrid.querySelectorAll("[data-suite-use]").forEach((select) => {
      select.addEventListener("change", () => updateSuiteUse(Number(select.dataset.suiteUse), select.value));
    });
    suiteGrid.querySelectorAll("[data-complete-job]").forEach((button) => {
      button.addEventListener("click", () => completeJob(button.dataset.completeJob));
    });
    suiteGrid.querySelectorAll("[data-park-job]").forEach((button) => {
      button.addEventListener("click", () => parkJob(button.dataset.parkJob));
    });
    suiteGrid.querySelectorAll("[data-start-queued]").forEach((button) => {
      button.addEventListener("click", () => startQueuedJob(button.dataset.startQueued));
    });
    suiteGrid.querySelectorAll("[data-unqueue-job]").forEach((button) => {
      button.addEventListener("click", () => returnQueuedToPool(button.dataset.unqueueJob));
    });
    suiteGrid.querySelectorAll("[data-biff-job]").forEach((button) => {
      button.addEventListener("click", () => biffJob(button.dataset.biffJob));
    });
    suiteGrid.querySelectorAll("[data-suite-break]").forEach((button) => {
      button.addEventListener("click", () => toggleBreak(button.dataset.suiteBreak));
    });
    suiteGrid.querySelectorAll("[data-fast-track-suite]").forEach((button) => {
      button.addEventListener("click", () => openFastTrackDialog(Number(button.dataset.fastTrackSuite)));
    });
    bindJobDetailTriggers(suiteGrid);
    bindEditorHistoryTriggers(suiteGrid);
  }

  function renderSuiteWork(editor, activeJobs, queued) {
    if (!editor) return "";

    const activeMarkup = activeJobs.map((active) => `
      <div class="active-job suite-job-card ${isProtectedWork(active.workType) ? "protected-work" : ""} ${editor.onBreak ? "paused" : ""} ${dueWarningClass(active)}">
        <div class="active-job-copy">
          <div class="active-title-row">
            <span class="work-type ${cssSlug(active.workType)}">${escapeHtml(active.workType)}</span>
            ${editor.onBreak ? '<span class="paused-label">Paused</span>' : ""}
          </div>
          <button class="job-detail-trigger active-job-title" data-job-details="${escapeHtml(active.id)}" type="button" title="View details for ${escapeHtml(active.title)}">${escapeHtml(active.title)}</button>
          <div class="active-job-meta">
            ${active.type ? `<span class="active-format">${escapeHtml(active.type)}</span>${active.due ? '<span class="active-meta-divider" aria-hidden="true">|</span>' : ""}` : ""}
            ${active.due ? `<span class="active-due">Due ${escapeHtml(active.due)}</span>` : ""}
            ${dueWarningBadge(active)}
          </div>
        </div>
        <div class="active-actions">
          <button class="button button-park" data-park-job="${escapeHtml(active.id)}" type="button" ${editor.onBreak ? "disabled" : ""} aria-label="Pause ${escapeHtml(active.title)}" title="Pause job (stays in this suite)">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6v12M15 6v12" /></svg>
          </button>
          <button class="button button-complete" data-complete-job="${escapeHtml(active.id)}" type="button" ${editor.onBreak ? "disabled" : ""} aria-label="Complete ${escapeHtml(active.title)}" title="Complete job">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>
          </button>
          <button class="button button-biff" data-biff-job="${escapeHtml(active.id)}" type="button" aria-label="Biff ${escapeHtml(active.title)}" title="Biff job">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></svg>
          </button>
        </div>
      </div>`).join("");

    const canRunConcurrently = allowsConcurrentRunning(editor.id);
    // Paused jobs (top of the list) and the first job that is only waiting can start (issue #11).
    const firstWaiting = Math.max(0, queued.findIndex((job) => !job.pausedInSuite)) || queued.filter((job) => job.pausedInSuite).length;

    const queueMarkup = queued.length ? `
      <div class="coming-up-divider"><span>Coming up next</span></div>
      <div class="suite-queue">${queued.map((job, index) => `
        <div class="queued-job suite-job-card ${isProtectedWork(job.workType) ? "protected-work" : ""} ${dueWarningClass(job)}">
          <div class="queue-position">${index + 1}</div>
          <div class="queued-job-copy"><button class="job-detail-trigger queued-job-title" data-job-details="${escapeHtml(job.id)}" type="button" title="View details for ${escapeHtml(job.title)}"><strong>${escapeHtml(job.title)}</strong>${job.pausedInSuite ? ' <span class="paused-label">Paused</span>' : ""}</button><div class="queued-job-meta"><span>${escapeHtml(job.workType)}${job.due ? ` · ${escapeHtml(job.due)}` : ""}</span>${dueWarningBadge(job)}</div></div>
          <div class="queued-job-actions">
            <button class="queue-start-button" data-start-queued="${escapeHtml(job.id)}" type="button" ${editor.onBreak || (!canRunConcurrently && (activeJobs.length || index > firstWaiting)) ? "disabled" : ""} aria-label="${job.pausedInSuite ? "Resume" : "Start"} ${escapeHtml(job.title)}" title="${job.pausedInSuite ? "Resume job" : "Start job"}">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7Z" /></svg>
            </button>
            <button class="queue-return-button" data-unqueue-job="${escapeHtml(job.id)}" type="button" aria-label="Return ${escapeHtml(job.title)} to the Job Queue" title="Return to Job Queue">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 7-5 5 5 5M4 12h10a6 6 0 0 1 6 6" /></svg>
            </button>
            <button class="queue-biff-button" data-biff-job="${escapeHtml(job.id)}" type="button" aria-label="Biff ${escapeHtml(job.title)}" title="Biff job">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></svg>
            </button>
          </div>
        </div>`).join("")}</div>` : "";

    return `${activeMarkup}${queueMarkup}`;
  }

  function renderPlannedJobs() {
    const jobs = sortQueueJobs(state.jobs.filter((job) => job.status === "planned" || job.status === "parked"));
    poolCount.textContent = String(jobs.length);
    plannedJobs.classList.toggle("is-empty", !jobs.length);
    plannedJobs.classList.toggle("compact-job-cards", uiState.compactQueueCards);

    if (!jobs.length) {
      plannedJobs.innerHTML = `
        <div class="queue-empty-state">
          <p>Add a new job to the queue.</p>
          <button class="button button-primary queue-empty-new-job" data-empty-new-job type="button">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
            New job
          </button>
        </div>`;
      plannedJobs.querySelector("[data-empty-new-job]").addEventListener("click", () => openNewJobDialog(false));
      return;
    }

    plannedJobs.innerHTML = jobs.map((job) => {
      const readiness = getReadiness(job);
      return `
        <article class="job-card priority-${escapeHtml(job.priority === "flash" ? "top" : job.priority)} ${job.status === "parked" ? "parked-pool-card" : ""} ${dueWarningClass(job)}">
          <div class="job-topline">
            ${job.status === "parked" ? '<span class="pool-state parked">Parked</span>' : ""}
            ${uiState.queueMetadata.workType ? `<span class="work-type ${cssSlug(job.workType)}">${escapeHtml(job.workType)}</span>` : ""}
            ${uiState.queueMetadata.priority ? `<span class="priority ${escapeHtml(job.priority === "flash" ? "top" : job.priority)}">${escapeHtml(priorityLabel(job.priority))}</span>` : ""}
            ${job.due ? `<span class="due-cluster"><span class="due">${escapeHtml(job.due)}</span>${dueWarningBadge(job)}</span>` : ""}
            <button class="job-mini-action job-biff-icon" data-biff-job="${escapeHtml(job.id)}" type="button" aria-label="Biff ${escapeHtml(job.title)}" title="Biff job">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></svg>
            </button>
            <button class="job-edit-button" data-edit-job="${escapeHtml(job.id)}" type="button" aria-label="Edit ${escapeHtml(job.title)}">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" /></svg>
            </button>
          </div>
          <h3 class="job-title">${escapeHtml(job.title)}</h3>
          ${!uiState.compactQueueCards && uiState.queueMetadata.notes ? `<p class="job-note">${escapeHtml(job.note || "No additional brief notes")}</p>` : ""}
          ${uiState.queueMetadata.reporter ? `<div class="job-contact ${job.contact ? "" : "is-empty"}" ${job.contact ? "" : 'aria-hidden="true"'}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10" /></svg>
            <span>${escapeHtml(job.contact || "No reporter or producer assigned")}</span>
          </div>` : ""}
          ${!uiState.compactQueueCards && uiState.queueMetadata.editFormat && job.type ? `<div class="job-meta"><span>${escapeHtml(job.type)}</span></div>` : ""}
          ${""/* Issue #14: no "From editor · suite · time" line on parked cards; the Parked tag and the editor drop-down say it, and the history keeps the detail. */}
          ${uiState.compactQueueCards ? "" : `<div class="job-actions">
            <select class="assignee-select" data-job-assignee="${escapeHtml(job.id)}" aria-label="Editor pre-assigned to ${escapeHtml(job.title)}">
              ${editorOptions(job.editorId)}
            </select>
            ${readiness.ready ? `<button class="button button-primary push-button" data-push-job="${escapeHtml(job.id)}" type="button" title="${escapeHtml(readiness.message)}">Send to ${escapeHtml(editorById(job.editorId).name.split(" ")[0])}</button>` : ""}
          </div>`}
          ${""/* Issue #15: no status line on Job Queue cards; only explain when the picked editor can't take the job (no Send button then). */}
          ${job.editorId && !readiness.ready ? `<div class="readiness waiting">${escapeHtml(readiness.message)}</div>` : ""}
        </article>
      `;
    }).join("");

    plannedJobs.querySelectorAll("[data-job-assignee]").forEach((select) => {
      select.addEventListener("change", () => preassignJob(select.dataset.jobAssignee, select.value || null));
    });
    plannedJobs.querySelectorAll("[data-push-job]").forEach((button) => {
      button.addEventListener("click", () => pushJob(button.dataset.pushJob));
    });
    plannedJobs.querySelectorAll("[data-edit-job]").forEach((button) => {
      button.addEventListener("click", () => openEditJob(button.dataset.editJob));
    });
    plannedJobs.querySelectorAll("[data-biff-job]").forEach((button) => {
      button.addEventListener("click", () => biffJob(button.dataset.biffJob));
    });
  }

  function renderCompletedJobs() {
    const allJobs = state.jobs
      .filter((job) => job.status === "completed")
      .sort((a, b) => b.completedAt.localeCompare(a.completedAt));
    populateCompletedFilters(allJobs);
    const jobs = allJobs.filter((job) => {
      if (completedFilters.type && job.type !== completedFilters.type) return false;
      if (completedFilters.editor && job.completedBy !== completedFilters.editor) return false;
      if (completedFilters.suite && String(job.completedSuite) !== completedFilters.suite) return false;
      return true;
    });
    const filtersActive = Object.values(completedFilters).some(Boolean);
    completedCount.textContent = filtersActive ? `${jobs.length}/${allJobs.length}` : String(allJobs.length);

    if (!jobs.length) {
      completedJobs.innerHTML = emptyState(filtersActive ? "No matching jobs" : "No sign-offs yet", filtersActive ? "Try changing one of the filters." : "Completed jobs will appear here.");
      return;
    }

    completedJobs.innerHTML = jobs.map(completedCardMarkup).join("");
    bindJobHistoryTriggers(completedJobs);
  }

  function completedCardMarkup(job) {
    return `
      <button class="completed-card archive-card-trigger" data-job-history="${escapeHtml(job.id)}" type="button" aria-label="View history for ${escapeHtml(job.title)}">
        <span class="complete-check"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg></span>
        <div>
          <div class="completed-title-row"><h3>${escapeHtml(job.title)}</h3><span class="work-type ${cssSlug(job.workType)}">${escapeHtml(job.workType)}</span></div>
          <div class="complete-meta">
            ${job.type ? `<span>${escapeHtml(job.type)}</span>` : ""}
            <span>${escapeHtml(job.completedBy)}</span>
            <span>${escapeHtml(suiteLabel(job.completedSuite))}</span>
            <span class="time">${escapeHtml(job.completedAt)}</span>
          </div>
        </div>
      </button>
    `;
  }

  function populateCompletedFilters(jobs) {
    setFilterOptions(completedTypeFilter, "All types", [...new Set(jobs.map((job) => job.type).filter(Boolean))].sort(), completedFilters.type);
    setFilterOptions(completedEditorFilter, "All editors", [...new Set(jobs.map((job) => job.completedBy).filter(Boolean))].sort(), completedFilters.editor);
    setFilterOptions(completedSuiteFilter, "All suites", [...new Set(jobs.map((job) => String(job.completedSuite)).filter((suite) => suite !== "undefined"))].sort((a, b) => Number(a) - Number(b)), completedFilters.suite, "", (value) => suiteLabel(Number(value)));
  }

  function setFilterOptions(select, allLabel, values, selected, prefix = "", labelForValue = null) {
    select.innerHTML = `<option value="">${allLabel}</option>${values.map((value) => `<option value="${escapeHtml(value)}"${value === selected ? " selected" : ""}>${escapeHtml(labelForValue ? labelForValue(value) : prefix + value)}</option>`).join("")}`;
  }

  function renderBiffedJobs() {
    const jobs = state.jobs
      .filter((job) => job.status === "biffed")
      .sort((a, b) => (b.biffedAt || "").localeCompare(a.biffedAt || ""));
    biffedCount.textContent = String(jobs.length);

    if (!jobs.length) {
      biffedJobs.innerHTML = emptyState("Nothing biffed", "Stories removed from this day's running order will appear here.");
      return;
    }

    biffedJobs.innerHTML = jobs.map((job) => `
      <button class="biffed-card archive-card-trigger" data-job-history="${escapeHtml(job.id)}" type="button" aria-label="View history for ${escapeHtml(job.title)}">
        <span class="biffed-mark"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" /></svg></span>
        <div>
          <div class="completed-title-row"><h3>${escapeHtml(job.title)}</h3><span class="work-type ${cssSlug(job.workType)}">${escapeHtml(job.workType)}</span></div>
          <div class="biffed-meta">
            ${job.type ? `<span>${escapeHtml(job.type)}</span>` : ""}
            <span>${escapeHtml(job.biffedEditor || "Unassigned")}</span>
            ${job.biffedSuite ? `<span>${escapeHtml(suiteLabel(job.biffedSuite))}</span>` : ""}
            <span class="time">${escapeHtml(job.biffedAt || "")}</span>
          </div>
        </div>
      </button>
    `).join("");
    bindJobHistoryTriggers(biffedJobs);
  }

  function suiteOptions(editorId, currentSuite) {
    return '<option value="">Unassigned</option>' + suiteNumbers.map((suite) => {
      const occupantId = state.suites[suite];
      const occupant = editorById(occupantId);
      const selected = suite === currentSuite ? " selected" : "";
      const unavailableUse = !occupantId && suiteModeFor(suite) !== "unused";
      const locked = (suite === 1 && editorId !== "ed-shift-lead") || unavailableUse || (suite !== currentSuite && Boolean(activeJobForSuite(suite) || occupant?.onBreak));
      const suffix = unavailableUse ? ` · ${suiteUseLabels[suiteModeFor(suite)]} · unavailable` : occupantId && occupantId !== editorId ? ` · ${occupant.name}${locked ? " · locked" : ""}` : "";
      return `<option value="${suite}"${selected}${locked ? " disabled" : ""}>${escapeHtml(suiteLabel(suite))}${escapeHtml(suffix)}</option>`;
    }).join("");
  }

  function suiteUseOptions(selectedMode) {
    return Object.entries(suiteUseLabels).map(([value, label]) => `<option value="${value}"${value === selectedMode ? " selected" : ""}>${label}</option>`).join("");
  }

  function openSummary(kind) {
    const content = summaryContent(kind);
    document.getElementById("detailEyebrow").textContent = content.eyebrow;
    document.getElementById("detailTitle").textContent = content.title;
    document.getElementById("detailAddJobButton").hidden = kind !== "pool";
    detailList.innerHTML = content.items.length
      ? content.items.map((item) => `
        <article class="detail-row ${item.tone || ""} ${item.variant || ""}">
          ${item.initials ? `<button class="detail-avatar editor-history-trigger" data-editor-history="${escapeHtml(item.editorId)}" type="button" aria-label="View ${escapeHtml(item.title)}'s work">${escapeHtml(item.initials)}</button>` : '<span class="detail-dot"></span>'}
          <div class="detail-copy"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.detail)}</span></div>
          ${item.meta || item.suite ? `<div class="detail-trailing">${item.meta ? `<em>${escapeHtml(item.meta)}</em>` : ""}${item.job ? dueWarningBadge(item.job) : ""}${item.suite ? `<span class="detail-suite">${escapeHtml(item.suite)}</span>` : ""}</div>` : ""}
        </article>`).join("")
      : emptyState(content.emptyTitle, content.emptyMessage);
    bindEditorHistoryTriggers(detailList);
    if (!detailDialog.open) detailDialog.showModal();
  }

  function summaryContent(kind) {
    if (kind === "busy") {
      const items = state.jobs.filter((job) => job.status === "active").map((job) => {
        const editor = editorById(job.editorId);
        return { title: job.title, detail: `${editor?.name || "Unassigned"}${editor?.onBreak ? " · On break, paused" : ""}`, meta: job.due, job, suite: job.suite ? suiteLabel(job.suite) : "No suite", tone: editor?.onBreak ? "break" : "busy", variant: "busy-summary" };
      });
      return { eyebrow: "Current work", title: "Busy editors & jobs", items, emptyTitle: "Nothing live", emptyMessage: "No editors are currently busy." };
    }
    if (kind === "free") {
      const items = editors().filter((editor) => suiteForEditor(editor.id) && !activeJobForEditor(editor.id) && !editor.onBreak).map((editor) => {
        const assignedCount = plannedJobsForEditor(editor.id).length;
        const assignedLabel = assignedCount ? ` · ${assignedCount} ${assignedCount === 1 ? "job" : "jobs"} assigned` : "";
        return { title: editor.name, detail: `Free${assignedLabel}`, initials: editor.initials, editorId: editor.id, suite: suiteLabel(suiteForEditor(editor.id)), tone: "free", variant: `editor-summary${assignedCount ? " has-assigned-jobs" : ""}` };
      });
      return { eyebrow: "Availability", title: "Free editors", items, emptyTitle: "Nobody free", emptyMessage: "Every staffed editor is busy or on break." };
    }
    if (kind === "pool") {
      const items = state.jobs.filter((job) => job.status === "planned" || job.status === "parked").map((job) => ({
        title: job.title,
        detail: `${job.status === "parked" ? "Parked · " : ""}${job.workType} · ${editorById(job.editorId)?.name || "Unassigned"}`,
        meta: job.due,
        job,
        tone: "pool",
        variant: job.status === "parked" ? "parked-summary" : `priority-${job.priority === "flash" ? "top" : job.priority}`
      }));
      return { eyebrow: "Incoming / planned", title: "Job Queue", items, emptyTitle: "Queue cleared", emptyMessage: "There are no incoming jobs." };
    }
    const items = suiteNumbers.filter((suite) => !state.suites[suite] && suiteModeFor(suite) === "unused").map((suite) => ({ title: suiteLabel(suite), detail: "No editor assigned · suite available", tone: "unused" }));
    return { eyebrow: "Suite availability", title: "Unused edit suites", items, emptyTitle: "No unused suites", emptyMessage: "Every suite is staffed or marked for another use." };
  }

  function bindEditorHistoryTriggers(root) {
    root.querySelectorAll("[data-editor-history]").forEach((button) => {
      button.addEventListener("click", () => openEditorHistory(button.dataset.editorHistory));
    });
  }

  function bindJobHistoryTriggers(root) {
    root.querySelectorAll("[data-job-history]").forEach((button) => {
      button.addEventListener("click", () => openJobHistory(button.dataset.jobHistory));
    });
  }

  function bindJobDetailTriggers(root) {
    root.querySelectorAll("[data-job-details]").forEach((button) => {
      button.addEventListener("click", () => openJobDetails(button.dataset.jobDetails));
    });
  }

  function openJobDetails(jobId) {
    const job = state.jobs.find((item) => item.id === jobId);
    if (!job) return;
    const editor = editorById(job.editorId);
    const statusLabels = { active: "Editing now", queued: "Coming up next", parked: "Parked", planned: "Job Queue", completed: "Completed", biffed: "Biffed" };
    const detailField = (label, value) => `<div class="job-detail-field"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;

    document.getElementById("detailEyebrow").textContent = "Job details";
    document.getElementById("detailTitle").textContent = job.title;
    document.getElementById("detailAddJobButton").hidden = true;
    detailList.innerHTML = `<div class="job-detail-grid">
      ${detailField("Status", statusLabels[job.status] || job.status)}
      ${detailField("Editor", editor?.name || "Unassigned")}
      ${detailField("Edit suite", job.suite ? suiteLabel(job.suite) : "No suite assigned")}
      ${detailField("Work category", job.workType || "Not set")}
      ${detailField("Edit format", job.type || "Not applicable")}
      ${detailField("Priority", priorityLabel(job.priority))}
      ${detailField("Due", job.due || "No due time")}
      ${detailField("Reporter / producer", job.contact || "Not provided")}
      <div class="job-detail-field job-detail-note"><span>Brief note</span><strong>${escapeHtml(job.note || "No additional brief notes")}</strong></div>
    </div>`;
    if (!detailDialog.open) detailDialog.showModal();
  }

  function openJobHistory(jobId) {
    const job = state.jobs.find((item) => item.id === jobId && ["completed", "biffed"].includes(item.status));
    if (!job) return;
    document.getElementById("detailEyebrow").textContent = job.status === "completed" ? "Completed job history" : "Biffed job history";
    document.getElementById("detailTitle").textContent = job.title;
    document.getElementById("detailAddJobButton").hidden = true;

    detailList.innerHTML = jobHistoryCardMarkup(job);
    if (!detailDialog.open) detailDialog.showModal();
  }

  function jobHistoryCardMarkup(job, archiveEditors = null) {
    if (!Array.isArray(job.history) || !job.history.length) {
      return '<p class="job-history-unavailable">Detailed history was not recorded for this earlier job.</p>';
    } else {
      const metrics = jobHistoryMetrics(job.history);
      return `
        <div class="job-history-summary">
          <div><span>Turnaround</span><strong>${escapeHtml(formatDuration(metrics.turnaround))}</strong></div>
          <div><span>Active editing</span><strong>${escapeHtml(metrics.active === null ? "Not started" : formatDuration(metrics.active))}</strong></div>
        </div>
        <ol class="job-history-timeline">
          ${job.history.map((event, index, history) => jobHistoryEventMarkup(event, history[index - 1], archiveEditors)).join("")}
        </ol>`;
    }
  }

  function jobHistoryEventMarkup(event, previousEvent, archiveEditors = null) {
    const copy = jobHistoryEventCopy(event, previousEvent, archiveEditors);
    return `
      <li class="job-history-event ${escapeHtml(copy.tone)}">
        <span class="job-history-marker" aria-hidden="true"></span>
        <div><strong>${escapeHtml(copy.title)}</strong>${copy.detail ? `<span>${escapeHtml(copy.detail)}</span>` : ""}</div>
        <time datetime="${escapeHtml(event.at)}">${escapeHtml(formatEventTime(event.at))}</time>
      </li>`;
  }

  function jobHistoryEventCopy(event, previousEvent, archiveEditors = null) {
    const resolveEditor = (id) => archiveEditors ? archiveEditors.find((editor) => editor.id === id) : editorById(id);
    const editor = event.editorName || resolveEditor(event.editorId)?.name || "Unassigned";
    const previousEditor = event.previousEditorName || resolveEditor(event.previousEditorId)?.name || "Unassigned";
    const suite = event.suite ? suiteLabel(event.suite) : "No suite";
    const copies = {
      created: { title: "Job created", detail: "Added to the Job Queue", tone: "created" },
      assigned: { title: event.previousEditorId ? `Reassigned to ${editor}` : `Assigned to ${editor}`, detail: suite, tone: "assigned" },
      unassigned: { title: "Returned to the open queue", detail: `Previously assigned to ${previousEditor}${event.suite ? ` · ${suite}` : ""}`, tone: "returned" },
      queued: { title: `Sent to ${editor}`, detail: `Queued in ${suite}`, tone: "queued" },
      started: { title: "Editing started", detail: `${editor} · ${suite}`, tone: "started" },
      resumed: previousEvent?.type === "paused"
        ? { title: "Returned from break", detail: `${editor} · ${suite}`, tone: "started" }
        : { title: "Editing resumed", detail: `${editor} · ${suite}`, tone: "started" },
      paused: { title: "Editing paused", detail: `${editor} went on break`, tone: "paused" },
      break_started: { title: "Break started", detail: `${editor} paused editing`, tone: "paused" },
      break_ended: { title: "Returned from break", detail: `${editor} · ${suite}`, tone: "started" },
      parked: { title: "Job parked", detail: `${editor} · ${suite}`, tone: "parked" },
      paused_in_suite: { title: "Job paused", detail: `Kept in ${suite} under Coming up next`, tone: "parked" },
      returned: { title: "Returned to the Job Queue", detail: event.editorId ? `From ${editor} · ${suite}` : "Unassigned", tone: "returned" },
      moved: { title: `Moved with ${editor}`, detail: suite, tone: "assigned" },
      completed: { title: "Job completed", detail: `${editor} · ${suite}`, tone: "completed" },
      biffed: { title: "Job Biffed", detail: event.editorId ? `${editor} · ${suite}` : "Removed from the running order", tone: "biffed" }
    };
    return copies[event.type] || { title: "Job updated", detail: "", tone: "created" };
  }

  function jobHistoryMetrics(history) {
    const valid = history.filter((event) => Number.isFinite(Date.parse(event.at)));
    const created = valid.find((event) => event.type === "created");
    const terminal = [...valid].reverse().find((event) => event.type === "completed" || event.type === "biffed");
    const turnaround = created && terminal ? Math.max(0, Date.parse(terminal.at) - Date.parse(created.at)) : null;
    let activeStart = null;
    let active = 0;
    let hadActivePeriod = false;
    valid.forEach((event) => {
      const at = Date.parse(event.at);
      if (["started", "resumed", "break_ended"].includes(event.type) && activeStart === null) {
        activeStart = at;
        hadActivePeriod = true;
      }
      if (["paused", "break_started", "parked", "completed", "biffed"].includes(event.type) && activeStart !== null) {
        active += Math.max(0, at - activeStart);
        activeStart = null;
      }
    });
    return { turnaround, active: hadActivePeriod ? active : null };
  }

  function formatDuration(milliseconds) {
    if (!Number.isFinite(milliseconds)) return "Unavailable";
    const minutes = Math.max(0, Math.round(milliseconds / 60000));
    if (minutes < 1) return "Under 1 min";
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    return `${hours} hr${hours === 1 ? "" : "s"}${remainder ? ` ${remainder} min` : ""}`;
  }

  function formatEventTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  }

  function openEditorHistory(editorId) {
    const editor = editorById(editorId);
    if (!editor) return;

    const statusOrder = { active: 0, queued: 1, parked: 2, planned: 3 };
    const currentJobs = state.jobs
      .filter((job) => job.editorId === editorId && Object.hasOwn(statusOrder, job.status))
      .sort((a, b) => statusOrder[a.status] - statusOrder[b.status] || (a.due || "99:99").localeCompare(b.due || "99:99"));
    const completed = state.jobs
      .filter((job) => job.status === "completed" && (job.editorId === editorId || job.completedBy === editor.name))
      .sort((a, b) => b.completedAt.localeCompare(a.completedAt));

    document.getElementById("detailEyebrow").textContent = "Editor work";
    document.getElementById("detailTitle").textContent = editor.name;
    document.getElementById("detailAddJobButton").hidden = true;

    const currentMarkup = currentJobs.length
      ? `<p class="editor-history-label">Active & incoming</p>${currentJobs.map((job) => editorCurrentWorkMarkup(job, editor)).join("")}`
      : '<p class="editor-history-empty">No active or incoming jobs.</p>';
    const completedMarkup = completed.length
      ? `<p class="editor-history-label">Completed</p>${completed.map(completedCardMarkup).join("")}`
      : '<p class="editor-history-label">Completed</p><p class="editor-history-empty">No completed jobs yet.</p>';

    detailList.innerHTML = `<div class="editor-history">${currentMarkup}${completedMarkup}</div>`;
    bindJobHistoryTriggers(detailList);
    if (!detailDialog.open) detailDialog.showModal();
  }

  function openDayPulse() {
    // Day Pulse workloads are ordered and scaled by active editing time.
    const categoryColours = ["#4f9fcb", "#55a980", "#c9913f", "#9a70c2", "#c85d72", "#6d879f"];
    const colourForCategory = (category) => {
      const value = [...String(category || "")].reduce((total, character) => total + character.charCodeAt(0), 0);
      return categoryColours[value % categoryColours.length];
    };
    const editingDuration = (job, editor) => {
      const metrics = jobHistoryMetrics(job.history || []);
      let elapsed = metrics.active || 0;
      if (job.status === "active" && !editor.onBreak) {
        const events = (job.history || []).filter((event) => Number.isFinite(Date.parse(event.at)));
        const started = [...events].reverse().find((event) => ["started", "resumed", "break_ended"].includes(event.type));
        const paused = [...events].reverse().find((event) => ["paused", "break_started", "parked", "completed", "biffed"].includes(event.type));
        if (started && (!paused || Date.parse(started.at) > Date.parse(paused.at))) elapsed += Math.max(0, Date.now() - Date.parse(started.at));
      }
      return elapsed;
    };
    const activityByEditor = editors().map((editor) => {
      const jobs = state.jobs.filter((job) => job.editorId === editor.id || job.completedBy === editor.name);
      return { editor, jobs, total: jobs.length, minutes: jobs.reduce((sum, job) => sum + editingDuration(job, editor), 0) };
    }).sort((a, b) => b.minutes - a.minutes || b.total - a.total);
    const largestMinutes = Math.max(1, ...activityByEditor.map((item) => item.minutes));
    const editorRows = activityByEditor.map(({ editor, jobs, total, minutes }) => {
      const completed = jobs.filter((job) => job.status === "completed").length;
      const active = jobs.filter((job) => job.status === "active").length;
      const queued = jobs.filter((job) => ["queued", "planned", "parked"].includes(job.status)).length;
      if (!completed && !active && !queued) return "";
      const suite = suiteForEditor(editor.id);
      const categoryMinutes = new Map();
      jobs.forEach((job) => categoryMinutes.set(job.workType, (categoryMinutes.get(job.workType) || 0) + editingDuration(job, editor)));
      const segments = [...categoryMinutes.entries()].map(([category, duration]) => `<span title="${escapeHtml(category)} · ${formatDuration(duration)}" style="flex:${Math.max(1, duration)};background:${colourForCategory(category)}"></span>`).join("");
      return `<article class="detail-row">
        <button class="detail-avatar editor-history-trigger" data-editor-history="${escapeHtml(editor.id)}" type="button" aria-label="View ${escapeHtml(editor.name)}'s work">${escapeHtml(editor.initials || "—")}</button>
        <div class="detail-copy"><strong>${escapeHtml(editor.name)}</strong><span>${suite ? escapeHtml(suiteLabel(suite)) : "No suite assigned"}</span><div class="day-pulse-bar" style="width:${Math.max(22, (minutes / largestMinutes) * 100)}%">${segments}</div></div>
        <em>${total} job${total === 1 ? "" : "s"}<small>${formatDuration(minutes)}</small></em>
      </article>`;
    }).filter(Boolean).join("") || '<p class="editor-history-empty">No editor activity recorded for this day.</p>';

    const categories = new Map();
    state.jobs.forEach((job) => categories.set(job.workType, (categories.get(job.workType) || 0) + 1));
    const categoryRows = [...categories.entries()].sort((a, b) => b[1] - a[1]).map(([category, count]) =>
      `<span class="day-pulse-category"><i style="background:${colourForCategory(category)}"></i><strong>${escapeHtml(category)}</strong><em>${count}</em></span>`
    ).join("") || '<p class="editor-history-empty">No jobs recorded for this day.</p>';

    document.getElementById("detailEyebrow").textContent = "Daily overview";
    document.getElementById("detailTitle").textContent = `Day pulse · ${formattedBoardDate(selectedDateKey, { short: true })}`;
    document.getElementById("detailAddJobButton").hidden = true;
    detailList.innerHTML = `<div class="editor-history"><p class="editor-history-label">Editor activity</p>${editorRows}<p class="editor-history-label">Work categories</p><div class="day-pulse-categories">${categoryRows}</div><button class="button button-primary day-pulse-handover" id="createHandoverButton" type="button" aria-keyshortcuts="H">Create handover</button></div>`;
    bindEditorHistoryTriggers(detailList);
    document.getElementById("createHandoverButton").addEventListener("click", openHandover);
    if (!detailDialog.open) detailDialog.showModal();
  }

  function openHandover() {
    handoverManualJobs = [];
    const remainingEditors = editors()
      .map((editor) => ({ editor, suite: suiteForEditor(editor.id) }))
      .filter(({ editor, suite }) => editor.id !== "ed-shift-lead" && suite && suite !== 1);
    const runningJobs = state.jobs.filter((job) => job.status === "active");
    const queueJobs = state.jobs.filter((job) => ["planned", "parked", "queued"].includes(job.status));

    document.getElementById("handoverEditors").innerHTML = remainingEditors.length
      ? remainingEditors.map(({ editor, suite }) => `<label class="handover-option"><input type="checkbox" data-handover-editor="${escapeHtml(editor.id)}" checked /><span><strong>${escapeHtml(suiteLabel(suite))}: ${escapeHtml(editor.name)}</strong><small>Shift end time</small></span><input type="time" data-handover-shift-end="${escapeHtml(editor.id)}" aria-label="${escapeHtml(editor.name)} shift end time" /></label>`).join("")
      : '<p class="handover-empty">No other editors are assigned to suites.</p>';
    document.getElementById("handoverRunningJobs").innerHTML = runningJobs.length
      ? runningJobs.map((job) => `<div class="handover-static-item"><span class="detail-dot busy"></span><span><strong>${escapeHtml(job.title)}</strong><small>${escapeHtml(editorById(job.editorId)?.name || "Unassigned")} · ${escapeHtml(job.suite ? suiteLabel(job.suite) : "No suite")}</small></span></div>`).join("")
      : '<p class="handover-empty">No jobs are currently running.</p>';
    document.getElementById("handoverQueueJobs").innerHTML = queueJobs.length
      ? queueJobs.map((job) => `<label class="handover-option"><input type="checkbox" data-handover-queue-job="${escapeHtml(job.id)}" checked /><span><strong>${escapeHtml(job.title)}</strong><small>${escapeHtml(job.status === "parked" ? "Parked" : job.status === "queued" ? "Queued" : "Job Queue")}</small></span></label>`).join("")
      : '<p class="handover-empty">There are no coming-up jobs in the queue.</p>';
    document.getElementById("handoverNotes").innerHTML = "<li><br></li>";
    renderHandoverManualJobs();
    if (detailDialog.open) detailDialog.close();
    handoverDialog.showModal();
  }

  function addHandoverManualJob() {
    const input = document.getElementById("handoverManualJob");
    const title = input.value.trim();
    if (!title) return;
    handoverManualJobs.push(title);
    input.value = "";
    renderHandoverManualJobs();
    input.focus();
  }

  function renderHandoverManualJobs() {
    document.getElementById("handoverManualJobs").innerHTML = handoverManualJobs.map((title, index) => `<div class="handover-manual-item"><span>${escapeHtml(title)}</span><button class="handover-remove" type="button" data-remove-handover-job="${index}" aria-label="Remove ${escapeHtml(title)}">×</button></div>`).join("");
    document.querySelectorAll("[data-remove-handover-job]").forEach((button) => button.addEventListener("click", () => {
      handoverManualJobs.splice(Number(button.dataset.removeHandoverJob), 1);
      renderHandoverManualJobs();
    }));
  }

  function handoverData() {
    const selectedEditors = [...document.querySelectorAll("[data-handover-editor]:checked")].map((checkbox) => {
      const editor = editorById(checkbox.dataset.handoverEditor);
      const suite = suiteForEditor(editor?.id);
      const end = document.querySelector(`[data-handover-shift-end="${CSS.escape(editor.id)}"]`)?.value || "";
      return { editor: editor.name, suite: suiteLabel(suite), end };
    });
    const running = state.jobs.filter((job) => job.status === "active").map((job) => ({
      title: job.title,
      editor: editorById(job.editorId)?.name || "Unassigned",
      suite: job.suite ? suiteLabel(job.suite) : "No suite"
    }));
    const comingUp = [...document.querySelectorAll("[data-handover-queue-job]:checked")]
      .map((checkbox) => state.jobs.find((job) => job.id === checkbox.dataset.handoverQueueJob)?.title)
      .filter(Boolean)
      .concat(handoverManualJobs);
    const notes = document.getElementById("handoverNotes").innerText.split(/\n+/).map((note) => note.trim()).filter(Boolean);
    return { editors: selectedEditors, running, comingUp, notes };
  }

  function pdfSafeText(value) {
    return String(value || "")
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[–—]/g, "-")
      .replace(/[^\x20-\x7e]/g, " ")
      .replace(/\\/g, "\\\\")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)");
  }

  function wrapPdfText(value, maxCharacters = 82) {
    const words = String(value || "")
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[–—]/g, "-")
      .replace(/[^\x20-\x7e]/g, " ")
      .split(/\s+/)
      .filter(Boolean);
    const lines = [];
    let line = "";
    words.forEach((word) => {
      if (line && `${line} ${word}`.length > maxCharacters) {
        lines.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    });
    if (line) lines.push(line);
    return lines.length ? lines : [""];
  }

  function createHandoverPdf(data) {
    const commands = [];
    let y = 792;
    const text = (value, x, size = 10, bold = false, colour = "0 0 0") => commands.push(`${colour} rg BT /F${bold ? 2 : 1} ${size} Tf 1 0 0 1 ${x} ${y} Tm (${pdfSafeText(value)}) Tj ET`);
    const rule = () => commands.push(`0.82 0.86 0.9 RG 50 ${y} m 545 ${y} l S`);
    const section = (title) => {
      y -= 26;
      text(title.toUpperCase(), 50, 9, true, "0.03 0.50 0.61");
      y -= 9;
      rule();
      y -= 18;
    };
    const list = (items, emptyText, limit = 9) => {
      const visible = items.slice(0, limit);
      (visible.length ? visible : [emptyText]).forEach((item) => {
        const lines = wrapPdfText(item, 84);
        lines.forEach((line, index) => {
          text(index === 0 && visible.length ? `- ${line}` : line, index === 0 ? 58 : 68, 10);
          y -= 14;
        });
      });
      if (items.length > limit) {
        text(`+ ${items.length - limit} more`, 58, 9, true);
        y -= 14;
      }
    };

    text(`Editing - ${formattedBoardDate(selectedDateKey)}`, 50, 20, true, "0.77 0.25 0.32");
    y -= 18;
    text(`Created ${new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false })}`, 50, 9);
    section("Editors");
    list(data.editors.map((item) => `${item.suite}: ${item.editor}${item.end ? ` [${item.end}]` : ""}`), "No editors selected.", 10);
    section("Running jobs");
    list(data.running.map((item) => `${item.title} - ${item.editor}, ${item.suite}`), "No jobs running.", 8);
    section("Coming-up jobs");
    list(data.comingUp, "No coming-up jobs.", 9);
    section("Notes");
    list(data.notes, "No additional notes.", 8);

    const stream = commands.join("\n");
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>",
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>"
    ];
    let pdf = "%PDF-1.4\n";
    const offsets = [0];
    objects.forEach((object, index) => {
      offsets.push(pdf.length);
      pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    });
    const xref = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    offsets.slice(1).forEach((offset) => { pdf += `${String(offset).padStart(10, "0")} 00000 n \n`; });
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return new Blob([pdf], { type: "application/pdf" });
  }

  async function createAndShareHandover() {
    const data = handoverData();
    const missingShiftEnd = data.editors.some((item) => !item.end);
    if (missingShiftEnd) {
      showToast("Add a shift end time for each selected editor", "danger");
      return;
    }
    const blob = createHandoverPdf(data);
    const filename = `editing-handover-${selectedDateKey}.pdf`;
    const file = new File([blob], filename, { type: "application/pdf" });
    if (navigator.share && navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ title: `Editing - ${formattedBoardDate(selectedDateKey)}`, files: [file] });
        handoverDialog.close();
        return;
      } catch (error) {
        if (error.name === "AbortError") return;
      }
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    handoverDialog.close();
    showToast("Handover PDF downloaded", "complete");
  }

  function editorCurrentWorkMarkup(job, editor) {
    const suite = job.suite || suiteForEditor(editor.id);
    const paused = job.status === "active" && editor.onBreak;
    const active = job.status === "active";
    const statusLabel = paused ? "Paused" : active ? "Active" : job.status === "queued" ? "Coming up next" : job.status === "parked" ? "Parked" : "Job Queue";
    const tone = paused ? "paused-item" : active ? "active-item" : "incoming-item";
    const icon = active
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7Z" /></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7v5l3 2" /><circle cx="12" cy="12" r="9" /></svg>';
    return `
      <article class="completed-card editor-work-card ${tone}">
        <span class="editor-work-state">${icon}</span>
        <div>
          <div class="completed-title-row"><h3>${escapeHtml(job.title)}</h3><span class="work-type ${cssSlug(job.workType)}">${escapeHtml(job.workType)}</span></div>
          <div class="complete-meta">
            <span>${escapeHtml(statusLabel)}</span>
            ${job.type ? `<span>${escapeHtml(job.type)}</span>` : ""}
            ${suite ? `<span>${escapeHtml(suiteLabel(suite))}</span>` : ""}
            ${job.due ? `<span class="work-due">Due ${escapeHtml(job.due)}</span>` : ""}
            ${dueWarningBadge(job)}
          </div>
        </div>
      </article>`;
  }

  function priorityRank(priority) {
    return { top: 0, flash: 0, urgent: 1, standard: 2, low: 3, "off-rota": 4 }[priority] ?? 5;
  }

  function priorityLabel(priority) {
    return { low: "Low", standard: "Standard", urgent: "Urgent", top: "Top Priority", flash: "Top Priority", "off-rota": "Off Rota" }[priority] || "Standard";
  }

  function sortQueueJobs(jobs) {
    return [...jobs].sort((a, b) => {
      const dueOrder = (first, second) => (first.due || "99:99").localeCompare(second.due || "99:99");
      const parkedOrder = Number(b.status === "parked") - Number(a.status === "parked");
      if (parkedOrder) return parkedOrder;
      if (uiState.queueSort === "due") return dueOrder(a, b);
      if (uiState.queueSort === "type") return a.workType.localeCompare(b.workType) || dueOrder(a, b);
      if (uiState.queueSort === "added") {
        const addedAt = (job) => Date.parse(job.createdAt || "") || Number(String(job.id).replace(/\D/g, "")) || 0;
        return addedAt(b) - addedAt(a);
      }
      return priorityRank(a.priority) - priorityRank(b.priority) || dueOrder(a, b);
    });
  }

  function dueWarningInfo(job) {
    if (selectedDateKey !== todayKey || !/^\d{2}:\d{2}$/.test(job.due || "")) return { className: "", label: "" };
    const [hours, minutes] = job.due.split(":").map(Number);
    const now = new Date();
    const due = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes);
    const differenceMinutes = (due.getTime() - now.getTime()) / 60000;
    if (differenceMinutes < 0) {
      const minutesOverdue = Math.max(1, Math.floor(Math.abs(differenceMinutes)));
      return { className: "overdue", label: `${minutesOverdue} min overdue` };
    }
    const minutesRemaining = Math.ceil(differenceMinutes);
    if (uiState.dueWarningMinutes > 0 && minutesRemaining <= uiState.dueWarningMinutes) {
      return { className: "due-soon", label: minutesRemaining === 0 ? "Due now" : `Due in ${minutesRemaining} min` };
    }
    return { className: "", label: "" };
  }

  function dueWarningClass(job) {
    return dueWarningInfo(job).className;
  }

  function dueWarningBadge(job) {
    const warning = dueWarningInfo(job);
    return warning.label ? `<span class="due-warning-badge ${warning.className}">${escapeHtml(warning.label)}</span>` : "";
  }

  function getReadiness(job) {
    if (!job.editorId) return { ready: false, suite: null, message: "Assign an editor before sending" };
    const editor = editorById(job.editorId);
    if (!editor) return { ready: false, suite: null, message: "The assigned editor is no longer on this day's roster" };
    const suite = suiteForEditor(job.editorId);
    if (!suite) return { ready: false, suite: null, message: "Editor needs a suite assignment first" };
    const active = activeJobForEditor(job.editorId);
    const queued = queuedJobsForEditor(job.editorId).length;
    if (editor.onBreak) return { ready: true, suite, queue: true, message: `Will queue in ${suiteLabel(suite)} · ${editor.name} is on break` };
    if (active && allowsConcurrentRunning(job.editorId, suite)) return { ready: true, suite, queue: true, message: `Will queue in ${suiteLabel(suite)} · can run alongside current work` };
    if (active) return { ready: true, suite, queue: true, message: `Will queue behind: ${active.title}` };
    if (queued) return { ready: true, suite, queue: true, message: `Will join the ${suiteLabel(suite)} queue · ${queued} already waiting` };
    return { ready: true, suite, queue: true, message: `Ready to queue in ${suiteLabel(suite)}` };
  }

  function assignSuiteToEditor(editorId, suiteValue) {
    const editor = editorById(editorId);
    if (!editor) return;
    const currentSuite = suiteForEditor(editorId);
    const targetSuite = suiteValue ? Number(suiteValue) : null;

    if (editorId === "ed-shift-lead" || targetSuite === 1) {
      showToast(`${editor.name} is fixed to Edit 1 as shift leader`);
      render();
      return;
    }

    if (editor.onBreak || activeJobForEditor(editorId)) {
      showToast(`${editor.name} cannot move while busy or on break`);
      render();
      return;
    }

    if (!targetSuite) {
      if (currentSuite) state.suites[currentSuite] = null;
      moveQueuedJobs(editorId, null);
      showToast(`${editor.name} is now unassigned`);
      render();
      return;
    }

    if (targetSuite === currentSuite) return;
    if (!state.suites[targetSuite] && suiteModeFor(targetSuite) !== "unused") {
      showToast(`${suiteLabel(targetSuite)} is marked ${suiteUseLabels[suiteModeFor(targetSuite)].toLowerCase()}`);
      render();
      return;
    }
    if (activeJobForSuite(targetSuite)) {
      showToast(`${suiteLabel(targetSuite)} has a live job and cannot be reassigned`);
      render();
      return;
    }

    const displacedId = state.suites[targetSuite];
    const displaced = editorById(displacedId);
    if (displaced?.onBreak) {
      showToast(`${displaced.name} is on break in ${suiteLabel(targetSuite)}`);
      render();
      return;
    }

    if (currentSuite) state.suites[currentSuite] = displacedId || null;
    state.suites[targetSuite] = editorId;
    moveQueuedJobs(editorId, targetSuite);
    if (displacedId) moveQueuedJobs(displacedId, currentSuite || null);
    const message = displacedId && currentSuite
      ? `${editor.name} moved to ${suiteLabel(targetSuite)} · ${displaced.name} swapped to ${suiteLabel(currentSuite)}`
      : displacedId
        ? `${editor.name} moved to ${suiteLabel(targetSuite)} · ${displaced.name} is now unassigned`
        : `${editor.name} assigned to ${suiteLabel(targetSuite)}`;
    showToast(message);
    render();
  }

  function updateSuiteUse(suite, mode) {
    if (state.suites[suite] || !Object.hasOwn(suiteUseLabels, mode)) {
      render();
      return;
    }
    state.suiteModes[suite] = mode;
    showToast(`${suiteLabel(suite)} marked ${suiteUseLabels[mode].toLowerCase()}`);
    render();
  }

  function preassignJob(jobId, editorId) {
    const job = state.jobs.find((item) => item.id === jobId && (item.status === "planned" || item.status === "parked"));
    if (!job) return;
    const previousEditorId = job.editorId || null;
    if (previousEditorId === editorId) return;
    job.editorId = editorId;
    const editor = editorById(editorId);
    recordJobEvent(job, editor ? "assigned" : "unassigned", {
      editorId: editor?.id || null,
      previousEditorId,
      suite: editor ? suiteForEditor(editor.id) : null
    });
    showToast(editor ? `${job.title} pre-assigned to ${editor.name}` : `${job.title} returned to the open queue`);
    render();
  }

  function pushJob(jobId) {
    const job = state.jobs.find((item) => item.id === jobId && (item.status === "planned" || item.status === "parked"));
    if (!job) return;
    const readiness = getReadiness(job);
    if (!readiness.ready) {
      showToast(readiness.message, "danger");
      return;
    }
    const wasParked = job.status === "parked";
    job.wasParked = wasParked || Boolean(job.wasParked);
    job.suite = readiness.suite;
    if (readiness.queue) {
      job.status = "queued";
      job.queuedAt = new Date().toISOString();
      recordJobEvent(job, "queued", { editorId: job.editorId, suite: readiness.suite });
      showToast(`${job.title} added to ${editorById(job.editorId).name}'s queue in ${suiteLabel(readiness.suite)}`, "info");
    } else {
      job.status = "active";
      job.startedAt = currentTime();
      recordJobEvent(job, wasParked ? "resumed" : "started", { editorId: job.editorId, suite: readiness.suite });
      showToast(`${job.title} ${wasParked ? "resumed" : "started"} in ${suiteLabel(readiness.suite)}`, "complete");
    }
    render();
  }

  function startQueuedJob(jobId) {
    const job = state.jobs.find((item) => item.id === jobId && item.status === "queued");
    if (!job) return;
    const editor = editorById(job.editorId);
    if (!editor || editor.onBreak || (!allowsConcurrentRunning(job.editorId, job.suite) && activeJobForEditor(job.editorId))) {
      showToast(editor?.onBreak ? `${editor.name} is still on break` : "Finish or pause the current job first", "danger");
      return;
    }
    job.status = "active";
    job.startedAt = currentTime();
    delete job.queuedAt;
    delete job.pausedInSuite;
    const hasStartedBefore = job.history?.some((event) => event.type === "started" || event.type === "resumed");
    recordJobEvent(job, hasStartedBefore ? "resumed" : "started", { editorId: job.editorId, suite: job.suite });
    showToast(`${job.title} started in ${suiteLabel(job.suite)}`, "complete");
    render();
  }

  async function returnQueuedToPool(jobId) {
    const job = state.jobs.find((item) => item.id === jobId && item.status === "queued");
    if (!job) return;
    if (!(await confirmJobAction({
      eyebrow: "Confirm queue change",
      title: "Return job to queue?",
      jobName: job.title,
      message: " will move back to the Job Queue.",
      confirmLabel: "Return",
      confirmClass: "button-park"
    }))) return;
    const before = JSON.stringify(state);
    job.status = job.wasParked ? "parked" : "planned";
    recordJobEvent(job, "returned", { editorId: job.editorId, suite: job.suite });
    delete job.suite;
    delete job.queuedAt;
    delete job.pausedInSuite;
    showToast(`${job.title} returned to the Job Queue`, "biff");
    render();
    offerUndo(before);
  }

  function moveQueuedJobs(editorId, suite) {
    queuedJobsForEditor(editorId).forEach((job) => {
      if (suite) {
        if (job.suite !== suite) recordJobEvent(job, "moved", { editorId, suite });
        job.suite = suite;
      } else {
        recordJobEvent(job, "returned", { editorId, suite: job.suite });
        job.status = job.wasParked ? "parked" : "planned";
        delete job.suite;
        delete job.queuedAt;
        delete job.pausedInSuite;
      }
    });
  }

  async function parkJob(jobId) {
    const job = state.jobs.find((item) => item.id === jobId && item.status === "active");
    if (!job) return;
    const editor = editorById(job.editorId);
    if (editor?.onBreak) {
      showToast("Bring the editor back from break before parking this job", "danger");
      return;
    }
    // Issues #10 / #11: pausing keeps the job on its suite card, at the top of
    // "Coming up next"; ▶ resumes it (one running job per suite, except Edit 1)
    // and ↩ parks it in the Job Queue.
    return pauseInSuite(job, editor);
  }

  async function pauseInSuite(job, editor) {
    if (!(await confirmJobAction({
      eyebrow: "Confirm pause",
      title: "Pause this job?",
      jobName: job.title,
      message: ` will pause and stay in ${suiteLabel(job.suite)} under Coming up next.`,
      confirmLabel: "Pause",
      confirmClass: "button-park"
    }))) return;
    const before = JSON.stringify(state);
    job.status = "queued";
    job.pausedInSuite = true;
    job.queuedAt = new Date().toISOString();   // paused jobs sort first (queuedJobsForSuite)
    // If it is later returned to the Job Queue, it shows as parked from here.
    job.wasParked = true;
    job.parkedAt = currentTime();
    job.parkedFromEditorId = job.editorId;
    job.parkedFromEditorName = editor?.name || "Previous editor";
    job.parkedFromSuite = job.suite;
    recordJobEvent(job, "paused_in_suite", { editorId: job.editorId, suite: job.suite });
    showToast(`${job.title} paused · still in ${suiteLabel(job.suite)} under Coming up next`, "park");
    render();
    offerUndo(before);
  }

  async function completeJob(jobId) {
    const job = state.jobs.find((item) => item.id === jobId && item.status === "active");
    if (!job) return;
    const editor = editorById(job.editorId);
    if (editor?.onBreak) {
      showToast("Bring the editor back from break before signing off the job", "danger");
      return;
    }
    if (!(await confirmJobAction({
      eyebrow: "Confirm completion",
      title: "Mark this job completed?",
      jobName: job.title,
      message: " will move to Completed and free the editor.",
      confirmLabel: "Complete",
      confirmClass: "button-complete"
    }))) return;
    const before = JSON.stringify(state);
    job.status = "completed";
    job.completedBy = editor ? editor.name : "Unassigned editor";
    job.completedSuite = job.suite;
    job.completedAt = currentTime();
    recordJobEvent(job, "completed", { editorId: job.editorId, suite: job.completedSuite });
    const waiting = queuedJobsForEditor(job.editorId).length;
    const remainingActive = activeJobsForEditor(job.editorId).length;
    showToast(`${job.title} signed off${remainingActive ? ` · ${job.completedBy} remains busy with ${remainingActive} live job${remainingActive === 1 ? "" : "s"}` : waiting ? ` · ${waiting} queued job${waiting === 1 ? " is" : "s are"} ready next` : ` · ${job.completedBy} is now free`}`, "complete");
    render();
    offerUndo(before);
  }

  function confirmJobAction({ eyebrow, title, jobName, message, confirmLabel, confirmClass, force = false }) {
    if (!force && !uiState.confirmJobActions) return Promise.resolve(true);
    document.getElementById("actionConfirmEyebrow").textContent = eyebrow;
    document.getElementById("actionConfirmTitle").textContent = title;
    document.getElementById("actionConfirmJobName").textContent = jobName;
    document.getElementById("actionConfirmMessage").textContent = message;
    actionConfirmButton.textContent = confirmLabel;
    actionConfirmButton.className = `button ${confirmClass}`;
    actionConfirmDialog.showModal();
    return new Promise((resolve) => { actionConfirmationResolver = resolve; });
  }

  function resolveActionConfirmation(confirmed) {
    const resolver = actionConfirmationResolver;
    actionConfirmationResolver = null;
    if (actionConfirmDialog.open) actionConfirmDialog.close();
    if (resolver) resolver(confirmed);
  }

  function biffJob(jobId) {
    const job = state.jobs.find((item) => item.id === jobId && ["planned", "parked", "queued", "active"].includes(item.status));
    if (!job) return;
    biffingJobId = job.id;
    // Issue #13: like Complete / Pause / Return, Biff only asks when "Confirm job
    // actions" is on; otherwise it happens straight away and the Undo bar follows.
    if (!uiState.confirmJobActions) return confirmBiffJob();
    document.getElementById("biffJobName").textContent = job.title;
    biffDialog.showModal();
    document.getElementById("biffKeepButton").focus();   // the safe choice, not the close button
  }

  function confirmBiffJob() {
    const job = state.jobs.find((item) => item.id === biffingJobId && ["planned", "parked", "queued", "active"].includes(item.status));
    if (!job) {
      biffDialog.close();
      biffingJobId = null;
      return;
    }
    const editor = editorById(job.editorId);
    const before = JSON.stringify(state);
    job.biffedFrom = job.status;
    job.biffedEditor = editor?.name || "Unassigned";
    job.biffedSuite = job.suite || null;
    job.biffedAt = currentTime();
    recordJobEvent(job, "biffed", { editorId: job.editorId, suite: job.biffedSuite, fromStatus: job.status });
    job.status = "biffed";
    delete job.suite;
    delete job.queuedAt;
    delete job.pausedInSuite;
    biffDialog.close();
    biffingJobId = null;
    showToast(`${job.title} biffed`, "biff");
    render();
    offerUndo(before);
  }

  function toggleBreak(editorId) {
    const editor = editorById(editorId);
    if (!editor) return;
    const activeJobs = activeJobsForEditor(editor.id);
    editor.onBreak = !editor.onBreak;
    activeJobs.forEach((job) => recordJobEvent(job, editor.onBreak ? "break_started" : "break_ended", { editorId: editor.id, suite: job.suite }));
    showToast(editor.onBreak ? `${editor.name} is on break${activeJobs.length ? ` · ${activeJobs.length} live job${activeJobs.length === 1 ? "" : "s"} paused` : ""}` : `${editor.name} is back and available`, "break");
    render();
  }

  function openEditJob(jobId) {
    const job = state.jobs.find((item) => item.id === jobId && (item.status === "planned" || item.status === "parked"));
    if (!job) return;
    editingJobId = job.id;
    document.getElementById("editJobTitle").value = job.title;
    document.getElementById("editJobWorkType").value = job.workType;
    document.getElementById("editJobPriority").value = job.priority === "flash" ? "top" : job.priority;
    document.getElementById("editJobType").value = job.type || "Digital Edit";
    syncEditFormatForWorkType("editJobWorkType", "editJobType");
    document.getElementById("editJobDue").value = job.due;
    editJobEditor.innerHTML = editorOptions(job.editorId);
    editJobEditor.value = job.editorId || "";
    document.getElementById("editJobContact").value = job.contact || "";
    document.getElementById("editJobNote").value = job.note || "";
    editJobDialog.showModal();
    requestAnimationFrame(() => document.getElementById("editJobTitle").focus());
  }

  function saveJobEdits(form) {
    const job = state.jobs.find((item) => item.id === editingJobId && (item.status === "planned" || item.status === "parked"));
    if (!job) {
      editJobDialog.close();
      return;
    }
    const data = new FormData(form);
    const previousTitle = job.title;
    const previousEditorId = job.editorId || null;
    job.title = String(data.get("title") || "").trim();
    job.workType = String(data.get("workType"));
    job.priority = String(data.get("priority"));
    job.type = isEditOneAdmin(job.workType) ? "" : String(data.get("type"));
    job.due = String(data.get("due") || "");
    job.editorId = String(data.get("editor") || "") || null;
    job.contact = String(data.get("contact") || "").trim();
    job.note = String(data.get("note") || "").trim();
    if (previousEditorId !== job.editorId) {
      recordJobEvent(job, job.editorId ? "assigned" : "unassigned", {
        editorId: job.editorId,
        previousEditorId,
        suite: job.editorId ? suiteForEditor(job.editorId) : null
      });
    }
    editingJobId = null;
    editJobDialog.close();
    showToast(`${previousTitle === job.title ? job.title : `${previousTitle} renamed to ${job.title}`} updated`);
    render();
  }

  function addJob(form) {
    const data = new FormData(form);
    const title = String(data.get("title") || "").trim();
    if (!title) return;
    const createdAt = new Date().toISOString();
    const editorId = String(data.get("editor") || "") || null;
    const job = {
      id: `job-${Date.now()}`,
      title,
      workType: String(data.get("workType")),
      type: isEditOneAdmin(String(data.get("workType"))) ? "" : String(data.get("type")),
      priority: String(data.get("priority")),
      due: String(data.get("due") || ""),
      editorId,
      contact: String(data.get("contact") || "").trim(),
      note: String(data.get("note") || "").trim(),
      createdAt,
      status: "planned",
      history: [{ type: "created", at: createdAt }]
    };
    if (editorId) recordJobEvent(job, "assigned", { editorId, suite: suiteForEditor(editorId) });
    state.jobs.push(job);
    const reopenQueue = returnToQueueAfterAdd;
    returnToQueueAfterAdd = false;
    jobDialog.close();
    form.reset();
    document.getElementById("jobDue").value = "";
    showToast(`${title} added to ${selectedDateKey === todayKey ? "today's" : formattedBoardDate(selectedDateKey)} Job Queue`);
    render();
    if (reopenQueue) openSummary("pool");
  }

  function addEditor(name, suiteValue = "") {
    const cleanName = String(name || "").trim();
    if (!cleanName) return;
    if (editors().some((editor) => editor.name.toLowerCase() === cleanName.toLowerCase())) {
      showToast(`${cleanName} is already on this day's roster`);
      return;
    }
    const returningEditor = state.editors.find((editor) => editor.removedFromRoster && editor.name.toLowerCase() === cleanName.toLowerCase());
    if (returningEditor) {
      returningEditor.removedFromRoster = false;
      delete returningEditor.removedAt;
      returningEditor.onBreak = false;
      if (suiteValue) {
        assignSuiteToEditor(returningEditor.id, suiteValue);
        showToast(`${cleanName} returned and assigned to ${suiteLabel(Number(suiteValue))}`);
        return;
      }
      showToast(`${cleanName} returned to today's team`);
      render();
      return;
    }
    const editorId = `ed-${Date.now()}`;
    state.editors.push({ id: editorId, name: cleanName, initials: initialsFor(cleanName), onBreak: false });
    document.getElementById("newEditorName").value = "";
    document.getElementById("newEditorSuite").value = "";
    if (suiteValue) {
      assignSuiteToEditor(editorId, suiteValue);
      showToast(`${cleanName} added and assigned to ${suiteLabel(Number(suiteValue))}`);
      return;
    }
    showToast(`${cleanName} added to this day's team`);
    render();
  }

  function renameEditor(editorId, name) {
    const editor = editorById(editorId);
    const cleanName = String(name || "").trim();
    if (!editor || !cleanName) return;
    if (editors().some((candidate) => candidate.id !== editorId && candidate.name.toLowerCase() === cleanName.toLowerCase())) {
      showToast(`${cleanName} is already on today's roster`, "danger");
      return;
    }
    const previousName = editor.name;
    editor.name = cleanName;
    editor.initials = initialsFor(cleanName);
    state.jobs.forEach((job) => {
      if (job.editorId === editorId || job.completedBy === previousName) {
        if (job.completedBy) job.completedBy = cleanName;
      }
      if (job.parkedFromEditorId === editorId || job.parkedFromEditorName === previousName) {
        if (job.parkedFromEditorName) job.parkedFromEditorName = cleanName;
      }
    });
    editingEditorId = null;
    showToast(`${previousName} renamed to ${cleanName}`);
    render();
  }

  async function removeEditorFromToday(editorId) {
    const editor = editorById(editorId);
    if (!editor || editor.id === "ed-shift-lead") return;
    const active = activeJobForEditor(editorId);
    if (active) {
      showToast(`Finish, park or return ${active.title} before removing ${editor.name}`, "danger");
      return;
    }
    const reassignedJobs = state.jobs.filter((job) =>
      job.editorId === editorId && ["planned", "parked", "queued"].includes(job.status)
    );
    const jobMessage = reassignedJobs.length
      ? ` and ${reassignedJobs.length} assigned job${reassignedJobs.length === 1 ? "" : "s"} will return to the main queue unassigned.`
      : ". Their completed-work history will remain intact.";
    if (!(await confirmJobAction({
      eyebrow: "Update today's roster",
      title: "Remove editor from today?",
      jobName: editor.name,
      message: ` will be unassigned from their suite${jobMessage}`,
      confirmLabel: "Remove",
      confirmClass: "button-biff",
      force: true
    }))) return;
    const suite = suiteForEditor(editorId);
    if (suite) state.suites[suite] = null;
    reassignedJobs.forEach((job) => {
      recordJobEvent(job, "unassigned", { previousEditorId: editorId, suite: job.suite || suite });
      if (job.status === "queued") job.status = job.wasParked ? "parked" : "planned";
      job.editorId = null;
      delete job.suite;
      delete job.queuedAt;
      delete job.pausedInSuite;
    });
    editor.onBreak = false;
    editor.removedFromRoster = true;
    editor.removedAt = new Date().toISOString();
    editingEditorId = null;
    showToast(`${editor.name} removed from today${reassignedJobs.length ? ` · ${reassignedJobs.length} job${reassignedJobs.length === 1 ? "" : "s"} returned to the queue` : ""}`, "biff");
    render();
  }

  function populateNewJobEditors() {
    const selected = jobEditor.value;
    jobEditor.innerHTML = editorOptions(selected);
  }

  function currentTime() {
    return new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  }

  function recordJobEvent(job, type, details = {}) {
    if (!Array.isArray(job.history)) return;
    job.history.push({ type, at: new Date().toISOString(), ...details });
  }

  function dateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function dateFromKey(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
    if (!match) return null;
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
    return dateKey(date) === value ? date : null;
  }

  function formattedBoardDate(boardDate, options = {}) {
    const date = dateFromKey(boardDate);
    if (!date) return boardDate;
    return date.toLocaleDateString("en-GB", {
      weekday: options.short ? "short" : "long",
      day: "numeric",
      month: options.short ? "short" : "long",
      year: "numeric"
    });
  }

  function renderDateNavigator() {
    const isToday = selectedDateKey === todayKey;
    boardDateInput.value = selectedDateKey;
    boardDateKicker.textContent = isToday ? "Today" : "Board date";
    boardDateLabel.textContent = formattedBoardDate(selectedDateKey, { short: true });
    todayButton.hidden = isToday;
    dayScopeBadge.lastChild.textContent = isToday ? " Today" : selectedDateKey < todayKey ? " Past day" : " Planned day";
  }

  function selectBoardDate(boardDate) {
    if (!cloudReady || cloudBusy || !dateFromKey(boardDate) || boardDate === selectedDateKey) return;
    if (pendingSave) {
      pendingDateSelection = boardDate;
      clearTimeout(saveTimer);
      saveTimer = null;
      void persistBoard();
      return;
    }
    void loadCloudBoard(boardDate);
  }

  function moveBoardDate(days) {
    const date = dateFromKey(selectedDateKey);
    if (!date) return;
    date.setDate(date.getDate() + days);
    selectBoardDate(dateKey(date));
  }

  function emptyState(title, message) {
    return `<div class="empty-state"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M5 12h9M5 17h6" /></svg><strong>${escapeHtml(title)}</strong><span>${escapeHtml(message)}</span></div>`;
  }

  // ---- Undo (issue #12): after Complete, Pause, Biff or Return, a bar with Undo for 8 s.
  // Undo restores the whole day's board as it was just before the action, unless
  // someone else's change has arrived since (then it is cancelled, never overwritten).
  let remoteBoardChanges = 0;   // bumped whenever the board is replaced from the cloud
  let undoEntry = null;
  let undoTimer = null;
  const undoBar = document.createElement("div");
  undoBar.className = "undo-bar";
  undoBar.setAttribute("role", "status");
  undoBar.hidden = true;
  undoBar.innerHTML = '<div class="undo-row"><span class="undo-message"></span><button type="button" class="undo-button">Undo</button></div><div class="undo-countdown"></div>';
  document.body.append(undoBar);
  function hideUndo() { clearTimeout(undoTimer); undoEntry = null; undoBar.hidden = true; }
  function offerUndo(before) {
    const message = toast.textContent;
    clearTimeout(toastTimer); toast.classList.remove("visible");   // the bar carries the message
    undoEntry = { before, date: selectedDateKey, remote: remoteBoardChanges };
    undoBar.querySelector(".undo-message").textContent = message;
    const line = undoBar.querySelector(".undo-countdown");
    line.style.animation = "none"; void line.offsetWidth; line.style.animation = "";   // restart the countdown
    undoBar.hidden = false;
    clearTimeout(undoTimer);
    undoTimer = setTimeout(hideUndo, 8000);
  }
  undoBar.querySelector(".undo-button").addEventListener("click", async () => {
    const entry = undoEntry;
    hideUndo();
    if (!entry) return;
    for (let i = 0; i < 50 && cloudBusy; i++) await new Promise((r) => setTimeout(r, 100));   // let a save in progress finish
    if (entry.date !== selectedDateKey || entry.remote !== remoteBoardChanges || cloudBusy) {
      showToast("Someone else changed the board just now, so this can't be undone", "danger");
      return;
    }
    state = JSON.parse(entry.before);
    render();
    showToast("Undone", "info");
  });

  function showToast(message, tone = "info") {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.remove("toast-info", "toast-complete", "toast-park", "toast-biff", "toast-break", "toast-danger");
    toast.classList.add(`toast-${tone}`);
    toast.classList.add("visible");
    toastTimer = setTimeout(() => toast.classList.remove("visible"), 2800);
  }

  function updateClock() {
    document.getElementById("shiftDate").textContent = formattedBoardDate(selectedDateKey, { short: true });
    document.getElementById("liveClock").textContent = currentTime();
  }

  function refreshTodayKey() {
    const nextTodayKey = dateKey(new Date());
    if (nextTodayKey === todayKey) return false;
    todayKey = nextTodayKey;
    renderDateNavigator();
    return true;
  }

  function openNewJobDialog(returnToQueue = false) {
    returnToQueueAfterAdd = returnToQueue;
    populateNewJobEditors();
    syncEditFormatForWorkType("jobWorkType", "jobType");
    jobDialog.showModal();
    requestAnimationFrame(() => document.getElementById("jobTitle").focus());
  }

  function syncFastTrackFormat() {
    const workType = document.getElementById("fastTrackWorkType");
    const format = document.getElementById("fastTrackType");
    const formatField = format?.closest(".field");
    const row = document.getElementById("fastTrackFormatRow");
    if (!workType || !format || !formatField || !row) return;
    const adminWork = isEditOneAdmin(workType.value);
    format.disabled = adminWork;
    formatField.hidden = adminWork;
    row.classList.toggle("single-field", adminWork);
  }

  function openFastTrackDialog(suite) {
    const editor = editorById(state.suites[suite]);
    const activeJobs = activeJobsForSuite(suite);
    if (!editor) return;
    if (editor.onBreak) {
      showToast(`${editor.name} is on break`, "danger");
      return;
    }
    if (activeJobs.length && !allowsConcurrentRunning(editor.id, suite)) {
      showToast("Finish or pause the current job first", "danger");
      return;
    }
    fastTrackTarget = { suite, editorId: editor.id };
    fastTrackForm.reset();
    document.getElementById("fastTrackSuiteSummary").textContent = `${editor.name} · ${suiteLabel(suite)} · starts immediately`;
    syncFastTrackFormat();
    fastTrackDialog.showModal();
    document.getElementById("fastTrackTitle").focus({ preventScroll: true });
  }

  function addFastTrackJob(form) {
    const data = new FormData(form);
    const title = String(data.get("title") || "").trim();
    const target = fastTrackTarget;
    const editor = target && editorById(target.editorId);
    if (!title || !target || !editor || state.suites[target.suite] !== editor.id) return;
    const activeJobs = activeJobsForSuite(target.suite);
    if (editor.onBreak || (activeJobs.length && !allowsConcurrentRunning(editor.id, target.suite))) {
      fastTrackDialog.close();
      showToast(editor.onBreak ? `${editor.name} is on break` : "Finish or pause the current job first", "danger");
      return;
    }
    const createdAt = new Date().toISOString();
    const workType = String(data.get("workType"));
    const job = {
      id: `job-${Date.now()}`,
      title,
      workType,
      type: isEditOneAdmin(workType) ? "" : String(data.get("type")),
      priority: "standard",
      due: "",
      editorId: editor.id,
      contact: "",
      note: String(data.get("note") || "").trim(),
      createdAt,
      startedAt: currentTime(),
      suite: target.suite,
      status: "active",
      history: [{ type: "created", at: createdAt }]
    };
    recordJobEvent(job, "assigned", { editorId: editor.id, suite: target.suite });
    recordJobEvent(job, "started", { editorId: editor.id, suite: target.suite });
    state.jobs.push(job);
    fastTrackTarget = null;
    fastTrackDialog.close();
    showToast(`${title} started in ${suiteLabel(target.suite)}`, "complete");
    render();
  }

  document.getElementById("newJobButton").addEventListener("click", () => openNewJobDialog(false));
  document.getElementById("todoButton").addEventListener("click", () => openTodoDialog(false));
  document.getElementById("todoViewButton").addEventListener("click", () => openTodoDialog(todoForm.hidden));
  todoForm.addEventListener("submit", (event) => {
    event.preventDefault();
    addTodo();
  });
  document.getElementById("todoIsNote").addEventListener("change", updateTodoEntryMode);
  document.getElementById("todoEditIsNote").addEventListener("change", updateTodoEditNoteMode);
  todoTitle.addEventListener("input", updateTodoEntryMode);
  todoNote.addEventListener("input", updateTodoEntryMode);
  todoList.addEventListener("click", handleTodoAction);
  todoCompletedList.addEventListener("click", handleTodoAction);
  todoEditForm.addEventListener("submit", (event) => {
    event.preventDefault();
    saveTodoEdits();
  });
  todoEditTitle.addEventListener("input", () => todoEditTitle.setCustomValidity(""));
  document.getElementById("clearTodoReminder").addEventListener("click", () => { todoEditReminder.value = ""; });
  document.getElementById("dismissTodoReminder").addEventListener("click", () => acknowledgeTodoReminder(false));
  document.getElementById("dismissTodoReminderIcon").addEventListener("click", () => acknowledgeTodoReminder(false));
  document.getElementById("completeTodoReminder").addEventListener("click", () => acknowledgeTodoReminder(true));
  document.getElementById("jobWorkType").addEventListener("change", () => syncEditFormatForWorkType("jobWorkType", "jobType"));
  document.getElementById("editJobWorkType").addEventListener("change", () => syncEditFormatForWorkType("editJobWorkType", "editJobType"));
  document.getElementById("fastTrackWorkType").addEventListener("change", syncFastTrackFormat);
  document.querySelectorAll("[data-clear-due]").forEach((button) => button.addEventListener("click", () => {
    const input = document.getElementById(button.dataset.clearDue);
    if (input) input.value = "";
  }));
  document.getElementById("dayPulseButton").addEventListener("click", openDayPulse);
  document.getElementById("addHandoverJobButton").addEventListener("click", addHandoverManualJob);
  document.getElementById("handoverManualJob").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    addHandoverManualJob();
  });
  handoverForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void createAndShareHandover();
  });
  document.getElementById("detailAddJobButton").addEventListener("click", () => {
    detailDialog.close();
    openNewJobDialog(true);
  });
  document.getElementById("daySheetButton").addEventListener("click", openDaySheet);
  document.getElementById("editDaySheetButton").addEventListener("click", () => setDaySheetMode(true));
  document.getElementById("saveDaySheetButton").addEventListener("click", saveDaySheet);
  document.querySelectorAll("[data-day-sheet-command]").forEach((button) => {
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => formatDaySheet(button.dataset.daySheetCommand));
  });
  daySheetEditor.addEventListener("paste", (event) => {
    const html = event.clipboardData?.getData("text/html");
    const text = event.clipboardData?.getData("text/plain");
    if (!html && !text) return;
    event.preventDefault();
    insertDaySheetHtml(html || escapeHtml(text).replace(/\n/g, "<br>"));
  });
  document.getElementById("suiteFilterButton").addEventListener("click", cycleSuiteFilter);
  document.getElementById("completedCollapseButton").addEventListener("click", () => toggleSection("completed"));
  document.getElementById("biffedCollapseButton").addEventListener("click", () => toggleSection("biffed"));
  document.getElementById("emptySuitePresentation").addEventListener("change", (event) => {
    uiState.emptySuitePresentation = event.target.value;
    saveUiState();
    renderSuites();
  });
  document.getElementById("compactSuites").addEventListener("change", (event) => {
    uiState.compactSuites = event.target.checked;
    saveUiState();
    renderSuites();
  });
  function setCompactQueueCards(enabled) {
    uiState.compactQueueCards = enabled;
    document.getElementById("compactQueueCards").checked = enabled;
    announceUi();
    saveUiState();
    renderPlannedJobs();
  }
  document.getElementById("compactQueueCards").addEventListener("change", (event) => setCompactQueueCards(event.target.checked));
  document.getElementById("sectionStartup").addEventListener("change", (event) => {
    uiState.sectionStartup = event.target.value;
    applySectionStartupPreference();
    saveUiState();
    renderCollapseState();
  });
  document.getElementById("queueSort").addEventListener("change", (event) => {
    uiState.queueSort = event.target.value;
    saveUiState();
    renderPlannedJobs();
  });
  document.getElementById("dueWarningMinutes").addEventListener("change", (event) => {
    uiState.dueWarningMinutes = Number(event.target.value);
    saveUiState();
    renderSuites();
    renderPlannedJobs();
  });
  document.getElementById("queueMetadataButton").addEventListener("click", () => queueMetadataDialog.showModal());
  document.querySelectorAll("[data-queue-metadata]").forEach((input) => {
    input.addEventListener("change", () => {
      uiState.queueMetadata[input.dataset.queueMetadata] = input.checked;
      saveUiState();
      renderSettingsState();
      renderPlannedJobs();
    });
  });
  document.getElementById("hideEmptyArchives").addEventListener("change", (event) => {
    uiState.hideEmptyArchives = event.target.checked;
    saveUiState();
    renderCollapseState();
  });
  document.getElementById("confirmJobActions").addEventListener("change", (event) => {
    uiState.confirmJobActions = event.target.checked;
    saveUiState();
  });
  document.getElementById("previousDayButton").addEventListener("click", () => moveBoardDate(-1));
  document.getElementById("nextDayButton").addEventListener("click", () => moveBoardDate(1));
  todayButton.addEventListener("click", () => selectBoardDate(todayKey));
  boardDateInput.addEventListener("change", () => selectBoardDate(boardDateInput.value));
  document.getElementById("biffConfirmButton").addEventListener("click", confirmBiffJob);
  actionConfirmButton.addEventListener("click", () => resolveActionConfirmation(true));
  [
    [completedTypeFilter, "type"],
    [completedEditorFilter, "editor"],
    [completedSuiteFilter, "suite"]
  ].forEach(([select, key]) => {
    select.addEventListener("change", () => {
      completedFilters[key] = select.value;
      renderCompletedJobs();
    });
  });
  document.querySelectorAll("[data-close-dialog]").forEach((button) => {
    button.addEventListener("click", () => document.getElementById(button.dataset.closeDialog).close());
  });
  [jobDialog, fastTrackDialog, editJobDialog, detailDialog, handoverDialog, todoDialog, todoEditDialog, settingsDialog, queueMetadataDialog, daySheetDialog, actionConfirmDialog, biffDialog].forEach((dialog) => {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
  });
  actionConfirmDialog.addEventListener("close", () => resolveActionConfirmation(false));
  biffDialog.addEventListener("close", () => { biffingJobId = null; });
  fastTrackDialog.addEventListener("close", () => { fastTrackTarget = null; });
  todoEditDialog.addEventListener("close", () => { editingTodoId = null; setTimeout(checkTaskReminders, 0); });
  todoReminderDialog.addEventListener("close", () => { if (reminderTodoId) acknowledgeTodoReminder(false); });
  todoReminderDialog.addEventListener("click", (event) => { if (event.target === todoReminderDialog) acknowledgeTodoReminder(false); });
  jobForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (jobForm.reportValidity()) addJob(jobForm);
  });
  fastTrackForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (fastTrackForm.reportValidity()) addFastTrackJob(fastTrackForm);
  });
  editJobForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (editJobForm.reportValidity()) saveJobEdits(editJobForm);
  });
  document.getElementById("addEditorForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = document.getElementById("newEditorName");
    if (input.reportValidity()) addEditor(input.value, document.getElementById("newEditorSuite").value);
  });
  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
      if (uiState.theme === "auto") applyTheme();
    });
  }
  window.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
    const target = event.target;
    if (/INPUT|SELECT|TEXTAREA/.test(target?.tagName || "") || target?.isContentEditable) return;
    const openDialog = document.querySelector("dialog[open]");
    if (event.key.toLowerCase() === "q") {
      // The add-job control is visible only in the Queue summary.
      if (openDialog && (openDialog !== detailDialog || document.getElementById("detailAddJobButton").hidden)) return;
      event.preventDefault();
      if (detailDialog.open) detailDialog.close();
      else openSummary("pool");
      return;
    }
    if (event.key.toLowerCase() === "w") {
      if (openDialog && openDialog !== wheelDialog) return;
      event.preventDefault();
      if (wheelDialog.open) wheelDialog.close();
      else document.getElementById("wheelButton").click();
      return;
    }
    if (event.key.toLowerCase() === "c") {
      if (openDialog && openDialog !== todoDialog) return;
      event.preventDefault();
      if (todoDialog.open && todoForm.hidden) todoDialog.close();
      else openTodoDialog(false);
      return;
    }
    if (openDialog) return;
    if (event.key.toLowerCase() === "s") {
      event.preventDefault();
      openHistorySearch();
    } else if (event.key.toLowerCase() === "e") {
      event.preventDefault();
      toggleQueueVisibility();
    } else if (event.key.toLowerCase() === "t") {
      event.preventDefault();
      openTodoDialog();
    } else if (event.key.toLowerCase() === "f") {
      event.preventDefault();
      cycleSuiteFilter();
    } else if (event.key.toLowerCase() === "j") {
      event.preventDefault();
      toggleSection("pool");
    } else if (event.key.toLowerCase() === "b") {
      event.preventDefault();
      openSummary("busy");
    } else if (event.key.toLowerCase() === "n") {
      event.preventDefault();
      openNewJobDialog(false);
    } else if (event.key.toLowerCase() === "d") {
      event.preventDefault();
      openDaySheet();
    } else if (event.key.toLowerCase() === "h") {
      event.preventDefault();
      openHandover();
    }
  });
  applyTheme();
  document.getElementById("syncRetry").addEventListener("click", () => syncRetryAction?.());
  document.getElementById("syncReload").addEventListener("click", () => { void loadCloudBoard(selectedDateKey, false); });
  window.addEventListener("beforeunload", (event) => { if (pendingSave || cloudBusy || todoPendingSave || todoSaving) { event.preventDefault(); event.returnValue = ""; } });
  setInterval(async () => {
    if (remoteCheckInFlight || !cloudReady || cloudBusy || document.hidden || document.querySelector("dialog[open]") || /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || "")) return;
    remoteCheckInFlight = true;
    const date = selectedDateKey;
    const revision = cloudRevision;
    try {
      const result = await cloudRequest(date, null, { revisionOnly: true });
      if (cloudReady && !cloudBusy && date === selectedDateKey && revision === cloudRevision && result.revision !== revision && !document.querySelector("dialog[open]") && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || "")) {
        const latest = await cloudRequest(date);
        if (!cloudReady || cloudBusy || date !== selectedDateKey || revision !== cloudRevision || latest.revision === revision) return;
        cloudReady = false;
        state = latest.board || freshDayState(date); cloudRevision = latest.revision; savedSnapshot = JSON.stringify(state); remoteBoardChanges++; render(); cloudReady = true;
        syncStatus("Updated from your other device");
      }
    } catch { if (cloudReady) syncStatus("Could not check for updates · Changes will still be checked before saving"); }
    finally { remoteCheckInFlight = false; }
  }, 10000);
  setInterval(checkTaskReminders, 15000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) setTimeout(checkTaskReminders, 0); });
  window.addEventListener("focus", () => setTimeout(checkTaskReminders, 0));
  setInterval(async () => {
    if (!todoReady || todoSaving || todoPendingSave || document.hidden || document.querySelector("dialog[open]")) return;
    try {
      const result = await todoCloudRequest(null, { revisionOnly: true });
      if (result.revision !== todoRevision) await loadTodos(false);
    } catch { /* The next interval or page opening will try again. */ }
  }, 10000);
  updateClock();
  setInterval(() => {
    const dayChanged = refreshTodayKey();
    updateClock();
    if (dayChanged) renderTodos();
    if (dayChanged || selectedDateKey === todayKey) {
      renderSuites();
      renderPlannedJobs();
    }
  }, 30000);
  render();
  // Load once someone on the access list has signed in (cloud.js).
  window.Edit1Cloud.allowed.then(() => {
    void loadCloudBoard(selectedDateKey);
    void loadTodos();
  });
})();
