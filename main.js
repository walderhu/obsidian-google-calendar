const { ItemView, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting } = require("obsidian");

const VIEW_TYPE = "weekly-google-calendar";
const HOUR_HEIGHT = 36;

const DEFAULT_SETTINGS = {
  apiKey: "",
  calendarId: "primary",
  clientId: "",
  clientSecret: "",
  redirectUri: "",
  accessToken: "",
  refreshToken: "",
  tokenExpiresAt: 0,
  startHour: 7,
  endHour: 23
};

module.exports = class WeeklyGoogleCalendarPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.events = [];
    if (!this.settings.clientId || !this.settings.clientSecret) {
      try {
        await this.loadClientSecretFile();
      } catch (err) {
        console.warn("Weekly Google Calendar: client_secret auto-load failed", err);
      }
    }

    this.registerView(VIEW_TYPE, leaf => new WeeklyCalendarView(leaf, this));
    this.registerMarkdownCodeBlockProcessor("weekly-google-calendar", async (source, el) => {
      if (source.trim().toLowerCase() === "full") await this.renderFullCalendar(el);
      else await this.renderMiniCalendar(el);
    });
    this.registerMarkdownCodeBlockProcessor("weekly-google-calendar-full", async (_source, el) => {
      await this.renderFullCalendar(el);
    });
    this.addRibbonIcon("calendar-days", "Weekly Google Calendar", () => this.activateView());
    this.addCommand({ id: "open-weekly-google-calendar", name: "Open weekly calendar", callback: () => this.activateView() });
    this.addCommand({
      id: "insert-weekly-google-calendar",
      name: "Insert calendar embed",
      checkCallback: checking => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return false;
        if (checking) return true;
        const editor = view.editor;
        editor.replaceSelection("```weekly-google-calendar-full\n```\n");
        return true;
      }
    });
    this.addSettingTab(new WeeklyCalendarSettingsTab(this.app, this));
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async loadClientSecretFile() {
    const dir = `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    const listed = await this.app.vault.adapter.list(dir);
    const file = listed.files.find(path => /client_secret.*\.json$/i.test(path));
    if (!file) throw new Error("client_secret*.json not found in plugin folder.");

    const json = JSON.parse(await this.app.vault.adapter.read(file));
    const config = json.installed || json.web;
    if (!config?.client_id || !config?.client_secret) throw new Error("Invalid Google client secret file.");

    this.settings.clientId = config.client_id;
    this.settings.clientSecret = config.client_secret;
    this.settings.redirectUri = (config.redirect_uris || [])[0] || "http://localhost";
    await this.saveSettings();
  }

  getAuthUrl() {
    if (!this.settings.clientId || !this.settings.redirectUri) {
      throw new Error("Load client_secret file first.");
    }

    const params = new URLSearchParams({
      client_id: this.settings.clientId,
      redirect_uri: this.settings.redirectUri,
      response_type: "code",
      scope: "https://www.googleapis.com/auth/calendar.events",
      access_type: "offline",
      prompt: "consent"
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }

  async exchangeCode(code) {
    if (!this.settings.clientId || !this.settings.clientSecret || !this.settings.redirectUri) {
      throw new Error("Load client_secret file first.");
    }

    const data = await this.postToken({
      code,
      client_id: this.settings.clientId,
      client_secret: this.settings.clientSecret,
      redirect_uri: this.settings.redirectUri,
      grant_type: "authorization_code"
    });

    this.settings.accessToken = data.access_token || "";
    this.settings.refreshToken = data.refresh_token || this.settings.refreshToken;
    this.settings.tokenExpiresAt = Date.now() + ((data.expires_in || 3600) - 60) * 1000;
    await this.saveSettings();
  }

  async getAccessToken() {
    if (this.settings.accessToken && Date.now() < this.settings.tokenExpiresAt) {
      return this.settings.accessToken;
    }
    if (!this.settings.refreshToken) return this.settings.accessToken;

    const data = await this.postToken({
      client_id: this.settings.clientId,
      client_secret: this.settings.clientSecret,
      refresh_token: this.settings.refreshToken,
      grant_type: "refresh_token"
    });

    this.settings.accessToken = data.access_token || "";
    this.settings.tokenExpiresAt = Date.now() + ((data.expires_in || 3600) - 60) * 1000;
    await this.saveSettings();
    return this.settings.accessToken;
  }

  async postToken(body) {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body)
    });
    if (!res.ok) throw new Error(await res.text());
    return await res.json();
  }

  async activateView() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    const leaf = leaves[0] || this.app.workspace.getRightLeaf(false);
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  async loadGoogleEvents(weekStart) {
    const accessToken = await this.getAccessToken();
    if (!this.settings.apiKey && !accessToken) {
      throw new Error("Google Calendar is not authorized yet. Click Auth in the calendar toolbar or authorize it in plugin settings.");
    }

    const timeMin = new Date(weekStart);
    const timeMax = new Date(weekStart);
    timeMax.setDate(timeMax.getDate() + 7);

    const params = new URLSearchParams({
      singleEvents: "true",
      orderBy: "startTime",
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString()
    });
    if (this.settings.apiKey) params.set("key", this.settings.apiKey);

    const calendarId = encodeURIComponent(this.settings.calendarId || "primary");
    const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?${params}`, {
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {}
    });

    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    this.events = (data.items || []).map(item => ({
      id: item.id,
      title: item.summary || "(No title)",
      start: new Date(item.start.dateTime || item.start.date),
      end: new Date(item.end.dateTime || item.end.date),
      allDay: Boolean(item.start.date),
      htmlLink: item.htmlLink
    }));
    return this.events;
  }

  async createGoogleEvent(title, start, end) {
    return await this.createGoogleEventPayload({
      summary: title,
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() }
    });
  }

  async createGoogleEventPayload(payload) {
    const accessToken = await this.getAccessToken();
    if (!accessToken) throw new Error("Google authorization is required to create events.");

    const calendarId = encodeURIComponent(this.settings.calendarId || "primary");
    const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) throw new Error(await res.text());
    return await res.json();
  }

  async deleteGoogleEvent(eventId) {
    const accessToken = await this.getAccessToken();
    if (!accessToken) throw new Error("Google authorization is required to delete events.");
    if (!eventId) throw new Error("Event id is missing.");

    const calendarId = encodeURIComponent(this.settings.calendarId || "primary");
    const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(eventId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (!res.ok) throw new Error(await res.text());
  }

  async renderMiniCalendar(el) {
    el.empty();
    el.addClass("wgc-mini");
    const weekStart = getWeekStart(new Date());
    el.createDiv("wgc-mini-title").setText(formatRange(weekStart));

    try {
      await this.loadGoogleEvents(weekStart);
    } catch (err) {
      el.createDiv("wgc-mini-error").setText(`Calendar sync failed: ${err.message}`);
      return;
    }

    const grid = el.createDiv("wgc-mini-grid");
    for (let day = 0; day < 7; day++) {
      const dayStart = addDays(weekStart, day);
      const dayEnd = addDays(dayStart, 1);
      const col = grid.createDiv("wgc-mini-day");
      col.createDiv("wgc-mini-head").setText(formatDay(dayStart));

      const dayEvents = this.events.filter(event => intersects(event, dayStart, dayEnd));
      if (!dayEvents.length) {
        col.createDiv("wgc-mini-empty").setText("—");
        continue;
      }

      for (const event of dayEvents) {
        const item = col.createDiv("wgc-mini-event");
        item.setText(event.allDay ? event.title : `${formatTime(event.start)} ${event.title}`);
        item.title = event.allDay ? event.title : `${event.title}\n${formatTime(event.start)}-${formatTime(event.end)}`;
        item.onclick = () => new EventDetailsModal(this.app, this, event, null).open();
        item.ondblclick = ev => {
          ev.stopPropagation();
          new EventModal(this.app, async payload => {
            try {
              await this.createGoogleEventPayload(payload);
              new Notice("Event created in Google Calendar.");
            } catch (err) {
              new Notice(`Create failed: ${err.message}`);
            }
          }, event.start, event.end).open();
        };
      }
    }
  }

  async renderFullCalendar(el) {
    let weekStart = getWeekStart(new Date());

    const render = async () => {
      el.empty();
      el.addClass("wgc-root");
      el.addClass("wgc-embed-root");

      const toolbar = el.createDiv("wgc-toolbar");
      toolbar.createEl("button", { text: "‹" }, btn => btn.onclick = async () => {
        weekStart = addDays(weekStart, -7);
        await render();
      });
      toolbar.createEl("button", { text: "Today" }, btn => btn.onclick = async () => {
        weekStart = getWeekStart(new Date());
        await render();
      });
      toolbar.createEl("button", { text: "›" }, btn => btn.onclick = async () => {
        weekStart = addDays(weekStart, 7);
        await render();
      });
      toolbar.createEl("strong", { text: formatRange(weekStart) });
      toolbar.createEl("button", { text: "Sync" }, btn => btn.onclick = render);

      try {
        await this.loadGoogleEvents(weekStart);
      } catch (err) {
        el.createDiv("wgc-mini-error").setText(`Calendar sync failed: ${err.message}`);
        return;
      }

      const grid = el.createDiv("wgc-grid");
      grid.createDiv("wgc-corner");
      for (let day = 0; day < 7; day++) {
        grid.createDiv("wgc-day-head").setText(formatDay(addDays(weekStart, day)));
      }

      grid.createDiv("wgc-all-day-label").setText("All day");
      for (let day = 0; day < 7; day++) {
        const dayStart = addDays(weekStart, day);
        const dayEnd = addDays(dayStart, 1);
        const cell = grid.createDiv("wgc-all-day-cell");
        for (const [index, event] of this.events.filter(e => e.allDay && intersects(e, dayStart, dayEnd)).entries()) {
          const item = cell.createDiv("wgc-all-day-event");
          item.addClass(`wgc-color-${index % 6}`);
          item.createSpan("wgc-all-day-icon").setText("□");
          item.createSpan("wgc-all-day-title").setText(event.title);
          item.title = event.title;
          item.onclick = () => new EventDetailsModal(this.app, this, event, render).open();
          item.ondblclick = ev => {
            ev.stopPropagation();
            new EventModal(this.app, async payload => {
              try {
                await this.createGoogleEventPayload(payload);
                new Notice("Event created in Google Calendar.");
                await render();
              } catch (err) {
                new Notice(`Create failed: ${err.message}`);
              }
            }, event.start, event.end).open();
          };
        }
      }

      const { startHour, endHour } = getVisibleHours(this.settings, this.events);
      for (let hour = startHour; hour < endHour; hour++) {
        grid.createDiv("wgc-hour").setText(`${String(hour).padStart(2, "0")}:00`);
        for (let day = 0; day < 7; day++) {
          const slotStart = addHours(addDays(weekStart, day), hour);
          const slotEnd = addHours(slotStart, 1);
          const cell = grid.createDiv("wgc-cell");
          cell.dataset.day = String(day);
          cell.dataset.hour = String(hour);
          cell.ondblclick = () => new EventModal(this.app, async payload => {
            try {
              await this.createGoogleEventPayload(payload);
              new Notice("Event created in Google Calendar.");
              await render();
            } catch (err) {
              new Notice(`Create failed: ${err.message}`);
            }
          }, slotStart, slotEnd).open();
        }
      }

      attachDragToCreate(grid, weekStart, startHour, endHour, (start, end) => {
        new EventModal(this.app, async payload => {
          try {
            await this.createGoogleEventPayload(payload);
            new Notice("Event created in Google Calendar.");
            await render();
          } catch (err) {
            new Notice(`Create failed: ${err.message}`);
          }
        }, start, end).open();
      });
      resizeAllDayRow(grid, () => renderTimedEvents(this, grid, this.events, weekStart, startHour, endHour, render));
    };

    await render();
  }
};

class WeeklyCalendarView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.weekStart = getWeekStart(new Date());
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "Weekly Calendar";
  }

  getIcon() {
    return "calendar-days";
  }

  async onOpen() {
    this.render();
    await this.refresh();
  }

  async refresh() {
    try {
      await this.plugin.loadGoogleEvents(this.weekStart);
      this.render();
    } catch (err) {
      new Notice(`Calendar sync failed: ${err.message}`);
    }
  }

  render() {
    const root = this.containerEl.children[1];
    root.empty();
    root.addClass("wgc-root");

    const toolbar = root.createDiv("wgc-toolbar");
    toolbar.createEl("button", { text: "‹" }, btn => btn.onclick = () => this.shiftWeek(-7));
    toolbar.createEl("button", { text: "Today" }, btn => btn.onclick = () => {
      this.weekStart = getWeekStart(new Date());
      this.refresh();
    });
    toolbar.createEl("button", { text: "›" }, btn => btn.onclick = () => this.shiftWeek(7));
    toolbar.createEl("strong", { text: formatRange(this.weekStart) });
    if (!this.plugin.settings.accessToken && !this.plugin.settings.refreshToken) {
      toolbar.createEl("button", { text: "Auth" }, btn => btn.onclick = () => this.openAuth());
    }
    toolbar.createEl("button", { text: "Sync" }, btn => btn.onclick = () => this.refresh());

    const grid = root.createDiv("wgc-grid");
    grid.createDiv("wgc-corner");
    for (let day = 0; day < 7; day++) {
      grid.createDiv("wgc-day-head").setText(formatDay(addDays(this.weekStart, day)));
    }
    grid.createDiv("wgc-all-day-label").setText("All day");
    for (let day = 0; day < 7; day++) {
      const dayStart = addDays(this.weekStart, day);
      const dayEnd = addDays(dayStart, 1);
      const cell = grid.createDiv("wgc-all-day-cell");
      for (const [index, event] of this.plugin.events.filter(e => e.allDay && intersects(e, dayStart, dayEnd)).entries()) {
        const item = cell.createDiv("wgc-all-day-event");
        item.addClass(`wgc-color-${index % 6}`);
        item.createSpan("wgc-all-day-icon").setText("□");
        item.createSpan("wgc-all-day-title").setText(event.title);
        item.title = event.title;
        item.onclick = () => new EventDetailsModal(this.app, this.plugin, event, () => this.refresh()).open();
        item.ondblclick = ev => {
          ev.stopPropagation();
          this.promptEvent(event.start, event.end);
        };
      }
    }

    const { startHour, endHour } = this.getVisibleHours();
    for (let hour = startHour; hour < endHour; hour++) {
      grid.createDiv("wgc-hour").setText(`${String(hour).padStart(2, "0")}:00`);
      for (let day = 0; day < 7; day++) {
        const slotStart = addHours(addDays(this.weekStart, day), hour);
        const slotEnd = addHours(slotStart, 1);
        const cell = grid.createDiv("wgc-cell");
        cell.dataset.day = String(day);
        cell.dataset.hour = String(hour);
        cell.ondblclick = () => this.promptEvent(slotStart, slotEnd);
      }
    }

    attachDragToCreate(grid, this.weekStart, startHour, endHour, (start, end) => this.promptEvent(start, end));
    this.resizeAllDayRow(grid, () => this.renderEvents(grid));
  }

  resizeAllDayRow(grid, onDone) {
    resizeAllDayRow(grid, onDone);
  }

  renderEvents(grid) {
    const { startHour, endHour } = this.getVisibleHours();
    renderTimedEvents(this.plugin, grid, this.plugin.events, this.weekStart, startHour, endHour, () => this.refresh());
  }

  getVisibleHours() {
    return getVisibleHours(this.plugin.settings, this.plugin.events);
  }

  async shiftWeek(days) {
    this.weekStart = addDays(this.weekStart, days);
    await this.refresh();
  }

  openAuth() {
    try {
      window.open(this.plugin.getAuthUrl());
      new Notice("Allow access in Google, then paste the code in plugin settings.");
    } catch (err) {
      new Notice(`Auth failed: ${err.message}`);
    }
  }

  promptEvent(start, end) {
    new EventModal(this.app, async payload => {
      try {
        await this.plugin.createGoogleEventPayload(payload);
        new Notice("Event created in Google Calendar.");
        await this.refresh();
      } catch (err) {
        new Notice(`Create failed: ${err.message}`);
      }
    }, start, end).open();
  }
}

class EventModal extends Modal {
  constructor(app, onSubmit, start, end) {
    super(app);
    this.onSubmit = onSubmit;
    this.start = start;
    this.end = end;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "New event" });
    const payload = {
      summary: "",
      description: "",
      start: { dateTime: this.start.toISOString() },
      end: { dateTime: this.end.toISOString() }
    };

    new Setting(contentEl).setName("Title").addText(text => {
      text.inputEl.focus();
      text.onChange(value => payload.summary = value);
    });

    new Setting(contentEl).setName("Description").addTextArea(text => text.onChange(value => {
      payload.description = value;
    }));

    new Setting(contentEl).setName("Start").addText(text => {
      text.inputEl.type = "datetime-local";
      text.setValue(toLocalDateTimeInput(this.start));
      text.onChange(value => {
        payload.start = { dateTime: new Date(value).toISOString() };
      });
    });

    new Setting(contentEl).setName("End").addText(text => {
      text.inputEl.type = "datetime-local";
      text.setValue(toLocalDateTimeInput(this.end));
      text.onChange(value => {
        payload.end = { dateTime: new Date(value).toISOString() };
      });
    });

    new Setting(contentEl)
      .addButton(button => button
        .setButtonText("Create")
        .setCta()
        .onClick(() => {
          try {
            if (!payload.summary?.trim()) throw new Error("title is required.");
            this.close();
            this.onSubmit(payload);
          } catch (err) {
            new Notice(`Create failed: ${err.message}`);
          }
        }))
      .addButton(button => button
        .setButtonText("Cancel")
        .onClick(() => this.close()));
  }
}

class EventDetailsModal extends Modal {
  constructor(app, plugin, event, onRefresh) {
    super(app);
    this.plugin = plugin;
    this.event = event;
    this.onRefresh = onRefresh;
    this.confirmDelete = false;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.event.title });
    const meta = this.event.allDay
      ? "All day"
      : `${formatTime(this.event.start)} - ${formatTime(this.event.end)}`;
    contentEl.createDiv("wgc-event-detail-time").setText(meta);
    const details = contentEl.createDiv("wgc-event-details");
    details.createDiv().setText(`Start: ${this.event.allDay ? toDateOnly(this.event.start) : this.event.start.toLocaleString()}`);
    details.createDiv().setText(`End: ${this.event.allDay ? toDateOnly(this.event.end) : this.event.end.toLocaleString()}`);
    details.createDiv().setText(`ID: ${this.event.id}`);
    new Setting(contentEl)
      .addButton(button => button
        .setButtonText("Add overlapping event")
        .onClick(() => {
          this.close();
          new EventModal(this.app, async payload => {
            try {
              await this.plugin.createGoogleEventPayload(payload);
              new Notice("Event created in Google Calendar.");
              if (this.onRefresh) await this.onRefresh();
            } catch (err) {
              new Notice(`Create failed: ${err.message}`);
            }
          }, this.event.start, this.event.end).open();
        }))
      .addButton(button => button
        .setButtonText(this.confirmDelete ? "Confirm delete" : "Delete")
        .setWarning()
        .onClick(async () => {
          if (!this.confirmDelete) {
            this.confirmDelete = true;
            this.onOpen();
            return;
          }
          try {
            await this.plugin.deleteGoogleEvent(this.event.id);
            new Notice("Event deleted from Google Calendar.");
            this.close();
            if (this.onRefresh) await this.onRefresh();
          } catch (err) {
            new Notice(`Delete failed: ${err.message}`);
          }
        }))
      .addButton(button => button
        .setButtonText("Close")
        .setCta()
        .onClick(() => this.close()));
  }
}

class CodeModal extends Modal {
  constructor(app, onSubmit) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Google authorization" });
    new Setting(contentEl).setName("Code or redirect URL").addText(text => {
      text.inputEl.focus();
      text.inputEl.onkeydown = ev => {
        if (ev.key === "Enter") {
          this.close();
          this.onSubmit(text.getValue());
        }
      };
    });
    new Setting(contentEl).addButton(button => button
      .setButtonText("Authorize")
      .setCta()
      .onClick(() => {
        const input = contentEl.querySelector("input");
        this.close();
        this.onSubmit(input.value);
      }));
  }
}

class WeeklyCalendarSettingsTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("Google API key").setDesc("For reading events. Public calendars can use only this.").addText(text => text
      .setPlaceholder("AIza...")
      .setValue(this.plugin.settings.apiKey)
      .onChange(async value => {
        this.plugin.settings.apiKey = value.trim();
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl).setName("Calendar ID").setDesc("Use primary or a calendar email/id.").addText(text => text
      .setValue(this.plugin.settings.calendarId)
      .onChange(async value => {
        this.plugin.settings.calendarId = value.trim() || "primary";
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName("Google OAuth client")
      .setDesc(this.plugin.settings.clientId ? "Loaded from client_secret file." : "Put client_secret*.json in this plugin folder.")
      .addButton(button => button
        .setButtonText("Load secret")
        .onClick(async () => {
          try {
            await this.plugin.loadClientSecretFile();
            new Notice("Google OAuth client loaded.");
            this.display();
          } catch (err) {
            new Notice(`Load failed: ${err.message}`);
          }
        }));

    new Setting(containerEl)
      .setName("Authorize Google Calendar")
      .setDesc(this.plugin.settings.refreshToken ? "Authorized." : "Open Google, allow access, then paste the returned code.")
      .addButton(button => button
        .setButtonText("Open auth")
        .onClick(() => {
          try {
            window.open(this.plugin.getAuthUrl());
          } catch (err) {
            new Notice(`Auth failed: ${err.message}`);
          }
        }))
      .addButton(button => button
        .setButtonText("Paste code")
        .onClick(() => new CodeModal(this.app, async input => {
          try {
            await this.plugin.exchangeCode(extractAuthCode(input));
            new Notice("Google Calendar authorized.");
            this.display();
          } catch (err) {
            new Notice(`Token failed: ${err.message}`);
          }
        }).open()));

    new Setting(containerEl).setName("OAuth access token").setDesc("Optional manual token. Auto-filled after authorization.").addText(text => text
      .setPlaceholder("ya29...")
      .setValue(maskValue(this.plugin.settings.accessToken))
      .onChange(async value => {
        if (!value.includes("•••")) this.plugin.settings.accessToken = value.trim();
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl).setName("Start hour").addText(text => text
      .setValue(String(this.plugin.settings.startHour))
      .onChange(async value => {
        this.plugin.settings.startHour = clampHour(value, 0);
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl).setName("End hour").addText(text => text
      .setValue(String(this.plugin.settings.endHour))
      .onChange(async value => {
        this.plugin.settings.endHour = clampHour(value, 24);
        await this.plugin.saveSettings();
      }));
  }
}

function getWeekStart(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day);
  return d;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function addHours(date, hours) {
  const d = new Date(date);
  d.setHours(d.getHours() + hours);
  return d;
}

function toLocalDateTimeInput(date) {
  const d = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}

function toDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function intersects(event, start, end) {
  return event.start < end && event.end > start;
}

function getVisibleHours(settings, events) {
  let startHour = settings.startHour;
  let endHour = settings.endHour;
  for (const event of events) {
    if (event.allDay) continue;
    startHour = Math.min(startHour, event.start.getHours());
    endHour = Math.max(endHour, event.end.getHours() + (event.end.getMinutes() > 0 ? 1 : 0));
  }
  return {
    startHour: Math.max(0, Math.min(23, startHour)),
    endHour: Math.max(1, Math.min(24, endHour))
  };
}

function resizeAllDayRow(grid, onDone) {
  requestAnimationFrame(() => {
    const items = Array.from(grid.querySelectorAll(".wgc-all-day-label, .wgc-all-day-cell"));
    if (!items.length) {
      if (onDone) onDone();
      return;
    }
    for (const item of items) item.style.height = "auto";
    const height = Math.max(...items.map(item => item.scrollHeight), 34);
    for (const item of items) item.style.height = `${height}px`;
    if (onDone) onDone();
  });
}

function renderTimedEvents(plugin, grid, events, weekStart, startHour, endHour, onRefresh) {
  const layer = grid.createDiv("wgc-timed-layer");

  requestAnimationFrame(() => {
    const firstCell = grid.querySelector(".wgc-cell");
    const firstCellRect = firstCell?.getBoundingClientRect();
    if (!firstCellRect) return;

    layer.style.gridColumn = "2 / span 7";
    layer.style.gridRow = "3 / span 1";
    layer.style.left = "0";
    layer.style.top = "0";
    layer.style.width = "100%";
    layer.style.height = `${(endHour - startHour) * HOUR_HEIGHT}px`;
    layer.empty();

    for (let day = 0; day < 7; day++) {
      const dayStart = addHours(addDays(weekStart, day), startHour);
      const dayEnd = addHours(addDays(weekStart, day), endHour);
      const dayEvents = events.filter(event => !event.allDay && intersects(event, dayStart, dayEnd));

      for (const event of dayEvents) {
        const start = new Date(Math.max(event.start.getTime(), dayStart.getTime()));
        const end = new Date(Math.min(event.end.getTime(), dayEnd.getTime()));
        const offsetMinutes = (start - dayStart) / 60000;
        const durationMinutes = Math.max(15, (end - start) / 60000);
        const item = layer.createDiv("wgc-event");
        item.createDiv("wgc-event-title").setText(event.title);
        item.createDiv("wgc-event-time").setText(`${formatTime(event.start)} - ${formatTime(event.end)}`);
        item.title = `${event.title}\n${formatTime(event.start)}-${formatTime(event.end)}`;
        item.style.left = `calc(${(day / 7) * 100}% + 4px)`;
        item.style.top = `${(offsetMinutes / 60) * HOUR_HEIGHT + 2}px`;
        item.style.width = "calc(14.285714% - 8px)";
        item.style.height = `${Math.max(22, (durationMinutes / 60) * HOUR_HEIGHT - 4)}px`;
        item.onclick = () => new EventDetailsModal(plugin.app, plugin, event, onRefresh).open();
        item.ondblclick = ev => {
          ev.stopPropagation();
          new EventModal(plugin.app, async payload => {
            try {
              await plugin.createGoogleEventPayload(payload);
              new Notice("Event created in Google Calendar.");
              if (onRefresh) await onRefresh();
            } catch (err) {
              new Notice(`Create failed: ${err.message}`);
            }
          }, event.start, event.end).open();
        };
      }
    }
  });
}

function attachDragToCreate(grid, weekStart, startHour, endHour, onCreate) {
  let drag = null;

  const getCell = target => target.closest?.(".wgc-cell");
  const getSlot = cell => {
    if (!cell?.dataset) return null;
    const day = Number.parseInt(cell.dataset.day, 10);
    const hour = Number.parseInt(cell.dataset.hour, 10);
    if (Number.isNaN(day) || Number.isNaN(hour)) return null;
    return { day, hour };
  };

  const renderPreview = slot => {
    if (!drag?.preview || !slot || slot.day !== drag.day) return;
    const from = Math.min(drag.startHour, slot.hour);
    const to = Math.max(drag.startHour, slot.hour) + 1;
    const first = grid.querySelector(`.wgc-cell[data-day="${drag.day}"][data-hour="${from}"]`);
    const last = grid.querySelector(`.wgc-cell[data-day="${drag.day}"][data-hour="${to - 1}"]`);
    if (!first || !last) return;
    const gridRect = grid.getBoundingClientRect();
    const firstRect = first.getBoundingClientRect();
    const lastRect = last.getBoundingClientRect();
    drag.preview.style.left = `${firstRect.left - gridRect.left + 4}px`;
    drag.preview.style.top = `${firstRect.top - gridRect.top + 2}px`;
    drag.preview.style.width = `${firstRect.width - 8}px`;
    drag.preview.style.height = `${lastRect.bottom - firstRect.top - 4}px`;
  };

  grid.addEventListener("pointerdown", ev => {
    if (ev.button !== 0) return;
    const cell = getCell(ev.target);
    const slot = getSlot(cell);
    if (!slot) return;
    drag = {
      day: slot.day,
      startHour: slot.hour,
      currentHour: slot.hour,
      startedAt: { x: ev.clientX, y: ev.clientY },
      preview: grid.createDiv("wgc-selection")
    };
    cell.setPointerCapture?.(ev.pointerId);
    renderPreview(slot);
  });

  grid.addEventListener("pointermove", ev => {
    if (!drag) return;
    const cell = getCell(document.elementFromPoint(ev.clientX, ev.clientY));
    const slot = getSlot(cell);
    if (!slot || slot.day !== drag.day) return;
    drag.currentHour = Math.max(startHour, Math.min(endHour - 1, slot.hour));
    renderPreview(slot);
  });

  grid.addEventListener("pointerup", ev => {
    if (!drag) return;
    const moved = Math.abs(ev.clientX - drag.startedAt.x) + Math.abs(ev.clientY - drag.startedAt.y);
    const fromHour = Math.min(drag.startHour, drag.currentHour);
    const toHour = Math.max(drag.startHour, drag.currentHour) + 1;
    const preview = drag.preview;
    const day = drag.day;
    drag = null;
    preview.remove();
    if (moved < 6 && fromHour === toHour - 1) return;
    onCreate(addHours(addDays(weekStart, day), fromHour), addHours(addDays(weekStart, day), toHour));
  });

  grid.addEventListener("pointercancel", () => {
    if (!drag) return;
    drag.preview.remove();
    drag = null;
  });
}

function formatDay(date) {
  return date.toLocaleDateString(undefined, { weekday: "short", day: "2-digit" });
}

function formatTime(date) {
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function formatRange(start) {
  const end = addDays(start, 6);
  return `${start.toLocaleDateString()} - ${end.toLocaleDateString()}`;
}

function clampHour(value, fallback) {
  const hour = Number.parseInt(value, 10);
  if (Number.isNaN(hour)) return fallback;
  return Math.max(0, Math.min(24, hour));
}

function maskValue(value) {
  if (!value) return "";
  if (value.length <= 10) return "••••";
  return `${value.slice(0, 6)}•••${value.slice(-4)}`;
}

function extractAuthCode(input) {
  const value = input.trim();
  if (!value) throw new Error("Authorization code is empty.");
  if (!/^https?:\/\//i.test(value)) return value;
  const url = new URL(value);
  const code = url.searchParams.get("code");
  if (!code) throw new Error("No code parameter found in URL.");
  return code;
}
