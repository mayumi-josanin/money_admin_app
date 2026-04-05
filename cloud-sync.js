(function () {
  const CONFIG = Object.assign({
    enabled: false,
    url: "",
    anonKey: "",
    redirectUrl: ""
  }, window.SUPABASE_SYNC_CONFIG || {});

  const META_PREFIX = "cloudSyncMeta::";
  const AUTO_SYNC_INTERVAL_MS = 15000;
  const BACKGROUND_SYNC_DEBOUNCE_MS = 900;
  const instances = new Map();
  let authSubscriptionBound = false;

  function nowIso() {
    return new Date().toISOString();
  }

  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
      console.error("クラウド同期メタデータの読み込みに失敗しました。", error);
      return fallback;
    }
  }

  function writeJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function getMetaKey(appKey) {
    return `${META_PREFIX}${appKey}`;
  }

  function readMeta(appKey) {
    return Object.assign({
      localUpdatedAt: "",
      lastSyncedAt: "",
      lastRemoteAt: "",
      dirty: false
    }, readJson(getMetaKey(appKey), {}));
  }

  function writeMeta(appKey, patch) {
    const nextValue = Object.assign({}, readMeta(appKey), patch);
    writeJson(getMetaKey(appKey), nextValue);
    return nextValue;
  }

  function isConfigured() {
    return Boolean(CONFIG.enabled && CONFIG.url && CONFIG.anonKey);
  }

  function getClient() {
    if (!isConfigured()) {
      return null;
    }

    if (!window.__moneyManagerSupabaseClient) {
      if (!window.supabase || typeof window.supabase.createClient !== "function") {
        return null;
      }

      window.__moneyManagerSupabaseClient = window.supabase.createClient(CONFIG.url, CONFIG.anonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true
        }
      });
    }

    return window.__moneyManagerSupabaseClient;
  }

  function hasContent(value) {
    if (Array.isArray(value)) {
      return value.length > 0;
    }

    if (value && typeof value === "object") {
      return Object.keys(value).length > 0;
    }

    return value !== null && value !== undefined && String(value).trim() !== "";
  }

  function formatDateTime(value) {
    if (!value) {
      return "未同期";
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return "未同期";
    }

    return new Intl.DateTimeFormat("ja-JP", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    }).format(date);
  }

  function buildRedirectUrl() {
    return CONFIG.redirectUrl || window.location.href.split("#")[0];
  }

  class SyncController {
    constructor(options) {
      this.appKey = options.appKey;
      this.storageKeys = options.storageKeys;
      this.container = options.container;
      this.title = options.title;
      this.description = options.description;
      this.onRemoteApplied = options.onRemoteApplied;
      this.client = null;
      this.session = null;
      this.user = null;
      this.uploadTimer = null;
      this.syncInterval = null;
      this.elements = {};
    }

    async init() {
      if (!this.container) {
        return;
      }

      this.renderShell();

      if (!isConfigured()) {
        this.setStatus("Supabase が未設定です。`supabase-config.js` に URL と anon key を入れると同期できます。", "muted");
        return;
      }

      this.client = getClient();
      if (!this.client) {
        this.setStatus("Supabase クライアントを読み込めませんでした。", "error");
        return;
      }

      this.bindEvents();
      this.bindAuthSubscription();
      await this.refreshSession();
    }

    renderShell() {
      this.container.innerHTML = `
        <section class="cloud-sync-card">
          <div>
            <h3>${escapeHtml(this.title)}</h3>
            <p class="cloud-sync-copy">${escapeHtml(this.description)}</p>
          </div>
          <div id="${this.appKey}-cloud-sync-status" class="cloud-sync-status" data-tone="muted">同期の準備中です。</div>
          <div id="${this.appKey}-cloud-sync-guest" class="cloud-sync-row">
            <label>
              同期に使うメールアドレス
              <input id="${this.appKey}-cloud-sync-email" type="email" placeholder="例: you@example.com" autocomplete="email">
            </label>
            <div class="cloud-sync-actions">
              <button type="button" id="${this.appKey}-cloud-sync-login" class="primary">ログインリンクを送る</button>
            </div>
          </div>
          <div id="${this.appKey}-cloud-sync-user" hidden>
            <div class="cloud-sync-user">
              <strong id="${this.appKey}-cloud-sync-user-email"></strong>
              <button type="button" id="${this.appKey}-cloud-sync-logout" class="secondary">ログアウト</button>
            </div>
            <div class="cloud-sync-actions" style="margin-top: 12px;">
              <button type="button" id="${this.appKey}-cloud-sync-sync" class="primary">今すぐ同期</button>
              <button type="button" id="${this.appKey}-cloud-sync-pull" class="secondary">クラウドから読み込む</button>
            </div>
            <div id="${this.appKey}-cloud-sync-meta" class="cloud-sync-meta" style="margin-top: 12px;"></div>
          </div>
        </section>
      `;

      this.elements.status = document.getElementById(`${this.appKey}-cloud-sync-status`);
      this.elements.guest = document.getElementById(`${this.appKey}-cloud-sync-guest`);
      this.elements.email = document.getElementById(`${this.appKey}-cloud-sync-email`);
      this.elements.login = document.getElementById(`${this.appKey}-cloud-sync-login`);
      this.elements.userPanel = document.getElementById(`${this.appKey}-cloud-sync-user`);
      this.elements.userEmail = document.getElementById(`${this.appKey}-cloud-sync-user-email`);
      this.elements.logout = document.getElementById(`${this.appKey}-cloud-sync-logout`);
      this.elements.sync = document.getElementById(`${this.appKey}-cloud-sync-sync`);
      this.elements.pull = document.getElementById(`${this.appKey}-cloud-sync-pull`);
      this.elements.meta = document.getElementById(`${this.appKey}-cloud-sync-meta`);
    }

    bindEvents() {
      this.elements.login.addEventListener("click", () => this.sendMagicLink());
      this.elements.logout.addEventListener("click", () => this.signOut());
      this.elements.sync.addEventListener("click", () => this.syncNow("manual"));
      this.elements.pull.addEventListener("click", () => this.pullRemote());

      window.addEventListener("cloud-sync-local-change", (event) => {
        if (event.detail && event.detail.appKey === this.appKey) {
          this.handleLocalMutation();
        }
      });

      window.addEventListener("focus", () => {
        if (this.user) {
          this.syncNow("refresh");
        }
      });

      window.addEventListener("online", () => {
        if (this.user) {
          this.syncNow("online");
        }
      });

      window.addEventListener("pagehide", () => {
        if (this.user) {
          this.flushPendingSync();
        }
      });

      document.addEventListener("visibilitychange", () => {
        if (!this.user) {
          return;
        }

        if (document.hidden) {
          this.flushPendingSync();
        } else {
          this.syncNow("refresh");
        }
      });
    }

    bindAuthSubscription() {
      if (authSubscriptionBound) {
        return;
      }

      authSubscriptionBound = true;
      this.client.auth.onAuthStateChange((_event, session) => {
        instances.forEach((controller) => {
          controller.handleSessionChange(session);
        });
      });
    }

    async refreshSession() {
      const { data, error } = await this.client.auth.getSession();
      if (error) {
        console.error(error);
        this.setStatus("ログイン状態の確認に失敗しました。", "error");
        return;
      }

      this.handleSessionChange(data.session);
    }

    async sendMagicLink() {
      const email = this.elements.email.value.trim();
      if (!email) {
        this.setStatus("メールアドレスを入力してください。", "error");
        return;
      }

      this.setBusy(true);
      this.setStatus("ログイン用メールを送信しています。", "muted");

      const { error } = await this.client.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: buildRedirectUrl()
        }
      });

      this.setBusy(false);

      if (error) {
        console.error(error);
        this.setStatus(error.message || "ログインリンクの送信に失敗しました。", "error");
        return;
      }

      this.setStatus("メールにログインリンクを送りました。届いたリンクを開いてください。", "success");
    }

    async signOut() {
      this.setBusy(true);
      const { error } = await this.client.auth.signOut();
      this.setBusy(false);

      if (error) {
        console.error(error);
        this.setStatus(error.message || "ログアウトに失敗しました。", "error");
        return;
      }

      this.handleSessionChange(null);
      this.setStatus("ログアウトしました。", "muted");
    }

    handleSessionChange(session) {
      this.session = session;
      this.user = session ? session.user : null;
      this.elements.guest.hidden = Boolean(this.user);
      this.elements.userPanel.hidden = !this.user;

      if (this.user) {
        this.elements.userEmail.textContent = `ログイン中: ${this.user.email || "不明"}`;
        this.renderMeta();
        this.startAutoSyncLoop();
        this.syncNow("startup");
      } else {
        this.stopAutoSyncLoop();
        this.elements.userEmail.textContent = "";
        this.elements.meta.innerHTML = "";
      }
    }

    startAutoSyncLoop() {
      this.stopAutoSyncLoop();
      this.syncInterval = window.setInterval(() => {
        if (!this.user || document.hidden || !navigator.onLine) {
          return;
        }

        this.syncNow("refresh");
      }, AUTO_SYNC_INTERVAL_MS);
    }

    stopAutoSyncLoop() {
      if (this.syncInterval) {
        window.clearInterval(this.syncInterval);
        this.syncInterval = null;
      }
    }

    flushPendingSync() {
      const meta = readMeta(this.appKey);
      if (meta.dirty) {
        this.syncNow("background");
      }
    }

    readLocalSnapshot() {
      const payload = {
        version: 1,
        appKey: this.appKey,
        data: {}
      };
      let hasData = false;

      this.storageKeys.forEach((key) => {
        const raw = localStorage.getItem(key);
        if (raw === null) {
          payload.data[key] = null;
          return;
        }

        try {
          payload.data[key] = JSON.parse(raw);
        } catch (_error) {
          payload.data[key] = raw;
        }

        if (hasContent(payload.data[key])) {
          hasData = true;
        }
      });

      return { payload, hasData };
    }

    async fetchRemoteSnapshot() {
      const { data, error } = await this.client
        .from("app_snapshots")
        .select("payload, updated_at")
        .eq("app_key", this.appKey)
        .limit(1);

      if (error) {
        throw error;
      }

      return Array.isArray(data) && data.length > 0 ? data[0] : null;
    }

    async pushSnapshot(message, quiet = false) {
      if (!this.user) {
        if (!quiet) {
          this.setStatus("同期するにはログインしてください。", "error");
        }
        return;
      }

      const local = this.readLocalSnapshot();
      const updatedAt = nowIso();
      const payload = Object.assign({}, local.payload, {
        savedAt: updatedAt
      });

      const { error } = await this.client
        .from("app_snapshots")
        .upsert({
          user_id: this.user.id,
          app_key: this.appKey,
          payload,
          updated_at: updatedAt
        }, {
          onConflict: "user_id,app_key"
        });

      if (error) {
        throw error;
      }

      writeMeta(this.appKey, {
        localUpdatedAt: updatedAt,
        lastSyncedAt: updatedAt,
        lastRemoteAt: updatedAt,
        dirty: false
      });
      this.renderMeta();
      if (message) {
        this.setStatus(message, "success");
      } else if (!quiet) {
        this.setStatus("クラウドへ同期しました。", "success");
      }
    }

    applyRemoteSnapshot(remoteSnapshot, message) {
      const payload = remoteSnapshot && remoteSnapshot.payload ? remoteSnapshot.payload : {};
      const source = payload.data || {};

      this.storageKeys.forEach((key) => {
        if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== null && source[key] !== undefined) {
          localStorage.setItem(key, JSON.stringify(source[key]));
        } else {
          localStorage.removeItem(key);
        }
      });

      const updatedAt = remoteSnapshot.updated_at || nowIso();
      writeMeta(this.appKey, {
        localUpdatedAt: updatedAt,
        lastSyncedAt: updatedAt,
        lastRemoteAt: updatedAt,
        dirty: false
      });
      this.renderMeta();
      if (message) {
        this.setStatus(message, "success");
      }

      if (typeof this.onRemoteApplied === "function") {
        this.onRemoteApplied(remoteSnapshot);
      }
    }

    async syncNow(mode) {
      const quiet = ["startup", "refresh", "background", "online"].includes(mode);
      if (!this.user) {
        if (!quiet) {
          this.setStatus("同期するにはログインしてください。", "error");
        }
        return;
      }

      if (this.isSyncing) {
        return;
      }

      this.isSyncing = true;
      if (!quiet) {
        this.setBusy(true);
      }

      try {
        const remote = await this.fetchRemoteSnapshot();
        const local = this.readLocalSnapshot();
        const meta = readMeta(this.appKey);
        const remoteTime = remote ? Date.parse(remote.updated_at || "") : 0;
        const localTime = meta.localUpdatedAt ? Date.parse(meta.localUpdatedAt) : 0;

        if (!remote) {
          if (local.hasData) {
            await this.pushSnapshot(quiet ? "" : "クラウドへ初回同期しました。", quiet);
          } else {
            if (!quiet) {
              this.setStatus("まだ同期するローカルデータがありません。", "muted");
            }
          }
          return;
        }

        if (mode === "pull") {
          this.applyRemoteSnapshot(remote, "クラウドの内容を読み込みました。再表示します。");
          return;
        }

        if (!local.hasData) {
          this.applyRemoteSnapshot(remote, "クラウドの内容を読み込みました。再表示します。");
          return;
        }

        if (!localTime) {
          this.applyRemoteSnapshot(remote, "クラウドの内容を優先して読み込みました。再表示します。");
          return;
        }

        if (remoteTime > localTime + 1000) {
          this.applyRemoteSnapshot(remote, "他の端末の変更を読み込みました。再表示します。");
          return;
        }

        if (localTime > remoteTime + 1000 || meta.dirty || mode === "manual") {
          await this.pushSnapshot(mode === "manual" ? "クラウドへ同期しました。" : "", quiet);
          return;
        }

        writeMeta(this.appKey, {
          lastSyncedAt: remote.updated_at,
          lastRemoteAt: remote.updated_at,
          dirty: false
        });
        this.renderMeta();
        if (!quiet) {
          this.setStatus("同期済みです。", "success");
        }
      } catch (error) {
        console.error(error);
        this.setStatus(error.message || "クラウド同期に失敗しました。", "error");
      } finally {
        this.isSyncing = false;
        if (!quiet) {
          this.setBusy(false);
        }
      }
    }

    async pullRemote() {
      if (!this.user) {
        this.setStatus("同期するにはログインしてください。", "error");
        return;
      }

      this.setStatus("クラウドの内容を確認しています。", "muted");
      await this.syncNow("pull");
    }

    handleLocalMutation() {
      this.renderMeta();
      if (!this.user) {
        this.setStatus("ローカルに保存しました。ログインするとクラウド同期できます。", "muted");
        return;
      }

      window.clearTimeout(this.uploadTimer);
      this.uploadTimer = window.setTimeout(() => {
        this.syncNow("background");
      }, BACKGROUND_SYNC_DEBOUNCE_MS);
    }

    renderMeta() {
      const meta = readMeta(this.appKey);
      this.elements.meta.innerHTML = `
        <span>ローカル最終更新: ${escapeHtml(formatDateTime(meta.localUpdatedAt))}</span>
        <span>クラウド最終同期: ${escapeHtml(formatDateTime(meta.lastSyncedAt))}</span>
      `;
    }

    setBusy(isBusy) {
      [
        this.elements.login,
        this.elements.logout,
        this.elements.sync,
        this.elements.pull
      ].forEach((element) => {
        if (element) {
          element.disabled = isBusy;
        }
      });
    }

    setStatus(message, tone) {
      this.elements.status.textContent = message;
      this.elements.status.dataset.tone = tone || "muted";
    }
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  window.MoneyCloudSync = {
    initPanel(options) {
      const controller = new SyncController(options);
      instances.set(options.appKey, controller);
      return controller.init();
    },
    markLocalChange(appKey) {
      writeMeta(appKey, {
        localUpdatedAt: nowIso(),
        dirty: true
      });
      window.dispatchEvent(new CustomEvent("cloud-sync-local-change", {
        detail: { appKey }
      }));
    }
  };
})();
