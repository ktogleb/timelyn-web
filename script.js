/* ==========================================================================
   TIMELYN — application logic
   Organised by component, mirroring the layer names in the Figma file:
     SplashScreen, TimerDial, TimerController, ProjectsStore, EntriesStore,
     ManageProjectsSheet, TimeEntrySheet, ClockOutAlert
   ========================================================================== */
(function () {
  "use strict";

  /* ------------------------------------------------------------------------
     Utils
  ------------------------------------------------------------------------ */
  const $ = (sel) => document.querySelector(sel);
  const uid = () => Math.random().toString(36).slice(2, 10);

  function pad2(n) { return String(n).padStart(2, "0"); }

  function formatHMS(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
  }

  function formatHM(ms) {
    const totalMin = Math.round(ms / 60000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h <= 0) return `${m}m`;
    return `${h}h ${m}m`;
  }

  function formatClockShort(date) {
    let h = date.getHours();
    const m = pad2(date.getMinutes());
    const ampm = h >= 12 ? "PM" : "AM";
    h = h % 12; if (h === 0) h = 12;
    return `${h}:${m} ${ampm}`;
  }

  function formatTimeRange(start, end) {
    const f = (d) => {
      let h = d.getHours(); const m = pad2(d.getMinutes());
      return `${pad2(h)}:${m}`;
    };
    return `${f(new Date(start))} - ${f(new Date(end))}`;
  }

  function dayKey(date) { return date.toDateString(); }

  function dayLabel(date) {
    return date.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" }).toUpperCase();
  }

  function startOfWeek(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - d.getDay()); // Sunday = 0
    return d;
  }

  /* ------------------------------------------------------------------------
     Persistence
  ------------------------------------------------------------------------ */
  const STORAGE_KEY = "timelyn-state-v1";

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* ignore corrupt storage */ }
    return null;
  }

  function seedState() {
    const now = Date.now();
    const design = { id: uid(), name: "Design", color: "var(--proj-2)" };
    const research = { id: uid(), name: "Research", color: "var(--proj-1)" };
    const todayStart = new Date(); todayStart.setHours(10, 0, 0, 0);
    return {
      projects: [design, research],
      entries: [
        {
          id: uid(), description: "Creating card design", projectId: design.id,
          start: +todayStart, end: +todayStart + 105 * 60000,
          updatedAt: +todayStart + 105 * 60000,
        },
        {
          id: uid(), description: "User testing feedback", projectId: research.id,
          start: +todayStart + 130 * 60000, end: +todayStart + 264 * 60000,
          updatedAt: +todayStart + 264 * 60000,
        },
      ],
    };
  }

  const state = loadState() || seedState();
  if (!state.projects) state.projects = [];
  if (!state.entries) state.entries = [];

  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  /* ==========================================================================
     COMPONENT: SplashScreen
     ========================================================================== */
  const SplashScreen = {
    el: $("#splash-screen"),
    ringEl: $("#splash-ring"),

    buildTicks() {
      const frag = document.createDocumentFragment();
      for (let i = 0; i < 60; i++) {
        const tick = document.createElement("div");
        tick.className = "tick" + (i % 5 === 0 ? " tick--major" : "");
        // rotation lives in --rot (read by the tick-in keyframes) instead of
        // the transform property directly, since animating `transform` via
        // CSS keyframes replaces the whole value and would wipe the rotation.
        tick.style.setProperty("--rot", `${i * 6}deg`);
        tick.style.animationDelay = `${(i % 30) * 0.012}s`;
        frag.appendChild(tick);
      }
      this.ringEl.appendChild(frag);
    },

    finish() {
      this.el.classList.add("is-leaving");
      setTimeout(() => { this.el.hidden = true; }, 620);
      AppRoot.el.hidden = false;
    },

    init() {
      this.buildTicks();
      const dismiss = () => { this.finish(); this.el.removeEventListener("click", dismiss); };
      this.el.addEventListener("click", dismiss);
      setTimeout(() => this.el.hidden || dismiss(), 2200);
    },
  };

  /* ==========================================================================
     COMPONENT: AppRoot
     ========================================================================== */
  const AppRoot = { el: $("#app-root") };

  /* ==========================================================================
     COMPONENT: TimerDial
     ========================================================================== */
  /* ==========================================================================
     COMPONENT: BlurTimerDigits — per-character "blur animated timer" style
     transition (https://www.framer.com/community/marketplace/components/
     blur-animated-timer/): each digit that changes blurs+slides out while
     its replacement blurs+slides in, staggered across whichever digits
     changed on a given tick.
     ========================================================================== */
  const BlurTimerDigits = {
    el: $("#timer-time"),
    pattern: "00:00:00",
    slots: [], // one per digit position (not separators): { slotEl, digitEl, value }
    staggerStepMs: 40,

    build() {
      this.el.innerHTML = "";
      this.slots = [];
      [...this.pattern].forEach((ch) => {
        if (ch === ":") {
          const sep = document.createElement("span");
          sep.className = "timer-sep";
          sep.textContent = ":";
          this.el.appendChild(sep);
          return;
        }
        const slot = document.createElement("span");
        slot.className = "timer-digit-slot";
        const digit = document.createElement("span");
        digit.className = "timer-digit";
        digit.textContent = ch;
        slot.appendChild(digit);
        this.el.appendChild(slot);
        this.slots.push({ slotEl: slot, digitEl: digit, value: ch });
      });
    },

    set(formatted) {
      const digits = formatted.replace(/:/g, "").split("");
      let stagger = 0;
      digits.forEach((d, i) => {
        const slot = this.slots[i];
        if (!slot || slot.value === d) return;
        const delayMs = stagger * this.staggerStepMs;
        stagger++;

        // Outgoing: freeze the old value in a throwaway clone and let it
        // blur/slide out on its own, independent of the live element.
        const leaving = slot.digitEl.cloneNode(true);
        leaving.className = "timer-digit is-leaving";
        leaving.style.animationDelay = `${delayMs}ms`;
        slot.slotEl.appendChild(leaving);
        leaving.addEventListener("animationend", () => leaving.remove(), { once: true });
        // Belt-and-braces: animationend can be skipped/throttled (e.g. a
        // backgrounded tab), which would otherwise leave stale clones
        // stacking up in the slot forever.
        setTimeout(() => leaving.remove(), delayMs + 500);

        // Incoming: swap the live element's value and replay its entrance.
        slot.value = d;
        slot.digitEl.textContent = d;
        slot.digitEl.classList.remove("is-entering");
        void slot.digitEl.offsetWidth; // force reflow so re-adding the class restarts the animation
        slot.digitEl.style.animationDelay = `${delayMs}ms`;
        slot.digitEl.classList.add("is-entering");
      });
    },
  };
  BlurTimerDigits.build();

  const TimerDial = {
    dial: $("#timer-dial"),
    ticksHost: $("#dial-ticks"),
    label: $("#timer-label"),
    ticks: [],
    lastActiveCount: -1,

    buildTicks() {
      const frag = document.createDocumentFragment();
      for (let i = 0; i < 60; i++) {
        const tick = document.createElement("div");
        tick.className = "tick" + (i % 5 === 0 ? " is-major" : "");
        tick.style.transform = `translate(-50%, -140px) rotate(${i * 6}deg)`;
        frag.appendChild(tick);
        this.ticks.push(tick);
      }
      this.ticksHost.appendChild(frag);
    },

    render(elapsedMs, label, running) {
      this.label.textContent = label;
      BlurTimerDigits.set(formatHMS(elapsedMs));
      const activeCount = Math.floor(elapsedMs / 1000) % 60;
      if (activeCount !== this.lastActiveCount) {
        for (let i = 0; i < 60; i++) {
          this.ticks[i].classList.toggle("is-active", elapsedMs > 0 && i < activeCount);
        }
        this.lastActiveCount = activeCount;
      }
      this.dial.classList.toggle("is-running", running);
    },
  };
  TimerDial.buildTicks();

  /* ==========================================================================
     COMPONENT: ProjectsStore
     ========================================================================== */
  const PROJECT_COLORS = [
    "var(--proj-1)", "var(--proj-2)", "var(--proj-3)", "var(--proj-4)",
    "var(--proj-5)", "var(--proj-6)", "var(--proj-7)",
  ];

  const ProjectsStore = {
    all() { return state.projects; },
    get(id) { return state.projects.find((p) => p.id === id); },
    add(name, color) {
      const project = { id: uid(), name: name.trim(), color };
      state.projects.push(project);
      persist();
      return project;
    },
    update(id, patch) {
      const p = this.get(id);
      if (p) Object.assign(p, patch);
      persist();
    },
    remove(id) {
      state.projects = state.projects.filter((p) => p.id !== id);
      state.entries.forEach((e) => { if (e.projectId === id) e.projectId = null; });
      persist();
    },
    // Undo for remove(): puts the project back AND re-links whichever
    // entries had their projectId cleared when it was deleted.
    restore(project, linkedEntryIds) {
      state.projects.push(project);
      state.entries.forEach((e) => { if (linkedEntryIds.includes(e.id)) e.projectId = project.id; });
      persist();
    },
  };

  /* ==========================================================================
     COMPONENT: EntriesStore
     ========================================================================== */
  const EntriesStore = {
    all() { return state.entries; },
    get(id) { return state.entries.find((e) => e.id === id); },
    add(entry) { state.entries.push({ id: uid(), updatedAt: Date.now(), ...entry }); persist(); },
    update(id, patch) {
      const e = this.get(id);
      if (e) Object.assign(e, patch, { updatedAt: Date.now() });
      persist();
    },
    remove(id) { state.entries = state.entries.filter((e) => e.id !== id); persist(); },
    // Puts a just-deleted entry back (Toast "Undo"). Treated as freshly
    // touched — same as add/update — so it resurfaces at the top of its day.
    restore(entry) { state.entries.push({ ...entry, updatedAt: Date.now() }); persist(); },

    grouped() {
      const groups = new Map();
      // Most recently worked-on entry (added or edited) leads its day's
      // list — not just whichever happens to have the latest start time.
      const sorted = [...state.entries].sort((a, b) => b.updatedAt - a.updatedAt);
      sorted.forEach((entry) => {
        const key = dayKey(new Date(entry.start));
        if (!groups.has(key)) groups.set(key, { date: new Date(entry.start), entries: [] });
        groups.get(key).entries.push(entry);
      });
      return [...groups.values()].sort((a, b) => b.date - a.date);
    },

    weekTotalMs() {
      const ws = +startOfWeek(new Date());
      return state.entries.filter((e) => e.start >= ws).reduce((sum, e) => sum + (e.end - e.start), 0);
    },

    // Total tracked time for entries starting in [start, end). Used by the
    // ActivityChart's period stat (week/month/year, whatever range it's given).
    rangeTotalMs(start, end) {
      const s = +start, e = +end;
      return state.entries
        .filter((entry) => entry.start >= s && entry.start < e)
        .reduce((sum, entry) => sum + (entry.end - entry.start), 0);
    },

    // ms tracked per project (keyed by projectId, "" for "No project") for
    // each bucket in `buckets` ({start,end} objects). One pass over every
    // entry — used by the ActivityChart bar chart.
    bucketedProjectTotals(buckets) {
      const result = buckets.map(() => new Map());
      state.entries.forEach((entry) => {
        const idx = buckets.findIndex((b) => entry.start >= +b.start && entry.start < +b.end);
        if (idx === -1) return;
        const key = entry.projectId || "";
        const map = result[idx];
        map.set(key, (map.get(key) || 0) + (entry.end - entry.start));
      });
      return result;
    },
  };

  /* ==========================================================================
     COMPONENT: SheetManager — coordinates every overlay (sheets + the
     ClockOutAlert) as a single stack, so the backdrop blur only ever
     disappears once the whole stack is empty, and opening one overlay on
     top of another visually recedes (blurs) whatever was on top before it.
     ========================================================================== */
  const SheetManager = {
    backdrop: $("#overlay-backdrop"),
    stack: [], // { el, onClose, hideDelay } — last item is the topmost overlay

    // Moves the overlay to the end of its parent so it paints above any
    // sibling overlay sitting at the same z-index (e.g. ManageProjectsSheet
    // opened from within an already-open TimeEntrySheet).
    bringToFront(el) { el.parentNode.appendChild(el); },

    open(el, onClose, hideDelay = 380) {
      const prev = this.stack[this.stack.length - 1];
      if (prev) prev.el.classList.add("is-behind");

      this.stack.push({ el, onClose, hideDelay });
      this.bringToFront(el);
      el.hidden = false;
      void el.offsetWidth; // force reflow so the transition below animates
      el.classList.add("is-open");

      this.backdrop.hidden = false;
      void this.backdrop.offsetWidth;
      this.backdrop.classList.add("is-visible");
      this.backdrop.onclick = onClose || null;
    },

    close(el) {
      const idx = this.stack.findIndex((s) => s.el === el);
      if (idx === -1) return;
      const [entry] = this.stack.splice(idx, 1);
      el.classList.remove("is-open");
      el.classList.remove("is-behind");
      setTimeout(() => { el.hidden = true; }, entry.hideDelay);

      const top = this.stack[this.stack.length - 1];
      if (top) {
        // Something is still open underneath (e.g. TimeEntrySheet behind
        // the ManageProjectsSheet we just closed) — reveal it, keep the
        // shared backdrop blur showing, and re-target its close handler.
        top.el.classList.remove("is-behind");
        this.backdrop.onclick = top.onClose || null;
      } else {
        this.backdrop.classList.remove("is-visible");
        setTimeout(() => { this.backdrop.hidden = true; }, 250);
        this.backdrop.onclick = null;
      }
    },
  };

  /* ==========================================================================
     COMPONENT: Toast — transient bottom notice, optionally with one action
     (e.g. "Undo"). Only one shows at a time; a new call replaces whatever
     is currently up and restarts its timer.
     ========================================================================== */
  const Toast = {
    el: $("#toast"),
    messageEl: $("#toast-message"),
    actionEl: $("#toast-action"),
    progressEl: $("#toast-progress"),
    timer: null,

    show({ message, actionLabel, onAction, duration = 3200 }) {
      clearTimeout(this.timer);
      this.messageEl.textContent = message;
      if (actionLabel) {
        this.actionEl.textContent = actionLabel;
        this.actionEl.hidden = false;
        this.actionEl.onclick = () => { if (onAction) onAction(); this.hide(); };
      } else {
        this.actionEl.hidden = true;
        this.actionEl.onclick = null;
      }
      this.el.hidden = false;
      void this.el.offsetWidth; // force reflow so the transition below animates
      this.el.classList.add("is-open");

      // Progress bar depletes left-to-right over `duration`, so it's obvious
      // at a glance how much longer the toast (and its Undo window) has left.
      this.progressEl.style.transition = "none";
      this.progressEl.style.transform = "scaleX(1)";
      void this.progressEl.offsetWidth; // force reflow so the reset above doesn't get merged into the animation below
      this.progressEl.style.transition = `transform ${duration}ms linear`;
      this.progressEl.style.transform = "scaleX(0)";

      this.timer = setTimeout(() => this.hide(), duration);
    },

    hide() {
      clearTimeout(this.timer);
      this.el.classList.remove("is-open");
      setTimeout(() => { this.el.hidden = true; }, 300);
    },
  };

  /* ==========================================================================
     COMPONENT: ClockOutAlert
     ========================================================================== */
  const ClockOutAlert = {
    el: $("#clockout-alert"),
    cancelBtn: $("#clockout-cancel"),
    confirmBtn: $("#clockout-confirm"),

    open() {
      SheetManager.open(this.el, () => this.close(), 220);
    },
    close() {
      SheetManager.close(this.el);
    },
    init() {
      this.cancelBtn.addEventListener("click", () => this.close());
      this.confirmBtn.addEventListener("click", () => {
        const added = TimerController.clockOut();
        this.close();
        if (added) {
          Toast.show({ message: "Time entry added to Dashboard" });
        }
      });
    },
  };

  /* ==========================================================================
     COMPONENT: ManageProjectsSheet
     ========================================================================== */
  const ManageProjectsSheet = {
    el: $("#projects-sheet"),
    swatchRow: $("#swatch-row"),
    nameInput: $("#new-project-name"),
    addBtn: $("#add-project-btn"),
    listEl: $("#project-list"),
    emptyEl: $("#projects-empty"),
    closeBtn: $("#projects-close"),
    selectedColor: PROJECT_COLORS[0],
    target: "timer", // 'timer' | 'entry'
    editingId: null, // project id currently loaded into the name/color form, or null when adding new
    addBtnReady: null,
    plusIconHTML: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1V13M1 7H13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    checkIconHTML: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2.5 7.5L5.5 10.5L11.5 3.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',

    // + swaps to a checkmark once there's a name to save — same button, just
    // signals "ready to confirm" instead of "add a new project".
    updateAddBtnIcon() {
      const ready = this.nameInput.value.trim().length > 0;
      if (ready === this.addBtnReady) return;
      this.addBtnReady = ready;
      this.addBtn.innerHTML = ready ? this.checkIconHTML : this.plusIconHTML;
      this.addBtn.classList.remove("icon-pop");
      void this.addBtn.offsetWidth; // force reflow so the animation below re-triggers
      this.addBtn.classList.add("icon-pop");
    },

    // Used both by a swatch click and by startEdit() pre-selecting the
    // edited project's current color.
    selectColor(color) {
      this.selectedColor = color;
      [...this.swatchRow.children].forEach((c) => {
        c.classList.toggle("is-selected", c.dataset.color === color);
      });
    },

    buildSwatches() {
      this.swatchRow.innerHTML = "";
      PROJECT_COLORS.forEach((color, i) => {
        const sw = document.createElement("button");
        sw.type = "button";
        sw.className = "swatch" + (i === 0 ? " is-selected" : "");
        sw.dataset.color = color;
        sw.style.background = color;
        sw.style.color = color;
        sw.addEventListener("click", () => this.selectColor(color));
        this.swatchRow.appendChild(sw);
      });
    },

    renderList() {
      this.listEl.innerHTML = "";
      const projects = ProjectsStore.all();
      this.emptyEl.hidden = projects.length > 0;
      const currentId = this.target === "timer" ? TimerController.projectId : TimeEntrySheet.draft.projectId;
      projects.forEach((p) => {
        const row = document.createElement("div");
        row.className = "project-item"
          + (p.id === currentId ? " is-active" : "")
          + (p.id === this.editingId ? " is-editing" : "");
        row.innerHTML = `
          <span class="project-item__dot" style="background:${p.color}"></span>
          <span class="project-item__name"></span>
          <button type="button" class="project-item__edit" aria-label="Edit project">
            <svg width="17" height="17" viewBox="0 0 14 14" fill="none"><path d="M9.5 1.5l3 3L4 13H1v-3L9.5 1.5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>
          </button>
          <button type="button" class="project-item__delete" aria-label="Delete project">
            <svg width="17" height="17" viewBox="0 0 14 14" fill="none"><path d="M2 4h10M5.5 4V2.5h3V4M3.5 4l.5 8.5a1 1 0 001 1h4a1 1 0 001-1L10.5 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>`;
        row.querySelector(".project-item__name").textContent = p.name;
        row.addEventListener("click", () => this.selectProject(p));
        row.querySelector(".project-item__edit").addEventListener("click", (ev) => {
          ev.stopPropagation();
          if (this.editingId === p.id) this.cancelEdit();
          else this.startEdit(p);
        });
        row.querySelector(".project-item__delete").addEventListener("click", (ev) => {
          ev.stopPropagation();
          const linkedEntryIds = EntriesStore.all().filter((e) => e.projectId === p.id).map((e) => e.id);
          const wasTimerProject = TimerController.projectId === p.id;
          const wasDraftProject = TimeEntrySheet.draft.projectId === p.id;

          ProjectsStore.remove(p.id);
          if (wasTimerProject) TimerController.setProject(null);
          if (wasDraftProject) TimeEntrySheet.setProject(null);
          if (this.editingId === p.id) this.cancelEdit();
          this.renderList();
          EntriesView.render(); // entries pointing at this project drop to "No project" immediately

          Toast.show({
            message: "Project deleted",
            actionLabel: "Undo",
            duration: 5000,
            onAction: () => {
              ProjectsStore.restore(p, linkedEntryIds);
              if (wasTimerProject) TimerController.setProject(p);
              if (wasDraftProject) TimeEntrySheet.setProject(p);
              this.renderList();
              EntriesView.render();
            },
          });
        });
        this.listEl.appendChild(row);
      });
    },

    selectProject(p) {
      if (this.target === "timer") TimerController.setProject(p);
      else TimeEntrySheet.setProject(p);
      this.close();
    },

    // Loads an existing project's name/color into the form at the top, so
    // the same +/✓ button that adds a new project instead saves changes to
    // this one. Tapping its pencil again (see renderList) cancels back out.
    startEdit(p) {
      this.editingId = p.id;
      this.nameInput.value = p.name;
      this.selectColor(p.color);
      this.updateAddBtnIcon();
      this.nameInput.focus();
      this.nameInput.select();
      this.renderList();
    },
    cancelEdit() {
      this.editingId = null;
      this.nameInput.value = "";
      this.selectColor(PROJECT_COLORS[0]);
      this.updateAddBtnIcon();
      this.renderList();
    },

    open(target) {
      this.target = target;
      this.cancelEdit(); // always start on a clean "add new" form (also renders the list)
      SheetManager.open(this.el, () => this.close());
    },
    close() {
      SheetManager.close(this.el);
    },

    init() {
      this.buildSwatches();
      this.updateAddBtnIcon();
      this.closeBtn.addEventListener("click", () => this.close());
      this.nameInput.addEventListener("input", () => this.updateAddBtnIcon());
      this.addBtn.addEventListener("click", () => {
        const name = this.nameInput.value.trim();
        if (!name) { this.nameInput.focus(); return; }
        if (this.editingId) {
          ProjectsStore.update(this.editingId, { name, color: this.selectedColor });
          EntriesView.render(); // entry rows show this project's name/dot — refresh in case either changed
        } else {
          ProjectsStore.add(name, this.selectedColor);
        }
        this.cancelEdit();
        this.renderList();
      });
      this.nameInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") this.addBtn.click();
      });
    },
  };

  /* ==========================================================================
     COMPONENT: TimeEntrySheet — shared Add / Edit form
     ========================================================================== */
  const TimeEntrySheet = {
    el: $("#entry-sheet"),
    title: $("#entry-sheet-title"),
    closeBtn: $("#entry-sheet-close"),
    descInput: $("#entry-description"),
    projectBtn: $("#entry-project-select"),
    projectDot: $("#entry-project-dot"),
    projectText: $("#entry-project-text"),
    dateInput: $("#entry-date"),
    startInput: $("#entry-start-time"),
    endInput: $("#entry-end-time"),
    durationValue: $("#entry-duration-value"),
    submitBtn: $("#entry-submit-btn"),
    deleteBtn: $("#entry-delete-btn"),
    mode: "add", // 'add' | 'edit'
    editId: null,
    draft: { description: "", projectId: null, date: null, startMin: null, endMin: null },

    setProject(project) {
      this.draft.projectId = project ? project.id : null;
      this.projectDot.hidden = !project;
      if (project) this.projectDot.style.background = project.color;
      this.projectText.textContent = project ? project.name : "No project selected";
    },

    // <input type="time">'s value is always 24h "HH:MM" regardless of the
    // native picker's display locale, so these just convert to/from minutes.
    minutesToTimeValue(min) {
      if (min == null) return "";
      return `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;
    },
    timeValueToMinutes(value) {
      if (!value) return null;
      const [h, m] = value.split(":").map(Number);
      return h * 60 + m;
    },

    updateDuration() {
      const { startMin, endMin } = this.draft;
      if (startMin == null || endMin == null || endMin <= startMin) {
        this.durationValue.textContent = "—";
      } else {
        this.durationValue.textContent = formatHM((endMin - startMin) * 60000);
      }
      this.validate();
    },

    validate() {
      const ok = this.draft.description.trim().length > 0 &&
        this.draft.startMin != null && this.draft.endMin != null &&
        this.draft.endMin > this.draft.startMin;
      this.submitBtn.disabled = !ok;
    },

    openAdd() {
      this.mode = "add";
      this.editId = null;
      this.title.textContent = "Add Time Entry";
      this.submitBtn.textContent = "Add Entry";
      this.deleteBtn.hidden = true;
      this.draft = { description: "", projectId: TimerController.projectId, date: new Date(), startMin: null, endMin: null };
      this.descInput.value = "";
      this.setProject(ProjectsStore.get(this.draft.projectId));
      this.dateInput.value = this.toDateInputValue(this.draft.date);
      this.startInput.value = "";
      this.endInput.value = "";
      this.durationValue.textContent = "—";
      this.validate();
      this.show();
    },

    openEdit(entryId) {
      const entry = EntriesStore.get(entryId);
      if (!entry) return;
      this.mode = "edit";
      this.editId = entryId;
      this.title.textContent = "Edit Entry";
      this.submitBtn.textContent = "Save Changes";
      this.deleteBtn.hidden = false;
      const start = new Date(entry.start), end = new Date(entry.end);
      this.draft = {
        description: entry.description, projectId: entry.projectId, date: start,
        startMin: start.getHours() * 60 + start.getMinutes(),
        endMin: end.getHours() * 60 + end.getMinutes(),
      };
      this.descInput.value = entry.description;
      this.setProject(ProjectsStore.get(entry.projectId));
      this.dateInput.value = this.toDateInputValue(start);
      this.startInput.value = this.minutesToTimeValue(this.draft.startMin);
      this.endInput.value = this.minutesToTimeValue(this.draft.endMin);
      this.updateDuration();
      this.show();
    },

    toDateInputValue(d) {
      return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    },

    show() {
      SheetManager.open(this.el, () => this.close());
    },
    close() {
      SheetManager.close(this.el);
    },

    submit() {
      const [y, m, d] = this.dateInput.value.split("-").map(Number);
      const baseDate = new Date(y, (m || 1) - 1, d || 1);
      const start = new Date(baseDate); start.setHours(Math.floor(this.draft.startMin / 60), this.draft.startMin % 60, 0, 0);
      const end = new Date(baseDate); end.setHours(Math.floor(this.draft.endMin / 60), this.draft.endMin % 60, 0, 0);
      const payload = {
        description: this.draft.description.trim() || "Untitled",
        projectId: this.draft.projectId,
        start: +start, end: +end,
      };
      if (this.mode === "add") EntriesStore.add(payload);
      else EntriesStore.update(this.editId, payload);
      EntriesView.render();
      this.close();
    },

    init() {
      this.closeBtn.addEventListener("click", () => this.close());
      this.descInput.addEventListener("input", () => { this.draft.description = this.descInput.value; this.validate(); });
      this.projectBtn.addEventListener("click", () => ManageProjectsSheet.open("entry"));
      this.dateInput.addEventListener("change", () => {
        const [y, m, d] = this.dateInput.value.split("-").map(Number);
        this.draft.date = new Date(y, (m || 1) - 1, d || 1);
      });
      this.startInput.addEventListener("input", () => {
        this.draft.startMin = this.timeValueToMinutes(this.startInput.value);
        this.updateDuration();
      });
      this.endInput.addEventListener("input", () => {
        this.draft.endMin = this.timeValueToMinutes(this.endInput.value);
        this.updateDuration();
      });
      this.submitBtn.addEventListener("click", () => this.submit());
      this.deleteBtn.addEventListener("click", () => {
        if (this.editId) {
          EntriesStore.remove(this.editId);
          EntriesView.render();
        }
        this.close();
      });
    },
  };

  /* ==========================================================================
     COMPONENT: EntriesView — renders TimeEntriesSection list
     ========================================================================== */
  const EntriesView = {
    listEl: $("#entries-list"),
    emptyEl: $("#entries-empty"),
    weekRow: $("#week-total-row"),
    weekValue: $("#week-total-value"),

    entryRowHTML(entry) {
      const project = ProjectsStore.get(entry.projectId);
      const color = project ? project.color : "var(--color-input-border)";
      const projectName = project ? project.name : "No project";
      return `
        <div class="entry-item" data-id="${entry.id}">
          <span class="entry-item__dot" style="background:${color}"></span>
          <span class="entry-item__main">
            <span class="entry-item__title"></span>
            <span class="entry-item__meta"></span>
          </span>
          <span class="entry-item__duration">${formatHMS(entry.end - entry.start)}</span>
          <span class="entry-item__actions">
            <button type="button" class="edit" aria-label="Edit entry">
              <svg width="17" height="17" viewBox="0 0 14 14" fill="none"><path d="M9.5 1.5l3 3L4 13H1v-3L9.5 1.5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>
            </button>
            <button type="button" class="delete" aria-label="Delete entry">
              <svg width="17" height="17" viewBox="0 0 14 14" fill="none"><path d="M2 4h10M5.5 4V2.5h3V4M3.5 4l.5 8.5a1 1 0 001 1h4a1 1 0 001-1L10.5 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
          </span>
        </div>`;
    },

    render() {
      const groups = EntriesStore.grouped();
      this.listEl.innerHTML = "";
      this.emptyEl.hidden = groups.length !== 0;
      this.weekRow.hidden = groups.length === 0;
      this.weekValue.textContent = formatHMS(EntriesStore.weekTotalMs());

      groups.forEach((group) => {
        const dayTotal = group.entries.reduce((s, e) => s + (e.end - e.start), 0);
        const wrap = document.createElement("div");
        wrap.className = "day-group";
        wrap.innerHTML = `<div class="day-group__header"><span></span><span>${formatHMS(dayTotal)}</span></div>`;
        wrap.querySelector("span").textContent = dayLabel(group.date);
        group.entries.forEach((entry) => {
          wrap.insertAdjacentHTML("beforeend", this.entryRowHTML(entry));
          const row = wrap.lastElementChild;
          const project = ProjectsStore.get(entry.projectId);
          row.querySelector(".entry-item__title").textContent = entry.description || "Untitled";
          row.querySelector(".entry-item__meta").textContent =
            `${project ? project.name : "No project"} · ${formatTimeRange(entry.start, entry.end)}`;
          row.querySelector(".edit").addEventListener("click", () => TimeEntrySheet.openEdit(entry.id));
          row.querySelector(".delete").addEventListener("click", () => this.removeWithAnimation(entry.id, row));
        });
        this.listEl.appendChild(wrap);
      });

      ActivityChart.render();
    },

    removeWithAnimation(id, row) {
      const entry = EntriesStore.get(id);
      row.classList.add("is-removing");
      setTimeout(() => {
        EntriesStore.remove(id);
        this.render();
        if (entry) {
          Toast.show({
            message: "Entry deleted",
            actionLabel: "Undo",
            duration: 5000,
            onAction: () => {
              EntriesStore.restore(entry);
              this.render();
            },
          });
        }
      }, 260);
    },
  };

  /* ==========================================================================
     COMPONENT: ActivityChart — DashboardScreen grouped bar chart, one bar
     per project per time bucket, filterable by Week / Month / Year.
     ========================================================================== */
  const ActivityChart = {
    cardEl: document.querySelector(".activity-card"),
    periodLabelEl: $("#activity-period-label"),
    totalEl: $("#activity-total-value"),
    plotEl: $("#bar-chart-plot"),
    axisEl: $("#bar-chart-axis"),
    yAxisEl: $("#bar-chart-yaxis"),
    gridlinesEl: $("#bar-chart-gridlines"),
    scrollEl: $("#bar-chart-scroll"),
    legendEl: $("#bar-chart-legend"),
    emptyEl: $("#bar-chart-empty"),
    tooltipEl: $("#chart-tooltip"),
    tooltipDot: $("#chart-tooltip-dot"),
    tooltipName: $("#chart-tooltip-name"),
    tooltipValue: $("#chart-tooltip-value"),
    thumbEl: $("#period-switch-thumb"),
    btns: Array.from(document.querySelectorAll(".period-switch__btn")),
    period: "week", // 'week' | 'month' | 'year'
    dayNamesShort: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    monthNamesShort: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
    yearsShown: 7,
    barWidth: 18,
    barGap: 7,
    groupGap: 10,
    plotHeight: 140,
    yTicks: 4, // + the implicit 0h baseline = 5 labels/gridlines total

    // Rounds a raw per-tick value up to a "nice" round number of hours, so
    // the Y-axis reads e.g. 0/2/4/6/8h instead of 0/1.7/3.4/5.1/6.8h.
    niceStep(raw) {
      const steps = [0.25, 0.5, 1, 2, 3, 5, 10, 15, 20, 25, 50, 100, 150, 200, 250, 500, 1000];
      for (const s of steps) if (s >= raw) return s;
      return Math.ceil(raw / 500) * 500;
    },
    formatHourLabel(h) {
      if (h === 0) return "0h";
      return (h % 1 === 0 ? h : h.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")) + "h";
    },

    // Bucket granularity is one level below the selected filter — Week
    // shows the 7 days of the current week, Month shows the 12 months of
    // the current year (Jan..Dec), Year shows a run of calendar years.
    getBuckets() {
      const now = new Date();
      if (this.period === "week") {
        const start = startOfWeek(now);
        return Array.from({ length: 7 }, (_, i) => {
          const bStart = new Date(start); bStart.setDate(start.getDate() + i);
          const bEnd = new Date(bStart); bEnd.setDate(bStart.getDate() + 1);
          return { start: bStart, end: bEnd, label: this.dayNamesShort[bStart.getDay()].slice(0, 3) };
        });
      }
      if (this.period === "month") {
        const year = now.getFullYear();
        return Array.from({ length: 12 }, (_, m) => ({
          start: new Date(year, m, 1),
          end: new Date(year, m + 1, 1),
          label: this.monthNamesShort[m],
        }));
      }
      const endYear = now.getFullYear();
      const startYear = endYear - (this.yearsShown - 1);
      return Array.from({ length: this.yearsShown }, (_, i) => {
        const y = startYear + i;
        return { start: new Date(y, 0, 1), end: new Date(y + 1, 0, 1), label: String(y) };
      });
    },

    periodLabel(buckets) {
      if (this.period === "week") return "This week";
      if (this.period === "month") return String(buckets[0].start.getFullYear());
      return `${buckets[0].start.getFullYear()}–${buckets[buckets.length - 1].start.getFullYear()}`;
    },

    activeBar: null,

    // Tap a bar to show its tooltip (replacing whichever was showing);
    // tap anywhere outside a bar to dismiss it — see the document-level
    // click listener in init(). Plain taps, not press-and-hold: holding
    // fought with the browser's own long-press text-selection/callout and
    // with the horizontal scroll gesture, so it never worked reliably.
    showTooltip(bar) {
      const rect = bar.getBoundingClientRect();
      const cardRect = this.cardEl.getBoundingClientRect();
      this.tooltipDot.style.background = bar.dataset.color;
      this.tooltipName.textContent = bar.dataset.name;
      this.tooltipValue.textContent = bar.dataset.value;
      this.tooltipEl.hidden = false;
      this.tooltipEl.style.left = `${rect.left - cardRect.left + rect.width / 2}px`;
      this.tooltipEl.style.top = `${rect.top - cardRect.top - 8}px`;
      void this.tooltipEl.offsetWidth; // force reflow so the transition below animates
      this.tooltipEl.classList.add("is-visible");
      if (this.activeBar && this.activeBar !== bar) this.activeBar.classList.remove("is-active");
      bar.classList.add("is-active");
      this.activeBar = bar;
    },
    hideTooltip() {
      this.tooltipEl.classList.remove("is-visible");
      if (this.activeBar) { this.activeBar.classList.remove("is-active"); this.activeBar = null; }
      setTimeout(() => {
        if (!this.tooltipEl.classList.contains("is-visible")) this.tooltipEl.hidden = true;
      }, 150);
    },
    wireTooltip(bar) {
      bar.addEventListener("click", (e) => {
        e.stopPropagation(); // don't let this reach the document listener that hides it
        this.showTooltip(bar);
      });
    },

    render() {
      const buckets = this.getBuckets();
      const rangeStart = buckets[0].start, rangeEnd = buckets[buckets.length - 1].end;
      this.periodLabelEl.textContent = this.periodLabel(buckets);
      this.totalEl.textContent = formatHMS(EntriesStore.rangeTotalMs(rangeStart, rangeEnd));

      const perBucket = EntriesStore.bucketedProjectTotals(buckets);
      const seenKeys = new Set();
      perBucket.forEach((map) => map.forEach((ms, key) => { if (ms > 0) seenKeys.add(key); }));
      const series = ProjectsStore.all()
        .filter((p) => seenKeys.has(p.id))
        .map((p) => ({ key: p.id, name: p.name, color: p.color }));
      if (seenKeys.has("")) series.push({ key: "", name: "No project", color: "var(--color-input-border)" });

      this.emptyEl.hidden = series.length > 0;
      this.plotEl.querySelectorAll(".bar-chart__group").forEach((el) => el.remove());
      this.axisEl.innerHTML = "";
      this.legendEl.innerHTML = "";
      this.yAxisEl.innerHTML = "";
      this.gridlinesEl.innerHTML = "";
      this.hideTooltip();
      if (series.length === 0) return;

      // Groups fill the card edge-to-edge with no dead space when they fit;
      // only fall back to their natural (smaller) width — and let
      // .bar-chart__scroll take over — once there are too many buckets or
      // series to fit without squishing the bars.
      const minGroupWidth = series.length * this.barWidth + (series.length - 1) * this.barGap;
      const availableWidth = this.scrollEl.clientWidth - this.groupGap * (buckets.length - 1);
      const groupWidth = Math.max(minGroupWidth, availableWidth / buckets.length);

      // Round the tallest bar's value up to a "nice" hour figure so the
      // Y-axis reads e.g. 0/2/4/6/8h — bars scale against that, not the
      // raw max, so the tallest one doesn't necessarily touch the top.
      const rawMaxMs = Math.max(0, ...perBucket.flatMap((m) => [...m.values()]));
      const stepHours = this.niceStep(rawMaxMs / 3600000 / this.yTicks || 0.25);
      const maxMs = stepHours * this.yTicks * 3600000;

      for (let t = 0; t <= this.yTicks; t++) {
        const bottomPct = (t / this.yTicks) * 100;
        const label = document.createElement("span");
        label.className = "bar-chart__yaxis-label";
        label.style.bottom = `${bottomPct}%`;
        label.textContent = this.formatHourLabel(stepHours * t);
        this.yAxisEl.appendChild(label);
        if (t > 0) {
          const line = document.createElement("div");
          line.className = "bar-chart__gridline";
          line.style.bottom = `${bottomPct}%`;
          this.gridlinesEl.appendChild(line);
        }
      }

      const now = new Date();
      let currentGroup = null;

      buckets.forEach((bucket, i) => {
        const group = document.createElement("div");
        group.className = "bar-chart__group";
        group.style.width = `${groupWidth}px`;
        series.forEach((s) => {
          const ms = perBucket[i].get(s.key) || 0;
          const heightPct = ms > 0 ? Math.max((ms / maxMs) * 100, 1.5) : 0;
          const bar = document.createElement("div");
          bar.className = "bar-chart__bar";
          bar.style.width = `${this.barWidth}px`;
          bar.style.height = `${heightPct}%`;
          bar.style.background = s.color;
          bar.dataset.name = s.name;
          bar.dataset.color = s.color;
          bar.dataset.value = formatHM(ms);
          this.wireTooltip(bar);
          group.appendChild(bar);
        });
        this.plotEl.appendChild(group);
        if (now >= bucket.start && now < bucket.end) currentGroup = group;

        const label = document.createElement("span");
        label.className = "bar-chart__axis-label";
        label.style.width = `${groupWidth}px`;
        label.textContent = bucket.label;
        this.axisEl.appendChild(label);
      });

      this.legendEl.innerHTML = series.map((s) => `
        <span class="bar-chart__legend-item">
          <span class="bar-chart__legend-dot" style="background:${s.color}"></span>${s.name}
        </span>`).join("");

      // Open scrolled to today's day / this month / this year, not stuck
      // at the start of the range (e.g. January when it's December).
      if (currentGroup) {
        const target = currentGroup.offsetLeft - (this.scrollEl.clientWidth - currentGroup.offsetWidth) / 2;
        this.scrollEl.scrollLeft = Math.max(0, target);
      }
    },

    setPeriod(period) {
      if (period === this.period) return;
      this.period = period;
      const idx = ["week", "month", "year"].indexOf(period);
      this.thumbEl.style.transform = `translateX(${idx * 28}px)`;
      this.btns.forEach((btn) => {
        const active = btn.dataset.period === period;
        btn.classList.toggle("is-active", active);
        btn.setAttribute("aria-selected", String(active));
      });
      this.render();
    },

    init() {
      this.btns.forEach((btn) => {
        btn.addEventListener("click", () => this.setPeriod(btn.dataset.period));
      });
      // Tapping anywhere that isn't a bar dismisses whichever tooltip is open.
      document.addEventListener("click", (e) => {
        if (this.activeBar && !e.target.closest(".bar-chart__bar")) this.hideTooltip();
      });
      this.render();
    },
  };

  /* ==========================================================================
     COMPONENT: ScreenSwitcher — drives the bottom TabBar, toggles
     Timer / Dashboard / Settings. Each screen slides in from whichever
     side it sits on relative to the newly-active one (tab order), so the
     transition direction always matches the tapped tab's position.
     ========================================================================== */
  const ScreenSwitcher = {
    order: ["timer", "dashboard", "settings"],
    panels: {
      timer: $("#timer-screen"),
      dashboard: $("#dashboard-screen"),
      settings: $("#settings-screen"),
    },
    indicator: $("#tab-bar-indicator"),
    btns: Array.from(document.querySelectorAll(".tab-bar__btn")),
    current: "timer",

    layout(animate) {
      const activeIdx = this.order.indexOf(this.current);
      this.order.forEach((name, i) => {
        const el = this.panels[name];
        if (!animate) el.style.transition = "none";
        el.style.transform = `translateX(${(i - activeIdx) * 28}px)`;
        el.classList.toggle("is-active", name === this.current);
        if (!animate) { void el.offsetWidth; el.style.transition = ""; }
      });
    },

    show(name) {
      if (name === this.current) return;
      this.current = name;
      this.layout(true);
      this.indicator.style.transform = `translateX(${this.order.indexOf(name) * 86}px)`;
      this.btns.forEach((btn) => {
        const active = btn.dataset.screen === name;
        btn.classList.toggle("is-active", active);
        btn.setAttribute("aria-selected", String(active));
      });
      if (name === "dashboard") ActivityChart.render();
    },

    init() {
      this.btns.forEach((btn) => {
        btn.addEventListener("click", () => this.show(btn.dataset.screen));
      });
      this.layout(false); // place all three screens without animating the initial state
      this.initDragToSwitch();
    },

    // Press and hold any tab, then drag across the bar to preview/switch
    // screens live under the finger — same gesture feel as iOS's own
    // Control Center / home-screen quick-action bars.
    initDragToSwitch() {
      const el = $("#tab-bar");
      const LONG_PRESS_MS = 220;
      const MOVE_CANCEL_PX = 10;
      let pressTimer = null;
      let dragging = false;
      let startX = 0, startY = 0;
      let activePointerId = null;

      const btnAt = (x, y) => {
        const hit = document.elementFromPoint(x, y);
        return hit && hit.closest(".tab-bar__btn");
      };

      const endDrag = () => {
        clearTimeout(pressTimer);
        if (dragging) {
          el.classList.remove("is-dragging");
          if (activePointerId != null) {
            try { el.releasePointerCapture(activePointerId); } catch (e) { /* already released */ }
          }
        }
        dragging = false;
        activePointerId = null;
      };

      el.addEventListener("pointerdown", (e) => {
        if (!e.target.closest(".tab-bar__btn")) return;
        startX = e.clientX; startY = e.clientY;
        activePointerId = e.pointerId;
        clearTimeout(pressTimer);
        pressTimer = setTimeout(() => {
          dragging = true;
          el.classList.add("is-dragging");
          try { el.setPointerCapture(activePointerId); } catch (err) { /* ignore */ }
        }, LONG_PRESS_MS);
      });

      el.addEventListener("pointermove", (e) => {
        if (e.pointerId !== activePointerId) return;
        if (!dragging) {
          // Moved too far before the long-press fired — this is a normal
          // tap/flick, not a hold-and-drag; let it resolve as a plain click.
          if (Math.hypot(e.clientX - startX, e.clientY - startY) > MOVE_CANCEL_PX) {
            clearTimeout(pressTimer);
          }
          return;
        }
        const btn = btnAt(e.clientX, e.clientY);
        if (btn && btn.dataset.screen !== this.current) this.show(btn.dataset.screen);
      });

      el.addEventListener("pointerup", endDrag);
      el.addEventListener("pointercancel", endDrag);
    },
  };

  /* ==========================================================================
     COMPONENT: ThemeController — Light / Dark, persisted in localStorage.
     A blocking inline <script> in <head> already applies the saved theme
     before first paint (avoids a light-then-dark flash on reload); this
     just keeps the Settings toggle in sync with that and handles switching.
     ========================================================================== */
  const ThemeController = {
    key: "timelyn-theme",
    toggle: $("#theme-toggle"),

    isDark() { return document.documentElement.getAttribute("data-theme") === "dark"; },

    apply(dark) {
      document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
      this.toggle.classList.toggle("is-on", dark);
      this.toggle.setAttribute("aria-checked", String(dark));
    },

    init() {
      this.apply(this.isDark());
      this.toggle.addEventListener("click", () => {
        const dark = !this.isDark();
        this.apply(dark);
        try { localStorage.setItem(this.key, dark ? "dark" : "light"); } catch (e) { /* ignore */ }
      });
    },
  };

  /* ==========================================================================
     COMPONENT: Paywall — full-screen subscription upsell (Week / Month /
     Year plans + a Free Trial toggle). No real billing — the CTA just
     confirms via a Toast and closes, since this is a design prototype.
     ========================================================================== */
  const Paywall = {
    el: $("#paywall"),
    closeBtn: $("#paywall-close"),
    trialToggle: $("#trial-toggle"),
    plansEl: $("#paywall-plans"),
    ctaBtn: $("#paywall-cta"),
    fineprintEl: $("#paywall-fineprint"),
    restoreBtn: $("#paywall-restore"),
    termsBtn: $("#paywall-terms"),
    privacyBtn: $("#paywall-privacy"),
    openBtn: $("#open-paywall-btn"),

    plans: [
      { id: "week", name: "Week", price: 6.99, period: "week" },
      { id: "month", name: "Month", price: 14.99, period: "month" },
      { id: "year", name: "Year", price: 69.99, period: "year", badge: "Best Value" },
    ],
    selected: "year",
    trialEnabled: true,

    money(n) { return `$${n.toFixed(2)}`; },
    perWeekOf(plan) {
      const weeks = plan.period === "month" ? 52 / 12 : plan.period === "year" ? 52 : 1;
      return this.money(plan.price / weeks) + " / week";
    },

    renderPlans() {
      this.plansEl.innerHTML = this.plans.map((p) => `
        <button type="button" class="plan-card${p.id === this.selected ? " is-selected" : ""}" data-plan="${p.id}">
          ${p.badge ? `<span class="plan-card__badge">${p.badge}</span>` : ""}
          <span class="plan-card__radio" aria-hidden="true"></span>
          <span class="plan-card__info">
            <span class="plan-card__name">${p.name}</span>
            <span class="plan-card__sub">${p.id === "week" ? "No commitment" : this.perWeekOf(p)}</span>
          </span>
          <span class="plan-card__price">
            <span class="plan-card__amount">${this.money(p.price)}</span>
            <span class="plan-card__period">/ ${p.period}</span>
          </span>
        </button>`).join("");
      this.plansEl.querySelectorAll(".plan-card").forEach((btn) => {
        btn.addEventListener("click", () => {
          this.selected = btn.dataset.plan;
          this.renderPlans();
          this.renderCTA();
        });
      });
    },

    renderCTA() {
      const plan = this.plans.find((p) => p.id === this.selected);
      if (this.trialEnabled) {
        this.ctaBtn.textContent = "Start Free Trial";
        this.fineprintEl.textContent = `7 days free, then ${this.money(plan.price)}/${plan.period}. Cancel anytime.`;
      } else {
        this.ctaBtn.textContent = `Subscribe — ${this.money(plan.price)}/${plan.period}`;
        this.fineprintEl.textContent = "Renews automatically. Cancel anytime.";
      }
    },

    open() {
      this.el.hidden = false;
      void this.el.offsetWidth; // force reflow so the transition below animates
      this.el.classList.add("is-open");
    },
    close() {
      this.el.classList.remove("is-open");
      setTimeout(() => { this.el.hidden = true; }, 380);
    },

    init() {
      this.renderPlans();
      this.renderCTA();

      this.openBtn.addEventListener("click", () => this.open());
      this.closeBtn.addEventListener("click", () => this.close());

      this.trialToggle.addEventListener("click", () => {
        this.trialEnabled = !this.trialEnabled;
        this.trialToggle.classList.toggle("is-on", this.trialEnabled);
        this.trialToggle.setAttribute("aria-checked", String(this.trialEnabled));
        this.renderCTA();
      });

      this.ctaBtn.addEventListener("click", () => {
        const plan = this.plans.find((p) => p.id === this.selected);
        this.close();
        Toast.show({
          message: this.trialEnabled
            ? `Free trial started — welcome to Pro! (${plan.name})`
            : `Subscribed to Timelyn Pro — ${plan.name}`,
        });
      });

      this.restoreBtn.addEventListener("click", () => Toast.show({ message: "No previous purchases found" }));
      this.termsBtn.addEventListener("click", () => Toast.show({ message: "Prototype — no real Terms of Service" }));
      this.privacyBtn.addEventListener("click", () => Toast.show({ message: "Prototype — no real Privacy Policy" }));
    },
  };

  /* ==========================================================================
     COMPONENT: TimerController — Ready / Elapsed / Paused state machine
     ========================================================================== */
  const TimerController = {
    taskInput: $("#task-input"),
    projectBtn: $("#project-select"),
    projectDot: $("#project-select-dot"),
    projectText: $("#project-select-text"),
    actionsEl: $("#timer-actions"),

    running: false,
    paused: false,
    startedAt: 0,
    elapsedBeforePause: 0,
    projectId: null,
    interval: null,

    setProject(project) {
      this.projectId = project ? project.id : null;
      this.projectDot.hidden = !project;
      if (project) this.projectDot.style.background = project.color;
      this.projectText.textContent = project ? project.name : "No project selected";
    },

    elapsedMs() {
      if (this.running) return Date.now() - this.startedAt;
      return this.elapsedBeforePause;
    },

    renderActions() {
      if (!this.running && !this.paused) {
        this.actionsEl.innerHTML = `<button type="button" class="btn btn--primary btn--block" id="start-btn">Start</button>`;
        $("#start-btn").addEventListener("click", () => this.start());
      } else if (this.running) {
        this.actionsEl.innerHTML = `
          <button type="button" class="btn btn--secondary" id="pause-btn">Pause</button>
          <button type="button" class="btn btn--primary" id="clockout-btn">Clock Out</button>`;
        $("#pause-btn").addEventListener("click", () => this.pause());
        $("#clockout-btn").addEventListener("click", () => ClockOutAlert.open());
      } else if (this.paused) {
        this.actionsEl.innerHTML = `
          <button type="button" class="btn btn--secondary" id="continue-btn">Continue</button>
          <button type="button" class="btn btn--primary" id="clockout-btn">Clock Out</button>`;
        $("#continue-btn").addEventListener("click", () => this.resume());
        $("#clockout-btn").addEventListener("click", () => ClockOutAlert.open());
      }
    },

    tick() {
      const label = this.running ? "Elapsed" : this.paused ? "Paused" : "Ready";
      TimerDial.render(this.elapsedMs(), label, this.running);
    },

    start() {
      this.running = true; this.paused = false;
      this.startedAt = Date.now() - this.elapsedBeforePause;
      this.renderActions();
      this.interval = setInterval(() => this.tick(), 1000);
      this.tick();
    },
    pause() {
      this.running = false; this.paused = true;
      this.elapsedBeforePause = Date.now() - this.startedAt;
      clearInterval(this.interval);
      this.renderActions();
      this.tick();
    },
    resume() {
      this.start();
    },
    clockOut() {
      const elapsed = this.elapsedMs();
      const end = Date.now();
      const start = end - elapsed;
      const added = elapsed > 1000;
      if (added) {
        EntriesStore.add({
          description: this.taskInput.value.trim() || "Untitled",
          projectId: this.projectId,
          start, end,
        });
        EntriesView.render();
      }
      clearInterval(this.interval);
      this.running = false; this.paused = false;
      this.elapsedBeforePause = 0;
      this.taskInput.value = "";
      this.setProject(null);
      this.renderActions();
      this.tick();
      return added;
    },

    init() {
      this.renderActions();
      this.tick();
      this.projectBtn.addEventListener("click", () => ManageProjectsSheet.open("timer"));
    },
  };

  /* ==========================================================================
     Wire up remaining top-level controls + status bar clock
     ========================================================================== */
  function initStatusClock() {
    const el = $("#clock-time");
    const update = () => { el.textContent = formatClockShort(new Date()).replace(/ (AM|PM)$/, ""); };
    update();
    setInterval(update, 30000);
  }

  $("#add-time-btn").addEventListener("click", () => TimeEntrySheet.openAdd());

  /* ==========================================================================
     Boot
     ========================================================================== */
  ManageProjectsSheet.init();
  TimeEntrySheet.init();
  ClockOutAlert.init();
  Paywall.init();
  TimerController.init();
  ScreenSwitcher.init();
  ThemeController.init();
  ActivityChart.init();
  EntriesView.render();
  initStatusClock();
  SplashScreen.init();
})();
