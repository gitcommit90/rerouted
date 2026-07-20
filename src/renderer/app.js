"use strict";

const api = window.rerouted;
const dashboardRuntime = document.documentElement.classList.contains("dashboard-runtime");
const { accountDisplayName, accountIdentityLabel } = window.ReroutedAccountIdentity;
const { compactNumber: fmtNum } = window.ReroutedNumberFormat;
const { createLatestRequestGate, guardSensitiveRender } = window.ReroutedRendererLockState;
const { buildEnabledProviderGroups, buildProviderCatalog, canonicalProviderType } =
  window.ReroutedProviderCatalog;
const {
  buildRouteProviderOptions,
  modelsForRouteProvider,
  routeMemberForProvider,
  normalizeRouteMember,
  moveRouteMember,
} = window.ReroutedRoutePicker;
const { oauthPrompt } = window.ReroutedOAuthPrompt;
const $ = (sel, el = document) => el.querySelector(sel);
const view = $("#view");
const nav = $("#nav");
const toastEl = $("#toast");
const closeButton = $("#btn-close");
if (!dashboardRuntime) closeButton.hidden = false;

let state = null;
let page = "home";
let toastTimer = null;
let armDelete = null;
let activeProviderPanel = null;
const stateRequestGate = createLatestRequestGate();
const onboardingDraft = {
  adminPassword: "",
  adminPasswordConfirm: "",
  keyedPresetId: null,
  keyedFields: {},
  firstCombo: {
    name: "coding",
    strategy: "fallback",
    members: new Set(),
  },
};

const PROVIDER_KEY_URLS = {
  openrouter: "https://openrouter.ai/workspaces/default/keys",
  nvidia: "https://build.nvidia.com/settings/api-keys",
};

function reducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

function revealPanel(panel, focusSelector = "[data-panel-heading]") {
  requestAnimationFrame(() => {
    if (!panel?.isConnected) return;
    const focusTarget = panel.querySelector(focusSelector) || panel;
    focusTarget.focus({ preventScroll: true });
    panel.scrollIntoView({
      behavior: reducedMotion() ? "auto" : "smooth",
      block: "start",
    });
  });
}

function disposeProviderPanel({ restoreFocus = false, clear = true } = {}) {
  const current = activeProviderPanel;
  if (!current) return;
  activeProviderPanel = null;
  current.closed = true;
  if (current.onDismiss) Promise.resolve(current.onDismiss()).catch(() => {});
  if (clear && current.mount?.isConnected) current.mount.replaceChildren();
  if (!restoreFocus) return;
  requestAnimationFrame(() => {
    const fallback = document.querySelector(
      "#btn-add-provider, [data-provider-back], [data-provider-key]"
    );
    const target = current.opener?.isConnected ? current.opener : fallback;
    target?.focus({ preventScroll: true });
  });
}

function activateProviderPanel({ mount, panel, opener, focusSelector, onDismiss }) {
  const session = { mount, panel, opener, onDismiss, closed: false };
  activeProviderPanel = session;
  revealPanel(panel, focusSelector);
  return session;
}

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !activeProviderPanel) return;
  event.preventDefault();
  disposeProviderPanel({ restoreFocus: true });
});

function toast(msg) {
  toastEl.hidden = false;
  toastEl.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, 2200);
}

async function refresh() {
  const isLatest = stateRequestGate.begin();
  const nextState = await api.invoke("app:get-state");
  if (isLatest()) state = nextState;
  return state;
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied");
  } catch {
    toast("Copy failed");
  }
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const PROVIDER_LABELS = {
  chatgpt: "ChatGPT",
  codex: "ChatGPT",
  claude: "Claude",
  antigravity: "Antigravity",
  xai: "xAI",
  openrouter: "OpenRouter",
  nvidia: "NVIDIA NIM",
  cloudflare: "Cloudflare",
  glm: "GLM Coding",
  "openai-compat": "API key",
  custom: "Custom",
};

const PROVIDER_PRESENTATION = {
  chatgpt: {
    description: "OpenAI subscription accounts",
    logo: "chatgpt.svg",
  },
  claude: {
    description: "Anthropic subscription accounts",
    logo: "claude.svg",
  },
  antigravity: {
    description: "Google Gemini subscription accounts",
    logo: "antigravity.svg",
  },
  xai: {
    description: "Grok subscription accounts",
    logo: "xai.svg",
  },
  openrouter: {
    description: "OpenRouter API keys",
    logo: "openrouter.svg",
  },
  nvidia: {
    description: "NVIDIA NIM API keys",
    logo: "nvidia.svg",
  },
  cloudflare: {
    description: "Cloudflare Workers AI keys",
    logo: "cloudflare.svg",
  },
  glm: {
    description: "Z.AI coding API keys",
    logo: "glm.svg",
  },
  custom: {
    description: "OpenAI-compatible endpoints",
    logo: "custom.svg",
  },
};

function providerLabel(type) {
  return PROVIDER_LABELS[type] || String(type || "Provider");
}

function providerPresentation(provider) {
  const key = PROVIDER_PRESENTATION[provider?.id]
    ? provider.id
    : canonicalProviderType(provider?.type);
  return (
    PROVIDER_PRESENTATION[key] || {
      description: "Connected provider accounts",
      logo: "custom.svg",
    }
  );
}

function providerLogoHtml(provider, className = "provider-logo") {
  const presentation = providerPresentation(provider);
  return `<span class="${esc(className)} provider-logo-shell provider-logo-${esc(
    provider.id
  )}" aria-hidden="true"><img src="assets/providers/${esc(
    presentation.logo
  )}" alt="" /></span>`;
}

function aliasLabel(alias) {
  const match = /^oauth(\d+)$/.exec(String(alias || ""));
  return match ? `Account ${match[1]}` : alias || "";
}

function pageHeader(eyebrow, title, copy, action = "") {
  return `<div class="page-header">
    <div class="page-header-copy">
      <div class="eyebrow">${esc(eyebrow)}</div>
      <h1 class="h1">${esc(title)}</h1>
      ${copy ? `<p class="lead">${esc(copy)}</p>` : ""}
    </div>
    ${action ? `<div class="page-header-actions">${action}</div>` : ""}
  </div>`;
}

function sectionHeader(title, meta = "") {
  return `<div class="section-header"><div class="section-title">${esc(title)}</div>${
    meta ? `<div class="section-meta">${esc(meta)}</div>` : ""
  }</div>`;
}

function accountSubnav(active) {
  return `<div class="seg page-subnav">
    <button type="button" data-account-view="providers" class="${active === "providers" ? "active" : ""}">Accounts</button>
    <button type="button" data-account-view="quota" class="${active === "quota" ? "active" : ""}">Quota</button>
  </div>`;
}

function activitySubnav(active) {
  return `<div class="seg page-subnav">
    <button type="button" data-activity-view="stats" class="${active === "stats" ? "active" : ""}">Usage</button>
    <button type="button" data-activity-view="logs" class="${active === "logs" ? "active" : ""}">Logs</button>
  </div>`;
}

function wireSubnav() {
  view.querySelectorAll("[data-account-view]").forEach((button) => {
    button.onclick = () => {
      page = button.dataset.accountView;
      if (page === "providers") {
        selectedProviderKey = null;
        expandedAccountId = null;
      }
      render();
    };
  });
  view.querySelectorAll("[data-activity-view]").forEach((button) => {
    button.onclick = () => {
      page = button.dataset.activityView;
      render();
    };
  });
}

function comboRouteId(combo) {
  return String(combo?.name || "Untitled route");
}

function friendlyRoute(model) {
  const combo = (state?.combos || []).find(
    (item) => item.id === model || item.name === model || item.storageId === model
  );
  return combo ? comboRouteId(combo) : String(model || "Unknown route");
}

function updateChrome() {
  const online = !!(state?.serverListening && state?.serverEnabled);
  const status = $("#chrome-status");
  const text = $("#chrome-status-text");
  if (!status || !text) return;
  status.classList.toggle("off", !online);
  text.textContent = online ? `Local ${state.port}` : "Gateway off";
}

/** Mask secret for display: keep prefix + last 4 */
function maskSecret(key) {
  const s = String(key || "");
  if (s.length <= 10) return "••••••••";
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

/**
 * Render a secret row with Show / Copy. Uses data-secret on the container.
 */
function secretHtml(key, id) {
  const sid = id || `sec-${Math.random().toString(36).slice(2, 8)}`;
  return `<div class="secret-field" data-secret-id="${esc(sid)}" data-secret="${esc(key)}" data-shown="0">
    <code class="secret-val">${esc(maskSecret(key))}</code>
    <button type="button" class="btn btn-secondary btn-sm secret-toggle" data-sid="${esc(sid)}">Show</button>
    <button type="button" class="btn btn-secondary btn-sm secret-copy" data-sid="${esc(sid)}">Copy</button>
  </div>`;
}

function wireSecrets(root = view) {
  root.querySelectorAll(".secret-toggle").forEach((btn) => {
    btn.onclick = () => {
      const box = root.querySelector(`[data-secret-id="${btn.dataset.sid}"]`);
      if (!box) return;
      const shown = box.dataset.shown === "1";
      const code = box.querySelector(".secret-val");
      if (shown) {
        code.textContent = maskSecret(box.dataset.secret);
        box.dataset.shown = "0";
        btn.textContent = "Show";
      } else {
        code.textContent = box.dataset.secret;
        box.dataset.shown = "1";
        btn.textContent = "Hide";
      }
    };
  });
  root.querySelectorAll(".secret-copy").forEach((btn) => {
    btn.onclick = () => {
      const box = root.querySelector(`[data-secret-id="${btn.dataset.sid}"]`);
      if (box) copy(box.dataset.secret);
    };
  });
}

const OAUTH_RISK_NOTICE =
  "Notice: This provider's subscription or OAuth session is not officially licensed for proxy or router use. Using it this way may result in account restrictions or bans. Proceed at your own risk.";

function oauthRiskNotice() {
  return `<div class="risk-note">${esc(OAUTH_RISK_NOTICE)}</div>`;
}

function stepProgress(step) {
  const steps = state.steps || [];
  const idx = Math.max(0, steps.indexOf(step));
  const dots = steps
    .slice(0, -1)
    .map((_, i) => `<div class="step-dot ${i <= idx ? "on" : ""}"></div>`)
    .join("");
  return `<div class="steps">${dots}</div>`;
}

function onboardingBackButton() {
  return '<button type="button" class="btn btn-secondary" data-onboarding-back>Back</button>';
}

function wireOnboardingBack({ tutorial = false } = {}) {
  const button = view.querySelector("[data-onboarding-back]");
  if (!button) return;
  button.onclick = () => {
    const steps = (state.steps || []).filter((step) => step !== "done");
    const current = state.onboardingStep || "permissions";
    const index = steps.indexOf(current);
    if (index <= 0) return;
    if (tutorial) tutorialPage = TUTORIAL.length - 1;
    goStep(steps[index - 1]);
  };
}

// ─── Onboarding screens ───────────────────────────────────────────────

function renderPermissions() {
  view.innerHTML = `
    ${stepProgress("permissions")}
    <h1 class="h1">${dashboardRuntime ? "Headless runtime" : "Permissions"}</h1>
    <p class="lead">${
      dashboardRuntime
        ? "ReRouted serves its local API and this dashboard from one headless process. Keep that process running so your tools can always reach the endpoint."
        : "ReRouted runs in your menu bar and serves a local API on this Mac only. Enable open at login so the endpoint is ready when you need it. Importing local credentials may prompt for macOS Keychain access."
    }</p>
    ${
      dashboardRuntime
        ? ""
        : `<div class="card">
      <div class="toggle-row">
        <div>
          <div class="card-title">Open at Login</div>
          <div class="card-sub">Launch ReRouted when you sign in</div>
        </div>
        <label class="toggle"><input type="checkbox" id="tog-login" ${state.openAtLogin ? "checked" : ""} /><span></span></label>
      </div>
    </div>`
    }
    <div class="btn-row">
      <button type="button" class="btn btn-primary" id="btn-next">Continue</button>
    </div>
  `;
  if ($("#tog-login")) {
    $("#tog-login").onchange = async (e) => {
      await api.invoke("app:set-open-at-login", e.target.checked);
      await refresh();
    };
  }
  $("#btn-next").onclick = () => goStep("admin-password");
}

function renderAdminPassword() {
  view.innerHTML = `
    ${stepProgress("admin-password")}
    <h1 class="h1">Create admin password</h1>
    <p class="lead">${
      dashboardRuntime
        ? "This password protects dashboard access to your providers, routes, gateway keys, and activity. It is stored locally as a scrypt hash — never sent anywhere else."
        : "Your active macOS login unlocks ReRouted. This password is the fallback when the app cannot confirm that session. It is stored as a scrypt hash — never sent anywhere."
    }</p>
    <input class="input" id="pw1" type="password" placeholder="Password" autocomplete="new-password" value="${esc(onboardingDraft.adminPassword)}" />
    <input class="input" id="pw2" type="password" placeholder="Confirm password" autocomplete="new-password" value="${esc(onboardingDraft.adminPasswordConfirm)}" />
    <div class="btn-row">
      ${onboardingBackButton()}
      <button type="button" class="btn btn-primary" id="btn-next">Continue</button>
    </div>
  `;
  wireOnboardingBack();
  $("#pw1").oninput = (event) => {
    onboardingDraft.adminPassword = event.target.value;
  };
  $("#pw2").oninput = (event) => {
    onboardingDraft.adminPasswordConfirm = event.target.value;
  };
  $("#btn-next").onclick = async () => {
    const a = $("#pw1").value;
    const b = $("#pw2").value;
    if (a !== b) return toast("Passwords do not match");
    const r = await api.invoke("app:set-admin-password", a);
    if (!r.ok) return toast(r.error || "Failed");
    goStep("welcome");
  };
}

function renderWelcome() {
  view.innerHTML = `
    ${stepProgress("welcome")}
    <div class="eyebrow">Your local wayfinder</div>
    <h1 class="h1">Your models.<br />One clean route.</h1>
    <p class="lead">Connect subscriptions and API keys once. ReRouted presents a single local endpoint and moves traffic when an account runs out.</p>
    <section class="hero-surface">
      <div class="gateway-state"><span class="status-node"></span>Runs on this ${dashboardRuntime ? "machine" : "Mac"}</div>
      <div class="route-map" aria-hidden="true"><span class="route-source">C</span><span class="route-track"></span><span class="route-source">G</span><span class="route-track"></span><span class="route-destination">/v1</span></div>
      <div class="hero-sub">Claude · ChatGPT · Gemini · Grok · API keys</div>
    </section>
    <div class="btn-row">
      ${onboardingBackButton()}
      <button type="button" class="btn btn-primary" id="btn-next">Continue</button>
    </div>
  `;
  wireOnboardingBack();
  $("#btn-next").onclick = () => goStep("oauth-providers");
}

function renderOauthProviders() {
  const done = new Set((state.providers || []).map((p) => p.type));
  const list = state.oauthProviders || [];
  view.innerHTML = `
    ${stepProgress("oauth-providers")}
    <h1 class="h1">Connect OAuth providers</h1>
    <p class="lead">Click a provider to sign in with your browser. Multiple accounts per provider are supported — connect again to add another.</p>
    ${oauthRiskNotice()}
    <div class="provider-grid">
      ${list
        .map(
          (p) =>
            `<button type="button" class="tile ${done.has(p.id) || done.has(p.id === "chatgpt" ? "codex" : "") ? "done" : ""}" data-type="${esc(p.id)}">${esc(p.name)}</button>`
        )
        .join("")}
    </div>
    <div id="oauth-panel"></div>
    <div class="btn-row">
      ${onboardingBackButton()}
      <button type="button" class="btn btn-primary" id="btn-next">Continue</button>
    </div>
  `;
  view.querySelectorAll(".tile").forEach((btn) => {
    btn.onclick = async () => {
      const type = btn.dataset.type;
      const prompt = oauthPrompt(type);
      const panel = $("#oauth-panel");
      panel.innerHTML = `<div class="card"><div class="card-title">Signing in to ${esc(providerLabel(type))}…</div>
        <div class="card-sub">${esc(prompt.instruction)}</div>
        ${oauthRiskNotice()}
        <div class="btn-row" style="margin-top:10px">
          <button type="button" class="btn btn-secondary btn-sm" id="btn-reopen">Restart sign-in</button>
          <button type="button" class="btn btn-primary btn-sm" id="btn-done">Finish connection</button>
        </div>
        <div class="oauth-paste-entry"><label class="label" for="paste-code">${esc(prompt.fieldLabel)}</label>
        <input class="input" id="paste-code" placeholder="${esc(prompt.placeholder)}" autocomplete="off" /></div>
      </div>`;
      await api.invoke("app:oauth-start", type);
      $("#btn-reopen").onclick = () => api.invoke("app:oauth-start", type);
      $("#btn-done").onclick = async () => {
        try {
          const paste = $("#paste-code").value.trim() || undefined;
          const r = await api.invoke("app:oauth-complete", { type, pasteCode: paste });
          if (r?.ok) {
            toast(`Connected ${r.account.name}`);
            await refresh();
            renderOauthProviders();
          } else {
            toast(r?.error || "OAuth failed — open Logs");
          }
        } catch (e) {
          toast(e.message || "OAuth failed");
        }
      };
    };
  });
  wireOnboardingBack();
  $("#btn-next").onclick = () => goStep("api-keys");
}

function keyedProviderPickerHtml(presets, { includeCustom = true } = {}) {
  return `<div class="provider-grid" data-keyed-preset-grid>
    ${presets
      .map(
        (preset) =>
          `<button type="button" class="tile" data-keyed-preset="${esc(preset.id)}" aria-pressed="false">${esc(preset.name)}</button>`
      )
      .join("")}
    ${
      includeCustom
        ? '<button type="button" class="tile" data-keyed-preset="custom" aria-pressed="false">Custom</button>'
        : ""
    }
  </div>
  <div data-keyed-form></div>`;
}

function bindKeyedProviderPicker(
  root,
  {
    onAdded,
    successMessage = "Provider added",
    initialPresetId = null,
    draft = null,
  } = {}
) {
  const presets = state.keyedPresets || [];
  const pickerButtons = [...root.querySelectorAll("[data-keyed-preset]")];
  pickerButtons.forEach((button) => {
    button.onclick = () => {
      const presetId = button.dataset.keyedPreset;
      const isCustom = presetId === "custom";
      const preset = presets.find((item) => item.id === presetId);
      if (!isCustom && !preset) return;

      root.querySelectorAll("[data-keyed-preset]").forEach((item) => {
        const selected = item === button;
        item.classList.toggle("selected", selected);
        item.setAttribute("aria-pressed", selected ? "true" : "false");
      });

      const form = $("[data-keyed-form]", root);
      if (draft) draft.presetId = presetId;
      const savedFields = draft?.fields?.[presetId] || {};
      const getKeyUrl = PROVIDER_KEY_URLS[presetId];
      form.innerHTML = `
        <div class="card">
          <div class="label">${esc(isCustom ? "Custom provider" : preset.name)}</div>
          ${
            isCustom
              ? `<input class="input" data-keyed-field="name" placeholder="Name" value="${esc(savedFields.name || "")}" />
                <input class="input" data-keyed-field="base" placeholder="Base URL (https://…/v1)" value="${esc(savedFields.base || "")}" />
                <input class="input" data-keyed-field="model" placeholder="Exact model ID (if /models is unavailable)" value="${esc(savedFields.model || "")}" />
                <div class="card-sub">Optional. Tests chat directly without /models.</div>`
              : ""
          }
          ${
            preset?.needsAccountId
              ? `<input class="input" data-keyed-field="account" placeholder="Cloudflare Account ID" value="${esc(savedFields.account || "")}" />`
              : ""
          }
          <div class="key-entry-row">
            <input class="input" data-keyed-field="key" type="password" placeholder="API key" value="${esc(savedFields.key || "")}" />
            ${getKeyUrl ? `<button type="button" class="btn btn-secondary btn-sm" data-get-key="${esc(getKeyUrl)}">Get key</button>` : ""}
          </div>
          <div class="btn-row">
            <button type="button" class="btn btn-secondary btn-sm" data-keyed-action="test">Fetch models / Test</button>
            <button type="button" class="btn btn-primary btn-sm" data-keyed-action="add" disabled>Add</button>
          </div>
          <div class="model-test-status" data-keyed-status hidden></div>
          <button type="button" class="btn btn-secondary btn-sm" data-keyed-copy-error hidden>Copy full error</button>
        </div>`;
      requestAnimationFrame(() => {
        if (!form.isConnected) return;
        const firstField = form.querySelector("[data-keyed-field]");
        firstField?.focus({ preventScroll: true });
        form.scrollIntoView({
          behavior: reducedMotion() ? "auto" : "smooth",
          block: "nearest",
        });
      });

      const field = (name) => $(`[data-keyed-field="${name}"]`, form);
      const testButton = $("[data-keyed-action='test']", form);
      const addButton = $("[data-keyed-action='add']", form);
      const status = $("[data-keyed-status]", form);
      const copyError = $("[data-keyed-copy-error]", form);
      form.querySelector("[data-get-key]")?.addEventListener("click", (event) => {
        api.invoke("app:open-external", event.currentTarget.dataset.getKey);
      });
      const accountId = () => field("account")?.value?.trim() || "";
      const baseUrl = () =>
        isCustom
          ? field("base").value.trim()
          : (preset.baseUrl || "").replace("{account_id}", accountId());
      const inputs = [...form.querySelectorAll("[data-keyed-field]")];
      const fingerprint = () =>
        JSON.stringify([
          presetId,
          baseUrl(),
          field("key").value.trim(),
          accountId(),
          field("model")?.value?.trim() || "",
        ]);
      let models = null;
      let testedFingerprint = null;
      let testGeneration = 0;
      let adding = false;

      const invalidateTest = () => {
        testGeneration += 1;
        models = null;
        testedFingerprint = null;
        addButton.disabled = true;
        copyError.hidden = true;
        if (!status.hidden) {
          status.classList.remove("error", "ok");
          status.textContent = "Changes need to be tested again.";
        }
      };
      inputs.forEach((input) =>
        input.addEventListener("input", () => {
          if (draft) {
            draft.fields[presetId] = Object.fromEntries(
              inputs.map((field) => [field.dataset.keyedField, field.value])
            );
          }
          invalidateTest();
        })
      );

      testButton.onclick = async () => {
        const generation = ++testGeneration;
        const testedValues = fingerprint();
        status.hidden = false;
        status.classList.remove("error", "ok");
        status.textContent = "Testing…";
        copyError.hidden = true;
        testButton.disabled = true;
        addButton.disabled = true;
        models = null;
        testedFingerprint = null;
        let result;
        try {
          result = await api.invoke("app:test-keyed-provider", {
            providerType: isCustom ? "openai-compat" : presetId,
            baseUrl: baseUrl(),
            apiKey: field("key").value.trim(),
            modelId: field("model")?.value?.trim() || "",
          });
        } catch (error) {
          result = { ok: false, error: error.message || "Test failed" };
        }
        testButton.disabled = false;
        if (generation !== testGeneration || testedValues !== fingerprint()) return;
        if (!result.ok) {
          status.textContent = result.error || "Failed";
          status.classList.add("error");
          copyError.hidden = false;
          copyError.onclick = () => copy(result.error || "Failed");
          return;
        }
        models = result.models || [];
        testedFingerprint = testedValues;
        status.textContent =
          result.validation === "chat-completions"
            ? `OK — ${models[0]?.id || "model"} validated`
            : `OK — ${models.length} models`;
        status.classList.add("ok");
        addButton.disabled = false;
      };

      addButton.onclick = async () => {
        if (adding) return;
        if (!models || testedFingerprint !== fingerprint()) {
          invalidateTest();
          return toast("Test the current settings first");
        }
        adding = true;
        addButton.disabled = true;
        testButton.disabled = true;
        inputs.forEach((input) => {
          input.disabled = true;
        });
        let result;
        try {
          result = await api.invoke("app:add-keyed-provider", {
            preset: isCustom ? null : presetId,
            name: isCustom ? field("name").value.trim() : preset.name,
            baseUrl: baseUrl(),
            apiKey: field("key").value.trim(),
            accountId: accountId(),
            models: models.map((model) =>
              typeof model === "string"
                ? { id: model, name: model, enabled: true }
                : { ...model, enabled: true }
            ),
          });
        } catch (error) {
          result = { ok: false, error: error.message || "Could not add provider" };
        }
        if (!result?.ok) {
          adding = false;
          addButton.disabled = false;
          testButton.disabled = false;
          inputs.forEach((input) => {
            input.disabled = false;
          });
          return toast(result?.error || "Could not add provider");
        }
        models = null;
        testedFingerprint = null;
        toast(successMessage);
        await refresh();
        if (onAdded) await onAdded();
      };
    };
  });
  if (initialPresetId) {
    pickerButtons.find((button) => button.dataset.keyedPreset === initialPresetId)?.click();
  }
}

function renderApiKeys() {
  const presets = state.keyedPresets || [];
  view.innerHTML = `
    ${stepProgress("api-keys")}
    <h1 class="h1">Add an API key</h1>
    <p class="lead">Optional. Quick-add a known chat-completions provider, or enter a custom base URL. Discover its models or validate one exact model ID before Add.</p>
    ${keyedProviderPickerHtml(presets)}
    <div class="btn-row">
      ${onboardingBackButton()}
      <button type="button" class="btn btn-secondary" id="btn-skip">Skip</button>
      <button type="button" class="btn btn-primary" id="btn-next">Continue</button>
    </div>
  `;
  $("#btn-skip").onclick = () => goStep("endpoint-ready");
  $("#btn-next").onclick = () => goStep("endpoint-ready");
  wireOnboardingBack();
  bindKeyedProviderPicker(view, {
    initialPresetId: onboardingDraft.keyedPresetId,
    draft: {
      get presetId() {
        return onboardingDraft.keyedPresetId;
      },
      set presetId(value) {
        onboardingDraft.keyedPresetId = value;
      },
      fields: onboardingDraft.keyedFields,
    },
  });
}

function renderEndpointReady() {
  view.innerHTML = `
    ${stepProgress("endpoint-ready")}
    <h1 class="h1">Your endpoint is ready</h1>
    <p class="lead">Point a tool that supports OpenAI-style chat completions at this URL and key. You can view them again anytime from Home.</p>
    <div class="label">Base URL</div>
    <div class="copy-field"><code id="ep-url">${esc(state.endpoint)}</code>
      <button type="button" class="btn btn-secondary btn-sm" id="copy-url">Copy</button></div>
    <div class="label">API key</div>
    ${secretHtml(state.apiKey, "onboard-key")}
    <div class="btn-row">
      ${onboardingBackButton()}
      <button type="button" class="btn btn-primary" id="btn-next">I've saved this</button>
    </div>
  `;
  $("#copy-url").onclick = () => copy(state.endpoint);
  wireSecrets();
  wireOnboardingBack();
  $("#btn-next").onclick = () => goStep("tutorial");
}

let tutorialPage = 0;
const TUTORIAL = [
  {
    t: "What is ReRouted?",
    b: "A local gateway. Your editors and agents send OpenAI-style chat completions to localhost; ReRouted talks to ChatGPT, Claude, Antigravity, xAI, and supported keyed APIs behind the scenes.",
  },
  {
    t: "What are routes?",
    b: "A route is one memorable model ID backed by real models. Rotate requests or fill through members in order when an account reaches its limit.",
  },
  {
    t: "How to navigate",
    b: "Status shows your endpoint and traffic. Accounts manage subscriptions and keys. Routes define failover. Activity explains where requests went.",
  },
];

function renderTutorial() {
  const pageT = TUTORIAL[tutorialPage] || TUTORIAL[0];
  view.innerHTML = `
    ${stepProgress("tutorial")}
    <h1 class="h1">${esc(pageT.t)}</h1>
    <p class="lead">${esc(pageT.b)}</p>
    <div class="footer-note">${tutorialPage + 1} / ${TUTORIAL.length}</div>
    <div class="btn-row">
      <button type="button" class="btn btn-secondary" id="btn-back">Back</button>
      <button type="button" class="btn btn-primary" id="btn-next">${tutorialPage < TUTORIAL.length - 1 ? "Next" : "Continue"}</button>
    </div>
  `;
  $("#btn-back").onclick = () => {
    if (tutorialPage > 0) {
      tutorialPage--;
      renderTutorial();
    } else {
      goStep("endpoint-ready");
    }
  };
  $("#btn-next").onclick = () => {
    if (tutorialPage < TUTORIAL.length - 1) {
      tutorialPage++;
      renderTutorial();
    } else goStep("first-combo");
  };
}

function renderFirstCombo() {
  const providers = buildRouteProviderOptions(state.providers || []);
  const draft = onboardingDraft.firstCombo;
  view.innerHTML = `
    ${stepProgress("first-combo")}
    <div class="eyebrow">First route</div>
    <h1 class="h1">Name the model your tools will use</h1>
    <p class="lead">Optional. This exact model ID appears in <span class="mono">/v1/models</span>; its members stay behind the scenes.</p>
    <input class="input" id="c-name" placeholder="Model ID (for example, coding)" value="${esc(draft.name)}" />
    <div class="seg" id="c-strat">
      <button type="button" data-s="fallback" class="${draft.strategy === "fallback" ? "active" : ""}">Fallback</button>
      <button type="button" data-s="round-robin" class="${draft.strategy === "round-robin" ? "active" : ""}">Round-robin</button>
    </div>
    <div class="label">Members</div>
    <div class="member-pick">
      ${
        providers.length
          ? providers
              .flatMap((provider) =>
                provider.models.map((model) => {
                  const member = routeMemberForProvider(provider, model.upstreamModel);
                  const accountNote = provider.connectionScoped
                    ? "This connection"
                    : provider.accountCount > 1
                      ? `${provider.accountCount} accounts · tries each before the next member`
                      : "1 connected account";
                  return `<label class="check-item"><input type="checkbox" data-provider-type="${esc(member.providerType || "")}" data-provider-id="${esc(member.providerId || "")}" data-model="${esc(member.model)}" ${draft.members.has(memberKey(member)) ? "checked" : ""} /><div><div class="card-title ellip">${esc(provider.name)} · ${esc(model.name || model.upstreamModel)}</div><div class="card-sub mono">${esc(model.upstreamModel)} · ${esc(accountNote)}</div></div></label>`;
                })
              )
              .join("")
          : `<div class="empty">No models yet — add a provider first.</div>`
      }
    </div>
    <div class="btn-row">
      ${onboardingBackButton()}
      <button type="button" class="btn btn-secondary" id="btn-skip">Skip</button>
      <button type="button" class="btn btn-primary" id="btn-create">Create route</button>
    </div>
  `;
  $("#c-name").oninput = (event) => {
    draft.name = event.target.value;
  };
  view.querySelectorAll(".member-pick input").forEach((input) => {
    input.onchange = () => {
      const member = input.dataset.providerType
        ? { providerType: input.dataset.providerType, model: input.dataset.model }
        : { providerId: input.dataset.providerId, model: input.dataset.model };
      const key = memberKey(member);
      if (input.checked) draft.members.add(key);
      else draft.members.delete(key);
    };
  });
  view.querySelectorAll("#c-strat button").forEach((b) => {
    b.onclick = () => {
      view.querySelectorAll("#c-strat button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      draft.strategy = b.dataset.s;
    };
  });
  wireOnboardingBack({ tutorial: true });
  $("#btn-skip").onclick = () => finishOnboarding();
  $("#btn-create").onclick = async () => {
    const members = [...view.querySelectorAll(".member-pick input:checked")].map((el) =>
      el.dataset.providerType
        ? { providerType: el.dataset.providerType, model: el.dataset.model }
        : { providerId: el.dataset.providerId, model: el.dataset.model }
    );
    const name = $("#c-name").value.trim();
    if (!name) return toast("Enter a model ID");
    if (!members.length) return toast("Pick at least one model");
    const result = await api.invoke("app:save-combo", {
      name,
      strategy: draft.strategy,
      members,
    });
    if (!result?.ok) return toast(result?.error || "Could not create route");
    finishOnboarding();
  };
}

function flatModels() {
  const out = [];
  for (const p of state.providers || []) {
    if (p.enabled === false) continue;
    for (const m of p.models || []) {
      if (typeof m !== "string" && m.enabled === false) continue;
      const mid = typeof m === "string" ? m : m.id;
      const name = typeof m === "string" ? m : m.name || m.id;
      out.push({
        id: m.gatewayId || `${p.type}/${(p.id || "").slice(-6)}/${mid}`,
        name: `${p.name}${p.accountAlias ? ` · ${aliasLabel(p.accountAlias)}` : ""}: ${name}`,
        providerName: p.name,
        accountAlias: p.accountAlias || null,
        providerType: p.type,
        providerId: p.id,
        upstreamModel: mid,
      });
    }
  }
  return out;
}

async function goStep(step) {
  await api.invoke("app:set-onboarding-step", step);
  await refresh();
  render();
}

async function finishOnboarding() {
  await api.invoke("app:complete-onboarding");
  await refresh();
  page = "home";
  render();
}

// ─── App pages ────────────────────────────────────────────────────────

function renderLock() {
  view.innerHTML = `
    <div class="lock-gate">
      <div class="lock-mark">RR</div>
      <div class="eyebrow">Local control plane</div>
      <h1 class="h1">Unlock ReRouted</h1>
      <p class="lead">${
        dashboardRuntime
          ? "Enter your admin password to manage providers, routes, keys, and activity."
          : "Your Mac session normally unlocks this panel. Enter the admin password if the session state cannot be verified."
      }</p>
      <input class="input" id="lock-pw" type="password" placeholder="Admin password" />
      <button type="button" class="btn btn-primary" id="btn-unlock">Unlock</button>
    </div>
  `;
  const unlock = async () => {
    const r = await api.invoke("app:verify-admin-password", $("#lock-pw").value);
    if (!r.ok) return toast("Incorrect password");
    await refresh();
    render();
  };
  $("#btn-unlock").onclick = unlock;
  $("#lock-pw").onkeydown = (event) => {
    if (event.key === "Enter") unlock();
  };
}

function blockSensitiveRenderIfLocked() {
  return guardSensitiveRender(state, render);
}

function fmtTime(at) {
  if (!at) return "";
  try {
    return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "";
  }
}

function fmtRelativeTime(at) {
  if (!at) return "Never";
  const seconds = Math.max(0, Math.round((Date.now() - Number(at)) / 1000));
  if (seconds < 10) return "Just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function fmtReset(at) {
  if (!at) return "Reset time unavailable";
  const diff = Number(at) - Date.now();
  if (diff <= 0) return "Reset due";
  const minutes = Math.ceil(diff / 60_000);
  if (minutes < 60) return `Resets in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours < 24) return `Resets in ${hours}h${mins ? ` ${mins}m` : ""}`;
  return `Resets in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function tokenMeter(usage) {
  const pin = Number(usage?.prompt_tokens) || 0;
  const pout = Number(usage?.completion_tokens) || 0;
  const pc = Number(usage?.cached_tokens) || 0;
  const sum = pin + pout + pc || 1;
  const w = (n) => Math.max(0, Math.round((n / sum) * 1000) / 10);
  return `
    <div class="meter" title="Input / output / cached token mix">
      <i class="in" style="width:${w(pin)}%"></i>
      <i class="out" style="width:${w(pout)}%"></i>
      <i class="cache" style="width:${w(pc)}%"></i>
    </div>
    <div class="meter-legend">
      <span class="in">In ${fmtNum(pin)}</span>
      <span class="out">Out ${fmtNum(pout)}</span>
      <span class="cache">Cached ${fmtNum(pc)}</span>
    </div>`;
}

function homeRecentHtml(recent) {
  if (!recent.length) {
    return `<div class="empty">No traffic yet. Point a client at the local endpoint to see routing decisions here.</div>`;
  }
  return recent
    .slice(0, 15)
    .map((request) => {
      const via = request.providerName || request.providerType || "";
      const tokens = (request.prompt_tokens || 0) + (request.completion_tokens || 0);
      const tone = Number(request.status) >= 400 ? "error" : "route";
      return `<div class="event-row">
        <span class="event-dot ${tone}"></span>
        <div class="event-main"><div class="event-title">${esc(friendlyRoute(request.model))}</div><div class="event-meta">${esc(via || "Local route")}${tokens ? ` · ${fmtNum(tokens)} tokens` : ""}${request.stream ? " · stream" : ""}</div></div>
        <div class="event-time">${esc(fmtTime(request.at))}</div>
      </div>`;
    })
    .join("");
}

function liveProviders() {
  return buildEnabledProviderGroups(state?.providers || []).map((provider) => ({
    ...provider,
    name: providerLabel(provider.id),
  }));
}

function liveProviderKey(providers) {
  return providers.map((provider) => provider.id).join("|");
}

function liveProviderHtml(providers) {
  if (!providers.length) {
    return `<div class="live-provider-empty">Connect a provider to light up the route map.</div>`;
  }
  return providers
    .map((provider, index) => {
      const presentation = providerPresentation(provider);
      const name = provider.name || providerLabel(provider.id);
      const center = (providers.length - 1) / 2;
      const archY = Math.round(Math.abs(index - center) * 1.8);
      return `<span class="live-provider" data-live-provider-id="${esc(provider.id)}" title="${esc(
        name
      )}" style="--provider-order:${index};--arch-y:${archY}px">
        <img src="assets/providers/${esc(presentation.logo)}" alt="" />
      </span>`;
    })
    .join("");
}

function liveRoutePoint(element, stageRect, edge = "center") {
  const rect = element.getBoundingClientRect();
  return {
    x: rect.left - stageRect.left + rect.width / 2,
    y:
      edge === "top"
        ? rect.top - stageRect.top
        : edge === "bottom"
          ? rect.bottom - stageRect.top
          : rect.top - stageRect.top + rect.height / 2,
  };
}

let liveRequestPathKey = "";

function drawLiveRequestPaths({ force = false } = {}) {
  const stage = view.querySelector("[data-live-router-stage]");
  const layer = stage?.querySelector("[data-live-route-layer]");
  const source = stage?.querySelector("[data-live-request-source]");
  const hub = stage?.querySelector("[data-live-router-hub]");
  if (!stage || !layer || !source || !hub) return;

  const requests = state?.activeRequests || [];
  const stageRect = stage.getBoundingClientRect();
  if (!stageRect.width || !stageRect.height) return;
  const pathKey = `${Math.round(stageRect.width)}x${Math.round(stageRect.height)}|${requests
    .map(
      (request) =>
        `${request.id}:${canonicalProviderType(request.providerType) || "pending"}`
    )
    .join("|")}`;
  if (!force && pathKey === liveRequestPathKey) return;
  liveRequestPathKey = pathKey;
  const sourcePoint = liveRoutePoint(source, stageRect, "top");
  const hubPoint = liveRoutePoint(hub, stageRect);
  const providerNodes = new Map(
    [...stage.querySelectorAll("[data-live-provider-id]")].map((node) => [
      node.dataset.liveProviderId,
      node,
    ])
  );

  layer.setAttribute("viewBox", `0 0 ${stageRect.width} ${stageRect.height}`);
  layer.replaceChildren();
  stage.classList.toggle("has-live-requests", requests.length > 0);
  hub.classList.toggle("is-active", requests.length > 0);
  source.classList.toggle("is-active", requests.length > 0);
  stage.querySelectorAll(".live-provider.is-active").forEach((node) => {
    node.classList.remove("is-active");
  });

  const count = requests.length;
  requests.forEach((request, index) => {
    const spread = (index - (count - 1) / 2) * 3.2;
    const targetNode = providerNodes.get(canonicalProviderType(request.providerType));
    if (targetNode) targetNode.classList.add("is-active");
    const target = targetNode
      ? liveRoutePoint(targetNode, stageRect, "bottom")
      : hubPoint;
    const startX = sourcePoint.x + spread;
    const hubX = hubPoint.x + spread * 0.35;
    let pathData = `M ${startX} ${sourcePoint.y} C ${startX} ${sourcePoint.y - 28}, ${hubX} ${hubPoint.y + 30}, ${hubX} ${hubPoint.y}`;
    if (targetNode) {
      pathData += ` C ${hubX} ${hubPoint.y - 34}, ${target.x + spread * 0.2} ${target.y + 28}, ${target.x + spread * 0.2} ${target.y}`;
    }
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", pathData);
    path.setAttribute("class", "live-request-path");
    path.style.setProperty("--flow-delay", `${-(index % 5) * 0.22}s`);
    layer.append(path);
  });

  const countText = stage.querySelector("[data-live-request-count]");
  if (countText) {
    countText.textContent = count
      ? `${count} in flight`
      : "Waiting for traffic";
  }
  const routeText = stage.querySelector("[data-live-route-status]");
  if (routeText) {
    const routed = requests.filter((request) => request.providerType).length;
    routeText.textContent = count
      ? routed === count
        ? `${count} routing live`
        : "Choosing a provider"
      : "Ready";
  }
}

function queueLiveRequestPaths(force = false) {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => drawLiveRequestPaths({ force }))
  );
}

function homeValues() {
  const s = state.stats || { totalRequests: 0, recent: [] };
  const recent = s.recent || [];
  const online = state.serverListening && state.serverEnabled;
  const last = recent[0];
  const u24 = state.usage || {};
  const tokenTotal =
    Number(u24.total_tokens) ||
    Number(u24.prompt_tokens || 0) + Number(u24.completion_tokens || 0) + Number(u24.cached_tokens || 0);
  const errorRate = u24.requests ? Math.round(((u24.errors || 0) / u24.requests) * 100) : 0;
  return {
    s,
    recent,
    online,
    last,
    u24,
    tokenTotal,
    errorRate,
    providers: liveProviders(),
    activeRequests: state.activeRequests || [],
  };
}

let homeLastProviderKey = "";

function renderHome() {
  if (blockSensitiveRenderIfLocked()) return;
  const { s, recent, online, u24, tokenTotal, errorRate, providers, activeRequests } =
    homeValues();
  homeLastProviderKey = liveProviderKey(providers);
  liveRequestPathKey = "";
  view.innerHTML = `
    <div data-home-root>
    ${pageHeader("Wayfinder", "Status", "One local endpoint. Every account and route behind it.")}
    <section class="hero-surface live-router-card" data-live-router-card>
      <div class="live-router-head">
        <div class="gateway-state"><span class="status-node ${online ? "" : "off"}" data-home-status-node></span><span data-home-gateway>${online ? "Gateway live" : "Gateway stopped"}</span></div>
        <span class="live-provider-count">${providers.length} provider${providers.length === 1 ? "" : "s"}</span>
      </div>
      <div class="live-router-stage" data-live-router-stage aria-label="${esc(
        activeRequests.length
          ? `${activeRequests.length} requests currently routing through ReRouted`
          : "No requests currently routing"
      )}">
        <div class="live-provider-label">Enabled providers</div>
        <div class="live-provider-arch" data-live-provider-arch style="--provider-count:${providers.length}">
          ${liveProviderHtml(providers)}
        </div>
        <svg class="live-route-layer" data-live-route-layer aria-hidden="true"></svg>
        <div class="live-router-hub" data-live-router-hub>
          <svg viewBox="0 0 28 28" aria-hidden="true"><path d="M5 5v6c0 2.2 1.8 4 4 4h10"/><path d="m16 11 4 4-4 4"/><circle cx="5" cy="5" r="2"/><circle cx="5" cy="23" r="2"/><path d="M5 21v-2c0-2.2 1.8-4 4-4"/></svg>
          <span>ReRouted</span>
          <small data-live-route-status>${activeRequests.length ? "Routing live" : "Ready"}</small>
        </div>
        <div class="live-request-source" data-live-request-source>
          <span class="live-request-pulse" aria-hidden="true"></span>
          <strong>Requests</strong>
          <small data-live-request-count>${
            activeRequests.length ? `${activeRequests.length} in flight` : "Waiting for traffic"
          }</small>
        </div>
      </div>
      <div class="endpoint-row"><code data-home-endpoint>${esc(state.endpoint)}</code><button type="button" class="btn btn-secondary btn-sm" id="copy-url">Copy</button></div>
    </section>
    <div class="metric-ribbon">
      <div class="metric"><div class="metric-value" data-home-requests>${fmtNum(u24.requests || 0)}</div><div class="metric-label">Requests 24h</div></div>
      <div class="metric"><div class="metric-value" data-home-tokens>${fmtNum(tokenTotal)}</div><div class="metric-label">Tokens 24h</div></div>
      <div class="metric"><div class="metric-value" data-home-error-rate>${errorRate}%</div><div class="metric-label">Error rate</div></div>
    </div>
    <details class="disclosure" data-home-credentials>
      <summary>Credentials and network</summary>
      <div class="disclosure-body">
        <div class="label">Gateway key</div>
        ${secretHtml(state.apiKey, "home-key")}
        <div class="card-sub" data-home-listen-hint>${esc(state.listenHint || "")}</div>
      </div>
    </details>
    <div class="section-header"><div class="section-title">Traffic now</div><div class="section-meta" data-home-total>${esc(`${fmtNum(s.totalRequests || 0)} all time`)}</div></div>
    <div class="group-list" data-home-recent>
      ${homeRecentHtml(recent)}
    </div>
    </div>
  `;
  $("#copy-url").onclick = () => copy(state.endpoint);
  wireSecrets();
  queueLiveRequestPaths();
}

function updateHome() {
  if (blockSensitiveRenderIfLocked()) return;
  const root = view.querySelector("[data-home-root]");
  if (!root) return renderHome();
  const { s, recent, online, u24, tokenTotal, errorRate, providers } = homeValues();
  const nextProviderKey = liveProviderKey(providers);
  if (nextProviderKey !== homeLastProviderKey) return renderHome();

  root.querySelector("[data-home-status-node]")?.classList.toggle("off", !online);
  root.querySelector("[data-home-gateway]").textContent = online ? "Gateway live" : "Gateway stopped";
  root.querySelector("[data-home-endpoint]").textContent = state.endpoint;
  root.querySelector("[data-home-requests]").textContent = fmtNum(u24.requests || 0);
  root.querySelector("[data-home-tokens]").textContent = fmtNum(tokenTotal);
  root.querySelector("[data-home-error-rate]").textContent = `${errorRate}%`;
  root.querySelector("[data-home-total]").textContent = `${fmtNum(s.totalRequests || 0)} all time`;
  root.querySelector("[data-home-listen-hint]").textContent = state.listenHint || "";
  root.querySelector("[data-home-recent]").innerHTML = homeRecentHtml(recent);

  const secret = root.querySelector('[data-secret-id="home-key"]');
  if (secret && secret.dataset.secret !== state.apiKey) {
    secret.dataset.secret = state.apiKey;
    const shown = secret.dataset.shown === "1";
    secret.querySelector(".secret-val").textContent = shown ? state.apiKey : maskSecret(state.apiKey);
  }
  queueLiveRequestPaths();
}

const OAUTH_TYPES = new Set(["chatgpt", "codex", "claude", "antigravity", "xai"]);
let selectedProviderKey = null;
let expandedAccountId = null;

function startOauthFlow({ type, providerId, onDone, opener }) {
  const panel = $("#add-panel") || $("#oauth-panel");
  const restoreTarget = opener?.isConnected ? opener : activeProviderPanel?.opener;
  disposeProviderPanel({ clear: true });
  const box = document.createElement("div");
  box.className = "action-panel";
  box.setAttribute("role", "region");
  box.setAttribute("aria-labelledby", "oauth-panel-title");
  const prompt = oauthPrompt(type);
  const pasteField = `<div class="oauth-paste-entry"><label class="label" for="paste-code-oauth">${esc(prompt.fieldLabel)}</label>
      <input class="input" id="paste-code-oauth" placeholder="${esc(prompt.placeholder)}" autocomplete="off" /></div>`;
  box.innerHTML = `<div class="action-panel-head"><div class="eyebrow">${providerId ? "Reconnect" : "New account"}</div><div class="action-panel-title" id="oauth-panel-title" data-panel-heading tabindex="-1">${esc(providerLabel(type))}</div><div class="action-panel-sub">Opening a secure browser session. ${esc(prompt.instruction)}</div></div>
    ${oauthRiskNotice()}
    <div class="gateway-state"><span class="status-node"></span><span id="oauth-status-line">Starting OAuth…</span></div>
    ${prompt.primaryPaste ? pasteField : ""}
    <details class="disclosure" style="margin:10px 0 0">
      <summary>Having trouble?</summary>
      <div class="disclosure-body"><div class="label">Authorization URL</div><div class="auth-url-box" id="oauth-url-display">Starting…</div>
      ${prompt.primaryPaste ? "" : pasteField}</div>
    </details>
    <div class="btn-row">
      <button type="button" class="btn btn-secondary btn-sm" id="btn-copy-oauth-url">Copy URL</button>
      <button type="button" class="btn btn-secondary btn-sm" id="btn-reopen-oauth">Restart sign-in</button>
      <button type="button" class="btn btn-secondary btn-sm" id="btn-oauth-logs">Logs</button>
    </div>
    <div class="btn-row">
      <button type="button" class="btn btn-secondary" data-panel-cancel>Cancel</button>
      <button type="button" class="btn btn-primary" id="btn-done-oauth">Finish connection</button>
    </div>`;
  if (panel) {
    panel.innerHTML = "";
    panel.appendChild(box);
  } else {
    view.appendChild(box);
  }
  const oauthStarts = new Set();
  let panelSession;
  panelSession = activateProviderPanel({
    mount: panel || view,
    panel: box,
    opener: restoreTarget,
    onDismiss: async () => {
      if (panelSession.completed) return;
      await Promise.allSettled([...oauthStarts]);
      return api.invoke("app:oauth-cancel", type);
    },
  });
  box.querySelector("[data-panel-cancel]").onclick = () => {
    disposeProviderPanel({ restoreFocus: true });
  };

  let lastAuthUrl = "";
  async function start() {
    const status = box.querySelector("#oauth-status-line");
    const disp = box.querySelector("#oauth-url-display");
    status.textContent = "Starting OAuth…";
    const startRequest = api.invoke("app:oauth-start", type);
    oauthStarts.add(startRequest);
    let r;
    try {
      r = await startRequest;
    } finally {
      oauthStarts.delete(startRequest);
    }
    if (panelSession.closed || !box.isConnected) return;
    if (!r?.ok) {
      status.textContent = r?.error || "OAuth start failed — see Logs";
      status.style.color = "var(--danger)";
      toast(r?.error || "OAuth start failed");
      return;
    }
    lastAuthUrl = r.authUrl || "";
    disp.textContent = lastAuthUrl;
    status.textContent = prompt.primaryPaste
      ? prompt.status
      : r.needsPaste
        ? `Redirect: ${r.redirectUri || "—"} · ${prompt.status}`
        : `Redirect: ${r.redirectUri || "—"} · waiting for browser callback`;
  }
  start().catch((e) => {
    if (!panelSession.closed) toast(e.message || "OAuth start failed");
  });

  box.querySelector("#btn-copy-oauth-url").onclick = () => {
    if (lastAuthUrl) copy(lastAuthUrl);
    else toast("No URL yet");
  };
  box.querySelector("#btn-reopen-oauth").onclick = () => start();
  box.querySelector("#btn-oauth-logs").onclick = () => {
    page = "logs";
    render();
  };
  box.querySelector("#btn-done-oauth").onclick = async () => {
    const status = box.querySelector("#oauth-status-line");
    status.textContent = "Exchanging code…";
    try {
      const paste = box.querySelector("#paste-code-oauth").value.trim() || undefined;
      const r = await api.invoke("app:oauth-complete", { type, pasteCode: paste, providerId });
      if (panelSession.closed || !box.isConnected) return;
      if (!r?.ok) {
        status.textContent = r?.error || "Failed — open Logs";
        toast(r?.error || "OAuth failed");
        return;
      }
      toast(r.account?.reauthed ? "Re-authorized" : "Connected");
      status.textContent = "Connected";
      panelSession.completed = true;
      if (onDone) await onDone(r);
    } catch (e) {
      if (panelSession.closed || !box.isConnected) return;
      status.textContent = e.message || "OAuth failed";
      toast(e.message || "OAuth failed");
    }
  };
}

function providerAccountHtml(account, provider) {
  const open = expandedAccountId === account.id;
  const models = account.models || [];
  const onCount = models.filter((model) => model.enabled !== false).length;
  const displayName = accountDisplayName(account.name, account.email, provider.name);
  const identity = accountIdentityLabel(
    account.email,
    account.profileName,
    account.accountAlias ? aliasLabel(account.accountAlias) : provider.name
  );
  return `
    <section class="account-card group-list" data-account-card="${esc(account.id)}">
      <div class="account-head" data-expand-account="${esc(account.id)}">
        ${providerLogoHtml(provider, "account-provider-logo")}
        <div class="account-copy">
          <div class="row-title" title="${esc(displayName)}">${esc(displayName)}</div>
          <div class="row-sub" title="${esc(identity)}">${esc(identity)} · ${onCount} of ${models.length} models enabled</div>
        </div>
        <div class="account-side">
          ${account.accountAlias ? `<span class="alias-badge">${esc(aliasLabel(account.accountAlias))}</span>` : ""}
          <label class="toggle" data-stop-expand="1"><input type="checkbox" data-en="${esc(account.id)}" ${account.enabled !== false ? "checked" : ""} /><span></span></label>
          <span class="chevron">${open ? "−" : "+"}</span>
        </div>
      </div>
      ${
        open
          ? `<div class="provider-detail">
        <div class="provider-meta-line"><span class="pill">${esc(provider.name)}</span>${account.accountAlias ? `<span class="pill mono">${esc(account.accountAlias)}</span>` : ""}<span class="pill">${models.length} models</span></div>
        ${
          models.length
            ? `<div class="model-bulk-actions" aria-label="Model controls">
                <span>${onCount} on</span>
                <button type="button" class="btn btn-secondary btn-sm" data-all-models="on" data-provider-id="${esc(account.id)}" ${onCount === models.length ? "disabled" : ""}>All On</button>
                <button type="button" class="btn btn-secondary btn-sm" data-all-models="off" data-provider-id="${esc(account.id)}" ${onCount === 0 ? "disabled" : ""}>All Off</button>
              </div>${models
                .map(
                  (model) => `
          <div class="model-row">
            <div class="meta">
              <div class="row-title">${esc(model.name || model.id)}</div>
              <div class="model-id">${esc(model.gatewayId || model.id)}</div>
            </div>
            <label class="toggle" data-stop-expand="1"><input type="checkbox" data-model-en="${esc(account.id)}" data-mid="${esc(model.id)}" ${model.enabled !== false ? "checked" : ""} /><span></span></label>
          </div>`
                )
                .join("")}`
            : `<div class="empty">No models configured for this account.</div>`
        }
        <div class="label account-model-label">Add exact model ID</div>
        <div class="copy-field"><input class="input" id="add-model-${esc(account.id)}" placeholder="provider-model-id" /><button type="button" class="btn btn-secondary btn-sm" data-add-model="${esc(account.id)}">Test &amp; add</button></div>
        <div class="model-test-status" id="add-model-status-${esc(account.id)}" hidden></div>
        <button type="button" class="btn btn-secondary btn-sm model-error-copy" data-copy-model-error="${esc(account.id)}" hidden>Copy full error</button>
        <div class="action-row">
          ${
            OAUTH_TYPES.has(account.type)
              ? `<button type="button" class="btn btn-secondary btn-sm" data-reauth="${esc(account.id)}" data-type="${esc(account.type === "codex" ? "chatgpt" : account.type)}">Reconnect</button>`
              : ""
          }
          <button type="button" class="btn btn-danger btn-sm" data-del="${esc(account.id)}">Disconnect</button>
        </div>
      </div>`
          : ""
      }
    </section>`;
}

function providerLandingHtml(catalog) {
  return `
    ${pageHeader("Sources", "Accounts", "Choose a provider, then add or manage as many accounts and API keys as you need.")}
    ${accountSubnav("providers")}
    <div class="provider-card-grid">
      ${catalog
        .map((provider) => {
          const count = provider.accounts.length;
          const status = count
            ? `${count} account${count === 1 ? "" : "s"}`
            : "Not connected";
          return `<button type="button" class="provider-card ${count ? "connected" : ""}" data-provider-key="${esc(provider.id)}">
            <span class="provider-card-top">
              ${providerLogoHtml(provider)}
              <span class="provider-status ${count ? "connected" : ""}"><i></i>${esc(status)}</span>
            </span>
            <span class="provider-card-name">${esc(provider.name)}</span>
            <span class="provider-card-copy">${esc(providerPresentation(provider).description)}</span>
            <span class="provider-card-action">${count ? "Manage" : "Connect"}<span aria-hidden="true">→</span></span>
          </button>`;
        })
        .join("")}
    </div>`;
}

function providerDetailHtml(provider) {
  const count = provider.accounts.length;
  const addLabel = provider.kind === "oauth" ? "Add account" : "Add key";
  const canAdd = provider.kind !== "unknown";
  return `
    <button type="button" class="provider-back" data-provider-back><span aria-hidden="true">←</span> All providers</button>
    ${pageHeader(
      "Provider",
      provider.name,
      `${providerPresentation(provider).description}. ${count ? `${count} connected.` : "Nothing connected yet."}`,
      canAdd
        ? `<button type="button" class="btn btn-primary btn-sm" id="btn-add-provider">${esc(addLabel)}</button>`
        : ""
    )}
    ${accountSubnav("providers")}
    <div class="provider-detail-summary">
      ${providerLogoHtml(provider, "provider-logo-large")}
      <div class="provider-detail-summary-copy">
        <div class="row-title">${esc(provider.name)}</div>
        <div class="row-sub">${esc(count ? `${count} connected account${count === 1 ? "" : "s"}` : "Ready when you are")}</div>
      </div>
      <span class="provider-status ${count ? "connected" : ""}"><i></i>${count ? "Connected" : "Available"}</span>
    </div>
    ${sectionHeader("Accounts & keys", count ? `${count} connected` : "None connected")}
    <div class="provider-account-list">
      ${
        count
          ? provider.accounts.map((account) => providerAccountHtml(account, provider)).join("")
          : `<div class="empty">No ${provider.kind === "oauth" ? "accounts" : "keys"} connected for ${esc(provider.name)} yet.</div>`
      }
    </div>
    ${
      provider.kind === "unknown"
        ? `<div class="footer-note">This existing provider can be managed here, but its connection method is no longer in the current catalog.</div>`
        : ""
    }
    <div id="add-panel"></div>`;
}

function openProviderAddPanel(provider, opener) {
  if (provider.kind === "oauth") {
    startOauthFlow({
      type: provider.oauthType || provider.id,
      onDone: async () => {
        await refresh();
        renderProviders();
      },
      opener,
    });
    return;
  }
  if (provider.kind !== "keyed" && provider.kind !== "custom") return;

  const panel = $("#add-panel");
  const preset = (state.keyedPresets || []).find((item) => item.id === provider.id);
  const isCustom = provider.kind === "custom";
  disposeProviderPanel({ clear: true });
  panel.innerHTML = `
    <div class="action-panel provider-scoped-panel" role="region" aria-labelledby="key-panel-title">
      <div class="action-panel-head"><div class="eyebrow">New API key</div><div class="action-panel-title" id="key-panel-title" data-panel-heading tabindex="-1">${esc(provider.name)}</div><div class="action-panel-sub">Add another key without leaving this provider.</div></div>
      <div class="provider-scoped-key-form">
        ${keyedProviderPickerHtml(preset ? [preset] : [], { includeCustom: isCustom })}
      </div>
      <button type="button" class="btn btn-ghost panel-cancel" data-panel-cancel>Cancel</button>
    </div>`;
  activateProviderPanel({ mount: panel, panel: panel.querySelector(".action-panel"), opener });
  panel.querySelector("[data-panel-cancel]").onclick = () => {
    disposeProviderPanel({ restoreFocus: true });
  };
  bindKeyedProviderPicker(panel, {
    initialPresetId: isCustom ? "custom" : provider.id,
    successMessage: `${provider.name} key connected`,
    onAdded: async () => {
      disposeProviderPanel({ clear: true });
      renderProviders();
    },
  });
}

function renderProviders() {
  if (blockSensitiveRenderIfLocked()) return;
  disposeProviderPanel({ clear: false });
  const catalog = buildProviderCatalog({
    oauthProviders: state.oauthProviders || [],
    keyedPresets: state.keyedPresets || [],
    providers: state.providers || [],
  });
  let selectedProvider = selectedProviderKey
    ? catalog.find((provider) => provider.id === selectedProviderKey)
    : null;
  if (selectedProviderKey && !selectedProvider) {
    selectedProviderKey = null;
    expandedAccountId = null;
    selectedProvider = null;
  }
  view.innerHTML = selectedProvider
    ? providerDetailHtml(selectedProvider)
    : providerLandingHtml(catalog);
  wireSubnav();

  view.querySelectorAll("[data-provider-key]").forEach((card) => {
    card.onclick = () => {
      selectedProviderKey = card.dataset.providerKey;
      expandedAccountId = null;
      renderProviders();
      view.scrollTop = 0;
      requestAnimationFrame(() => {
        view.querySelector("[data-provider-back]")?.focus({ preventScroll: true });
      });
    };
  });
  view.querySelector("[data-provider-back]")?.addEventListener("click", () => {
    const previousProviderKey = selectedProviderKey;
    selectedProviderKey = null;
    expandedAccountId = null;
    renderProviders();
    view.scrollTop = 0;
    requestAnimationFrame(() => {
      [...view.querySelectorAll("[data-provider-key]")]
        .find((card) => card.dataset.providerKey === previousProviderKey)
        ?.focus({ preventScroll: true });
    });
  });
  const addProviderButton = $("#btn-add-provider");
  if (addProviderButton && selectedProvider) {
    addProviderButton.onclick = () => openProviderAddPanel(selectedProvider, addProviderButton);
  }

  // Toggles must not trigger account expansion (and CSP blocks inline onclick).
  view.querySelectorAll("[data-stop-expand]").forEach((el) => {
    el.addEventListener("click", (event) => event.stopPropagation());
  });
  view.querySelectorAll("[data-expand-account]").forEach((el) => {
    el.onclick = (event) => {
      if (event.target.closest("[data-stop-expand], .toggle, input, button, label")) return;
      const id = el.dataset.expandAccount;
      expandedAccountId = expandedAccountId === id ? null : id;
      renderProviders();
    };
  });
  view.querySelectorAll("input[data-en]").forEach((el) => {
    el.addEventListener("click", (e) => e.stopPropagation());
    el.addEventListener("change", async (e) => {
      e.stopPropagation();
      const id = el.dataset.en;
      const enabled = el.checked;
      const r = await api.invoke("app:set-provider-enabled", { id, enabled });
      if (!r?.ok) {
        toast("Could not update provider");
        el.checked = !enabled;
        return;
      }
      toast(enabled ? "Provider enabled" : "Provider disabled");
      await refresh();
      renderProviders();
    });
  });
  view.querySelectorAll("input[data-model-en]").forEach((el) => {
    el.addEventListener("click", (e) => e.stopPropagation());
    el.addEventListener("change", async (e) => {
      e.stopPropagation();
      await api.invoke("app:set-model-enabled", {
        providerId: el.dataset.modelEn,
        modelId: el.dataset.mid,
        enabled: el.checked,
      });
      await refresh();
      renderProviders();
    });
  });
  view.querySelectorAll("button[data-all-models]").forEach((button) => {
    button.onclick = async (event) => {
      event.stopPropagation();
      const enabled = button.dataset.allModels === "on";
      button.disabled = true;
      const result = await api.invoke("app:set-all-models-enabled", {
        providerId: button.dataset.providerId,
        enabled,
      });
      if (!result?.ok) return toast("Could not update models");
      toast(enabled ? "All models enabled" : "All models disabled");
      await refresh();
      renderProviders();
    };
  });
  view.querySelectorAll("button[data-add-model]").forEach((btn) => {
    btn.onclick = async () => {
      const pid = btn.dataset.addModel;
      const input = $(`#add-model-${pid}`);
      const status = $(`#add-model-status-${pid}`);
      const copyError = view.querySelector(`[data-copy-model-error="${pid}"]`);
      const modelId = (input?.value || "").trim();
      if (!modelId) return toast("Enter a model name");
      status.hidden = false;
      status.classList.remove("error", "ok");
      status.textContent = "Testing…";
      copyError.hidden = true;
      btn.disabled = true;
      const r = await api.invoke("app:add-model", { providerId: pid, modelId });
      btn.disabled = false;
      if (!r.ok) {
        status.textContent = r.error || "Failed";
        status.classList.add("error");
        copyError.hidden = false;
        copyError.onclick = () => copy(r.error || "Failed");
        return;
      }
      status.textContent = `Added ${modelId}`;
      status.classList.add("ok");
      toast("Model added");
      await refresh();
      expandedAccountId = pid;
      renderProviders();
    };
  });
  view.querySelectorAll("button[data-reauth]").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      startOauthFlow({
        type: btn.dataset.type,
        providerId: btn.dataset.reauth,
        onDone: async () => {
          await refresh();
          renderProviders();
        },
        opener: btn,
      });
    };
  });
  view.querySelectorAll("button[data-del]").forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      if (armDelete !== btn.dataset.del) {
        armDelete = btn.dataset.del;
        btn.textContent = "Sure?";
        setTimeout(() => {
          if (armDelete === btn.dataset.del) {
            armDelete = null;
            btn.textContent = "Disconnect";
          }
        }, 2500);
        return;
      }
      armDelete = null;
      await api.invoke("app:remove-provider", btn.dataset.del);
      await refresh();
      renderProviders();
      toast("Account disconnected");
    };
  });
}

function memberKey(m) {
  return `${m.providerType || m.providerId}::${m.model || m.upstreamModel}`;
}

let comboDraft = null;

function beginComboEdit(combo) {
  comboDraft = {
    id: combo?.storageId || combo?.id || null,
    name: combo?.name || "",
    strategy: combo?.strategy || "fallback",
    pickerProviderId: null,
    pickerModelId: null,
    members: (combo?.members || []).map((member) => ({
      ...(member.providerType
        ? { providerType: canonicalProviderType(member.providerType) }
        : { providerId: member.providerId }),
      model: member.model || member.upstreamModel,
    })),
  };
  renderCombos({ focusEditor: true });
}

function focusRouteEditor() {
  const editorEl = view.querySelector(".route-editor");
  if (!editorEl) return;
  editorEl.scrollIntoView({ block: "start", behavior: "auto" });
  const name = $("#c-name");
  if (name) {
    name.focus({ preventScroll: true });
    if (typeof name.select === "function") name.select();
  }
}

function syncComboDraft() {
  if (!comboDraft) return;
  const name = $("#c-name");
  if (name) comboDraft.name = name.value;
}

function comboMemberInfo(member, providers) {
  const normalized = normalizeRouteMember(member, providers);
  const provider = providers.find((entry) =>
    normalized.providerType
      ? entry.providerType === normalized.providerType && !entry.connectionScoped
      : entry.providerId === normalized.providerId
  );
  const model = provider?.models.find((entry) => entry.upstreamModel === normalized.model);
  return { member: normalized, provider, model };
}

function routeProviderLabel(provider) {
  if (!provider) return "Provider";
  return provider.name;
}

function renderCombos(options = {}) {
  if (blockSensitiveRenderIfLocked()) return;
  const combos = state.combos || [];
  const providers = buildRouteProviderOptions(state.providers || []);
  const editor = comboDraft;
  if (editor && !providers.some((provider) => provider.id === editor.pickerProviderId)) {
    editor.pickerProviderId = null;
    editor.pickerModelId = null;
  }
  const pickerModels = editor
    ? modelsForRouteProvider(providers, editor.pickerProviderId)
    : [];
  if (
    editor?.pickerModelId &&
    !pickerModels.some((model) => model.upstreamModel === editor.pickerModelId)
  ) {
    editor.pickerModelId = null;
  }

  const listMarkup = `
    <div class="route-card-grid">
      ${
        combos.length
          ? combos
            .map(
              (c, index) => `
      <article class="route-card${editor && (editor.id === (c.storageId || c.id) || (!editor.id && !c.storageId && !c.id)) ? " is-active" : ""}">
        <button type="button" class="route-card-hit" data-edit-index="${index}" aria-label="Edit route ${esc(comboRouteId(c))}"></button>
        <div class="route-card-top">
          <span class="strategy-badge">${c.strategy === "round-robin" ? "Round robin" : "Fallback"}</span>
          <button type="button" class="route-delete" data-del-index="${index}" aria-label="Delete route ${esc(comboRouteId(c))}" title="Delete route">×</button>
        </div>
        <div class="route-name">${esc(comboRouteId(c))}</div>
        <div class="route-summary">${c.strategy === "round-robin" ? "Rotates every request" : "Fills in order"} · ${(c.members || []).length} member${(c.members || []).length === 1 ? "" : "s"}</div>
        <div class="route-nodes" aria-hidden="true">${(c.members || []).slice(0, 5).map((_, index) => `${index ? '<span class="route-node-line"></span>' : ""}<span class="route-node">${index + 1}</span>`).join("")}${(c.members || []).length > 5 ? '<span class="route-node-line"></span><span class="route-node">+</span>' : ""}</div>
        <div class="route-card-action" aria-hidden="true">${editor && (editor.id === (c.storageId || c.id)) ? "Editing" : "Open"} <span>→</span></div>
      </article>`
            )
            .join("")
          : `<div class="empty">No routes yet. Create a memorable model ID and choose where requests should go.</div>`
      }
    </div>`;

  const editorMarkup = editor
    ? `<section class="action-panel route-editor" id="route-editor">
      <div class="action-panel-head">
        <div class="eyebrow">${editor.id ? "Edit route" : "New route"}</div>
        <div class="action-panel-title">${editor.id ? esc(editor.name || "Route") : "Build a route"}</div>
        <div class="action-panel-sub">The model ID below is what clients see in <span class="mono">/v1/models</span>.</div>
      </div>
      <div class="label">Model ID</div>
      <input class="input" id="c-name" placeholder="coding-fast" value="${esc(editor.name)}" />
      <div class="label">Routing behavior</div>
      <div class="seg" id="c-strat" style="margin-left:0">
        <button type="button" data-s="fallback" class="${editor.strategy === "fallback" ? "active" : ""}">Fallback in order</button>
        <button type="button" data-s="round-robin" class="${editor.strategy === "round-robin" ? "active" : ""}">Rotate requests</button>
      </div>
      <div class="label">Route members</div>
      <div class="member-list">
        ${
          editor.members.length
            ? editor.members
                .map((member, index) => {
                  const info = comboMemberInfo(member, providers);
                  const providerName = info.provider?.name || member.providerType || "Provider";
                  const accountCount = info.model?.accountCount || info.provider?.accountCount || 0;
                  const accountNote = info.provider?.connectionScoped
                    ? "This connection"
                    : accountCount > 1
                      ? `Tries ${accountCount} accounts before the next member`
                      : "Uses the connected account";
                  return `<div class="member-row" draggable="true" data-member-index="${index}">
                    <div class="member-drag" aria-hidden="true"><span></span><span></span><span></span></div>
                    <div class="member-index">${index + 1}</div>
                    <div class="ellip"><div class="row-title">${esc(providerName)} · ${esc(info.model?.name || member.model)}</div><div class="model-id">${esc(info.model?.upstreamModel || member.model)} · ${esc(accountNote)}</div></div>
                    <div class="member-actions"><button type="button" data-member-up="${index}" title="Move up" aria-label="Move ${esc(info.model?.name || member.model)} up" ${index === 0 ? "disabled" : ""}>↑</button><button type="button" data-member-down="${index}" title="Move down" aria-label="Move ${esc(info.model?.name || member.model)} down" ${index === editor.members.length - 1 ? "disabled" : ""}>↓</button><button type="button" data-member-remove="${index}" title="Remove" aria-label="Remove ${esc(info.model?.name || member.model)}">×</button></div>
                  </div>`;
                })
                .join("")
            : `<div class="empty" style="margin:0;border:0">Add at least one model to this route.</div>`
        }
      </div>
      <div class="route-member-picker">
        <label class="route-picker-field" for="c-add-provider"><span class="label">Provider</span><select class="select" id="c-add-provider"><option value="">Choose a provider…</option>${providers.map((provider) => `<option value="${esc(provider.id)}" ${provider.id === editor.pickerProviderId ? "selected" : ""}>${esc(routeProviderLabel(provider))}</option>`).join("")}</select></label>
        <label class="route-picker-field" for="c-add-model"><span class="label">Model</span><select class="select" id="c-add-model" ${editor.pickerProviderId ? "" : "disabled"}><option value="">${editor.pickerProviderId ? "Choose a model…" : "Choose a provider first…"}</option>${pickerModels.map((model) => `<option value="${esc(model.upstreamModel)}" ${model.upstreamModel === editor.pickerModelId ? "selected" : ""}>${esc(model.name)} · ${esc(model.upstreamModel)}</option>`).join("")}</select></label>
        <button type="button" class="btn btn-secondary btn-sm route-picker-add" id="btn-add-member" ${editor.pickerProviderId && editor.pickerModelId ? "" : "disabled"}>Add to route</button>
      </div>
      <div class="route-picker-note">When a provider has multiple accounts, ReRouted tries that model on every eligible account before moving to the next route member.</div>
      <div class="btn-row"><button type="button" class="btn btn-secondary" id="btn-cancel-edit">Back to routes</button><button type="button" class="btn btn-primary" id="btn-create">${editor.id ? "Save route" : "Create route"}</button></div>
    </section>`
    : "";

  // When editing, replace the list with the editor (full page take-over). No buried bottom panel.
  view.innerHTML = `
    ${pageHeader(
      "Routing",
      editor ? (editor.id ? editor.name || "Edit route" : "New route") : "Routes",
      editor
        ? "Change the model ID, order, and failover for this route."
        : "Give clients one memorable model ID while ReRouted handles account and provider failover.",
      editor
        ? '<button type="button" class="btn btn-secondary btn-sm" id="btn-back-routes">← Routes</button>'
        : '<button type="button" class="btn btn-primary btn-sm" id="btn-new-route">New route</button>'
    )}
    ${editor ? editorMarkup : listMarkup}
  `;

  const backToList = () => {
    comboDraft = null;
    renderCombos();
  };
  const backBtn = $("#btn-back-routes");
  if (backBtn) backBtn.onclick = backToList;
  const newBtn = $("#btn-new-route");
  if (newBtn) newBtn.onclick = () => beginComboEdit(null);
  view.querySelectorAll("button[data-edit-index]").forEach((btn) => {
    btn.onclick = () => beginComboEdit(combos[Number(btn.dataset.editIndex)]);
  });
  view.querySelectorAll("button[data-del-index]").forEach((btn) => {
    btn.onclick = async (event) => {
      event.stopPropagation();
      const combo = combos[Number(btn.dataset.delIndex)];
      const id = combo?.storageId || combo?.id;
      if (!id) return;
      if (armDelete !== id) {
        armDelete = id;
        btn.textContent = "Sure?";
        return;
      }
      await api.invoke("app:delete-combo", id);
      armDelete = null;
      await refresh();
      comboDraft = null;
      renderCombos();
    };
  });
  if (!editor) return;
  view.querySelectorAll("#c-strat button").forEach((button) => {
    button.onclick = () => {
      syncComboDraft();
      editor.strategy = button.dataset.s;
      renderCombos();
    };
  });
  view.querySelectorAll("[data-member-up]").forEach((button) => {
    button.onclick = () => {
      syncComboDraft();
      const index = Number(button.dataset.memberUp);
      moveRouteMember(editor.members, index, index - 1);
      renderCombos();
    };
  });
  view.querySelectorAll("[data-member-down]").forEach((button) => {
    button.onclick = () => {
      syncComboDraft();
      const index = Number(button.dataset.memberDown);
      moveRouteMember(editor.members, index, index + 1);
      renderCombos();
    };
  });
  let draggedMemberIndex = null;
  view.querySelectorAll("[data-member-index]").forEach((row) => {
    row.ondragstart = (event) => {
      syncComboDraft();
      draggedMemberIndex = Number(row.dataset.memberIndex);
      row.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", row.dataset.memberIndex);
    };
    row.ondragover = (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      row.classList.add("drag-over");
    };
    row.ondragleave = () => row.classList.remove("drag-over");
    row.ondrop = (event) => {
      event.preventDefault();
      const from = draggedMemberIndex ?? Number(event.dataTransfer.getData("text/plain"));
      const to = Number(row.dataset.memberIndex);
      moveRouteMember(editor.members, from, to);
      draggedMemberIndex = null;
      renderCombos();
    };
    row.ondragend = () => {
      draggedMemberIndex = null;
      row.classList.remove("dragging", "drag-over");
    };
  });
  view.querySelectorAll("[data-member-remove]").forEach((button) => {
    button.onclick = () => {
      syncComboDraft();
      editor.members.splice(Number(button.dataset.memberRemove), 1);
      renderCombos();
    };
  });
  $("#c-add-provider").onchange = () => {
    syncComboDraft();
    editor.pickerProviderId = $("#c-add-provider").value || null;
    editor.pickerModelId = null;
    renderCombos();
  };
  $("#c-add-model").onchange = () => {
    editor.pickerModelId = $("#c-add-model").value || null;
    $("#btn-add-member").disabled = !editor.pickerProviderId || !editor.pickerModelId;
  };
  $("#btn-add-member").onclick = () => {
    syncComboDraft();
    if (!editor.pickerProviderId) return toast("Choose a provider");
    if (!editor.pickerModelId) return toast("Choose a model");
    const model = pickerModels.find(
      (item) => item.upstreamModel === editor.pickerModelId
    );
    const provider = providers.find((item) => item.id === editor.pickerProviderId);
    if (!provider || !model) return toast("Choose a model");
    const member = routeMemberForProvider(provider, model.upstreamModel);
    if (editor.members.some((item) => memberKey(item) === memberKey(member))) {
      return toast("That model is already in the route");
    }
    editor.members.push(member);
    editor.pickerProviderId = null;
    editor.pickerModelId = null;
    renderCombos();
  };
  $("#btn-cancel-edit").onclick = () => {
    comboDraft = null;
    renderCombos();
  };
  $("#btn-create").onclick = async () => {
    syncComboDraft();
    const name = editor.name.trim();
    if (!name) return toast("Enter a model ID");
    const conflict = combos.some(
      (combo) =>
        (combo.storageId || combo.id) !== editor.id &&
        comboRouteId(combo).toLowerCase() === name.toLowerCase()
    );
    if (conflict) return toast("That model ID is already in use");
    if (!editor.members.length) return toast("Add at least one model");
    const result = await api.invoke("app:save-combo", {
      id: editor.id,
      name,
      strategy: editor.strategy,
      members: editor.members,
    });
    if (!result?.ok) return toast(result?.error || "Could not save route");
    toast(editor.id ? "Route saved" : "Route created");
    comboDraft = null;
    await refresh();
    renderCombos();
  };
  if (options.focusEditor) {
    requestAnimationFrame(() => focusRouteEditor());
  }
}

let statsPeriod = "24h";
let statsRenderRequest = 0;
let logsRenderRequest = 0;
let pollTimer = null;
let quotaRefreshTimer = null;
let quotaState = null;
let quotaLoading = false;
let quotaInitialized = false;
const QUOTA_REFRESH_INTERVAL_MS = 60_000;

function stopPoll() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (quotaRefreshTimer) {
    clearInterval(quotaRefreshTimer);
    quotaRefreshTimer = null;
  }
}

function startPoll(fn, ms = 2500) {
  stopPoll();
  pollTimer = setInterval(fn, ms);
}

function quotaWindowHtml(window) {
  const used = Math.max(0, Math.min(100, Number(window.usedPercent) || 0));
  const left = Math.max(0, 100 - used);
  const tone = used >= 95 ? "danger" : used >= 80 ? "warn" : "";
  return `<div class="quota-window">
    <div class="quota-window-head">
      <div><div class="quota-left">${Math.round(left)}% left</div><div class="quota-window-label">${esc(window.label || "Limit")}</div></div>
      <span class="quota-window-label" data-quota-reset="${esc(window.resetsAt || "")}">${esc(fmtReset(window.resetsAt))}</span>
    </div>
    <div class="quota-bar ${tone}"><i style="width:${used}%"></i></div>
    <div class="quota-window-foot">
      <span>Capacity used</span><span>${Math.round(used)}%</span>
    </div>
  </div>`;
}

function quotaAccountHtml(account) {
  const glyph = providerLabel(account.type).slice(0, 2).toUpperCase();
  const identity = accountDisplayName(
    account.name,
    account.email,
    providerLabel(account.type)
  );
  const accountLabel = accountIdentityLabel(
    account.email,
    account.profileName,
    account.accountAlias ? aliasLabel(account.accountAlias) : providerLabel(account.type)
  );
  const statusLabel = {
    ok: "Live",
    empty: "No windows",
    unsupported: "Unavailable",
    error: "Error",
    idle: "Not refreshed",
  }[account.status] || account.status;
  const credits = account.credits;
  let creditLine = "";
  if (credits?.unlimited) creditLine = `<div class="quota-credit">Credits · Unlimited</div>`;
  else if (credits?.balance != null) {
    creditLine = `<div class="quota-credit">Credits · ${esc(fmtNum(credits.balance))}</div>`;
  } else if (credits?.limit != null) {
    const currency = credits.currency ? ` ${credits.currency}` : "";
    creditLine = `<div class="quota-credit">Extra usage · ${esc(fmtNum(credits.used || 0))} / ${esc(fmtNum(credits.limit))}${esc(currency)}</div>`;
  }
  const detail =
    account.error ||
    account.note ||
    (!account.windows?.length ? "No quota windows returned for this account." : "");
  return `<section class="quota-card">
    <div class="quota-account-head">
      <div class="account-glyph ${esc(account.type)}">${esc(glyph)}</div>
      <div class="quota-account-copy">
        <div class="row-title" title="${esc(identity)}">${esc(identity)}</div>
        <div class="row-sub" title="${esc(accountLabel)}">${esc(accountLabel)} · ${esc(account.plan || providerLabel(account.type))}</div>
      </div>
      ${account.accountAlias ? `<span class="alias-badge">${esc(aliasLabel(account.accountAlias))}</span>` : ""}
      <span class="quota-status ${esc(account.status)}">${esc(statusLabel)}</span>
    </div>
    ${(account.windows || []).map(quotaWindowHtml).join("")}
    ${creditLine}
    ${detail ? `<div class="quota-note ${account.status === "error" ? "error" : ""}">${esc(detail)}</div>` : ""}
  </section>`;
}

function updateQuotaCountdowns() {
  view.querySelectorAll("[data-quota-reset]").forEach((el) => {
    el.textContent = fmtReset(el.dataset.quotaReset);
  });
  const updated = $("#quota-updated");
  if (updated && quotaState?.refreshedAt) {
    updated.textContent = `Updated ${fmtRelativeTime(quotaState.refreshedAt)}`;
  }
}

async function refreshQuota() {
  if (quotaLoading) return;
  quotaLoading = true;
  if (page === "quota") renderQuota();
  try {
    const r = await api.invoke("app:quota-refresh");
    if (r?.ok) quotaState = r.quota;
    else toast(r?.error || "Quota refresh failed");
  } catch (error) {
    toast(error?.message || "Quota refresh failed");
  } finally {
    quotaLoading = false;
    if (page === "quota") renderQuota();
  }
}

async function initializeQuota() {
  if (!quotaInitialized) {
    quotaInitialized = true;
    try {
      const r = await api.invoke("app:quota-get");
      if (r?.ok) quotaState = r.quota;
    } catch {
      /* the refresh path below will surface provider-specific errors */
    }
  }
  if (page === "quota") renderQuota();
  if (!quotaState?.refreshedAt || Date.now() - quotaState.refreshedAt >= QUOTA_REFRESH_INTERVAL_MS) {
    await refreshQuota();
  }
}

function startQuotaRefreshPoll() {
  if (quotaRefreshTimer) clearInterval(quotaRefreshTimer);
  quotaRefreshTimer = setInterval(() => {
    if (page === "quota") refreshQuota();
  }, QUOTA_REFRESH_INTERVAL_MS);
}

function renderQuota() {
  if (blockSensitiveRenderIfLocked()) return;
  const accounts = quotaState?.accounts || [];
  view.innerHTML = `
    ${pageHeader("Capacity", "Accounts", "See the remaining subscription capacity and reset time for every connected account.", `<button type="button" class="btn btn-secondary btn-sm" id="btn-quota-refresh" ${quotaLoading ? "disabled" : ""}>${quotaLoading ? "Refreshing…" : "Refresh"}</button>`)}
    ${accountSubnav("quota")}
    ${sectionHeader(`${accounts.length} account${accounts.length === 1 ? "" : "s"}`, quotaState?.refreshedAt ? `Updated ${fmtRelativeTime(quotaState.refreshedAt)}` : "Not refreshed")}
    ${
      accounts.length
        ? accounts.map(quotaAccountHtml).join("")
        : `<div class="empty quota-empty">Connect and enable an OAuth account to see subscription quota.</div>`
    }
    <div class="footer-note">ChatGPT/Codex, Claude, and Antigravity OAuth quota APIs are supported. Other providers appear here as availability expands.</div>
  `;
  wireSubnav();
  $("#btn-quota-refresh").onclick = () => refreshQuota();
}

async function renderStats() {
  if (blockSensitiveRenderIfLocked()) return;
  const requestId = ++statsRenderRequest;
  const period = statsPeriod || "24h";
  let usage = state.usage;
  try {
    const r = await api.invoke("app:usage", period);
    if (r?.ok) {
      usage = r.usage;
      if (r.stats) state.stats = r.stats;
    }
  } catch {
    /* keep cached */
  }
  if (
    page !== "stats" ||
    requestId !== statsRenderRequest ||
    blockSensitiveRenderIfLocked()
  ) return;
  usage = usage || {
    requests: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    cached_tokens: 0,
    total_tokens: 0,
    ok: 0,
    errors: 0,
    byModel: [],
    byProvider: [],
    recent: [],
  };
  const periods = [
    ["1h", "1h"],
    ["24h", "24h"],
    ["7d", "7d"],
    ["30d", "30d"],
    ["all", "All"],
  ];
  const maxModelReq = Math.max(1, ...(usage.byModel || []).map((m) => m.requests || 0));
  const maxProvReq = Math.max(1, ...(usage.byProvider || []).map((p) => p.requests || 0));
  const errRate =
    usage.requests > 0 ? Math.round(((usage.errors || 0) / usage.requests) * 100) : 0;
  const successRate = Math.max(0, 100 - errRate);
  view.innerHTML = `
    ${pageHeader("Telemetry", "Activity", "Understand route volume, token mix, failures, and which accounts are carrying traffic.")}
    ${activitySubnav("stats")}
    <div class="seg" id="u-period">
      ${periods
        .map(
          ([k, lab]) =>
            `<button type="button" data-period="${k}" class="${period === k ? "active" : ""}">${lab}</button>`
        )
        .join("")}
    </div>
    <div class="metric-ribbon">
      <div class="metric"><div class="metric-value">${fmtNum(usage.requests)}</div><div class="metric-label">Requests</div></div>
      <div class="metric"><div class="metric-value">${successRate}%</div><div class="metric-label">Success</div></div>
      <div class="metric"><div class="metric-value">${fmtNum(usage.total_tokens)}</div><div class="metric-label">Tokens</div></div>
    </div>
    ${sectionHeader("Token mix", `${fmtNum(usage.total_tokens)} total`)}
    <div class="surface">
      ${tokenMeter(usage)}
    </div>
    ${sectionHeader("Routes", "Ranked by requests")}
    <div class="group-list">
      ${
        (usage.byModel || []).length
          ? usage.byModel
              .slice(0, 12)
              .map((m) => {
                const pct = Math.round(((m.requests || 0) / maxModelReq) * 100);
                const tok = (m.prompt_tokens || 0) + (m.completion_tokens || 0);
                return `<div class="rank-row">
                  <div class="row-title ellip">${esc(friendlyRoute(m.model))}</div>
                  <div class="mono">${fmtNum(m.requests)} · ${fmtNum(tok)}t</div>
                  <div class="row-bar"><i style="width:${pct}%"></i></div>
                </div>`;
              })
              .join("")
          : `<div class="empty">No traffic in this period</div>`
      }
    </div>
    ${sectionHeader("Accounts", "Ranked by requests")}
    <div class="group-list">
      ${
        (usage.byProvider || []).length
          ? usage.byProvider
              .slice(0, 12)
              .map((p) => {
                const pct = Math.round(((p.requests || 0) / maxProvReq) * 100);
                const tok = (p.prompt_tokens || 0) + (p.completion_tokens || 0);
                return `<div class="rank-row">
                  <div class="row-title ellip">${esc(p.provider)}</div>
                  <div class="mono">${fmtNum(p.requests)} · ${fmtNum(tok)}t</div>
                  <div class="row-bar"><i style="width:${pct}%"></i></div>
                </div>`;
              })
              .join("")
          : `<div class="empty">No traffic in this period</div>`
      }
    </div>
    ${sectionHeader("Recent requests", `${usage.errors || 0} errors`)}
    <div class="group-list">
      ${
        (usage.recent || []).length
          ? usage.recent
              .slice(0, 20)
              .map((r) => {
                const via = r.providerName || r.providerType || "";
                return `<div class="event-row"><span class="event-dot ${Number(r.status) >= 400 ? "error" : "route"}"></span><div class="event-main"><div class="event-title">${esc(friendlyRoute(r.model))}</div><div class="event-meta">${esc(via)} · ${fmtNum((r.prompt_tokens || 0) + (r.completion_tokens || 0))} tokens</div></div><div class="event-time">${esc(fmtTime(r.at))}</div></div>`;
              })
              .join("")
          : `<div class="empty">Waiting for requests…</div>`
      }
    </div>
  `;
  wireSubnav();
  view.querySelectorAll("#u-period button").forEach((b) => {
    b.onclick = () => {
      statsPeriod = b.dataset.period;
      renderStats();
    };
  });
}

async function renderLogs() {
  if (blockSensitiveRenderIfLocked()) return;
  const requestId = ++logsRenderRequest;
  let r;
  try {
    r = await api.invoke("app:logs-get", 250);
  } catch (error) {
    if (page === "logs" && requestId === logsRenderRequest) {
      toast(error?.message || "Could not load logs");
    }
    return;
  }
  if (
    page !== "logs" ||
    requestId !== logsRenderRequest ||
    blockSensitiveRenderIfLocked()
  ) return;
  const entries = r?.entries || [];
  const file = r?.file || "";
  view.innerHTML = `
    ${pageHeader("Diagnostics", "Activity", "Read routing, OAuth, and gateway events without digging through a terminal.")}
    ${activitySubnav("logs")}
    <div class="log-toolbar">
      <div class="copy-field"><code>${esc(file || "No log file")}</code><button type="button" class="btn btn-secondary btn-sm" id="btn-log-reveal">Reveal</button></div>
      <button type="button" class="btn btn-secondary btn-sm" id="btn-log-refresh">Refresh</button>
    </div>
    <div class="log-box" id="log-box">
      ${
        entries.length
          ? entries
              .map((e) => {
                const ts = new Date(e.at).toISOString().slice(11, 23);
                const meta = e.meta ? "\n" + JSON.stringify(e.meta, null, 0) : "";
                return `<div class="log-line"><span class="ts">${esc(ts)}</span><span class="lvl-${esc(e.level)}">${esc(e.level)}</span><span>${esc(e.msg)}</span>${meta ? `<div class="log-meta">${esc(meta)}</div>` : ""}</div>`;
              })
              .join("")
          : `<div class="empty" style="margin:0;border:0">No events yet. Connect an account or send a request.</div>`
      }
    </div>
    <div class="btn-row"><button type="button" class="btn btn-secondary btn-sm" id="btn-log-copy">Copy all</button><button type="button" class="btn btn-danger btn-sm" id="btn-log-clear">Clear log</button></div>
  `;
  wireSubnav();
  $("#btn-log-refresh").onclick = () => renderLogs();
  $("#btn-log-copy").onclick = async () => {
    const all = (await api.invoke("app:logs-get", 500))?.entries || [];
    const text = all
      .map((e) => {
        const ts = new Date(e.at).toISOString();
        const meta = e.meta ? " " + JSON.stringify(e.meta) : "";
        return `[${ts}] [${e.level}] ${e.msg}${meta}`;
      })
      .join("\n");
    copy(text || "(empty)");
  };
  $("#btn-log-reveal").onclick = () => api.invoke("app:logs-reveal");
  $("#btn-log-clear").onclick = async () => {
    await api.invoke("app:logs-clear");
    renderLogs();
  };
}

function renderSettings() {
  if (blockSensitiveRenderIfLocked()) return;
  const keys = state.apiKeys || [];
  const bindAll = state.bindHost === "0.0.0.0";
  const update = state.update || { status: "idle", currentVersion: state.appVersion };
  const showDesktopSettings = state.runtime !== "headless";
  const updateUi = {
    idle: {
      copy: "Check for signed releases without leaving ReRouted.",
      label: "Check now",
    },
    checking: { copy: "Looking for a newer release…", label: "Checking…", disabled: true },
    current: {
      copy: "You’re running the latest release.",
      label: "Check again",
    },
    downloading: {
      copy: "A new release is downloading securely in the background.",
      label: "Downloading…",
      disabled: true,
    },
    ready: {
      copy: `${update.version ? `Version ${update.version}` : "The update"} is ready. Restart to install it.`,
      label: "Restart & install",
      primary: true,
    },
    installing: { copy: "Restarting to install the update…", label: "Restarting…", disabled: true },
    error: {
      copy: update.error || "ReRouted couldn’t reach the update service.",
      label: "Try again",
    },
    unsupported: {
      copy: update.error || "Updates are available in signed release builds.",
      label: "Unavailable",
      disabled: true,
    },
  }[update.status] || { copy: "Check for signed releases.", label: "Check now" };
  view.innerHTML = `
    ${pageHeader("Control", "Settings", "Configure startup, network exposure, credentials, and local security.")}
    ${showDesktopSettings ? sectionHeader("General") : ""}
    ${showDesktopSettings ? `<section class="settings-group">
      <div class="settings-row">
        <div class="settings-copy"><div class="row-title">Open at login</div><div class="row-sub">Keep the local gateway ready after sign-in.</div></div>
        <label class="toggle"><input type="checkbox" id="tog-login" ${state.openAtLogin ? "checked" : ""} /><span></span></label>
      </div>
    </section>` : ""}
    ${sectionHeader("Gateway", state.serverListening ? "Online" : "Offline")}
    <section class="settings-group">
      <div class="settings-row">
        <div class="settings-copy"><div class="row-title">Serve the gateway</div><div class="row-sub">Accept supported chat-completions requests on <span class="mono">/v1</span>.</div></div>
        <label class="toggle"><input type="checkbox" id="tog-srv" ${state.serverEnabled ? "checked" : ""} /><span></span></label>
      </div>
      <div class="settings-row">
        <div class="settings-copy"><div class="row-title">LAN and Tailscale access</div><div class="row-sub">Allow other devices to reach port ${esc(state.port)}.</div>${bindAll ? '<div class="risk-note">This exposes the gateway beyond localhost. Keep API keys enabled and share them carefully.</div>' : ""}</div>
        <label class="toggle"><input type="checkbox" id="tog-bind" ${bindAll ? "checked" : ""} /><span></span></label>
      </div>
      <div class="settings-row"><div class="settings-copy"><div class="row-title">Endpoint</div><div class="row-sub mono">${esc(state.endpoint)}</div></div><button type="button" class="btn btn-secondary btn-sm" id="copy-settings-url">Copy</button></div>
    </section>
    ${sectionHeader("API keys", `${keys.filter((key) => key.enabled !== false).length} active`)}
    <section class="settings-group">
      ${
        keys.length
          ? keys
              .map(
                (k) => `
        <div class="settings-row stack">
          <div class="settings-row" style="padding:0;border:0;min-height:36px">
            <div class="settings-copy"><div class="row-title">${esc(k.name)}</div><div class="row-sub mono">${esc(maskSecret(k.key))}</div></div>
            <label class="toggle"><input type="checkbox" data-key-en="${esc(k.id)}" ${k.enabled !== false ? "checked" : ""} /><span></span></label>
          </div>
          ${secretHtml(k.key, `set-key-${k.id}`)}
          <div class="action-row"><button type="button" class="btn btn-danger btn-sm" data-key-del="${esc(k.id)}">Revoke key</button></div>
        </div>`
              )
              .join("")
          : `<div class="settings-row"><div class="row-sub">No gateway keys configured.</div></div>`
      }
      <div class="settings-row stack"><div class="label">Create a key</div><input class="input" id="new-key-name" placeholder="Key name (for example, MacBook Pro)" /><button type="button" class="btn btn-primary" id="btn-new-key">Create key</button></div>
    </section>
    ${sectionHeader("Security")}
    <section class="settings-group">
      <div class="settings-row stack"><div class="row-title">Change admin password</div><div class="row-sub" style="margin-bottom:9px">${showDesktopSettings ? "Used only when the active Mac session cannot unlock the panel." : "Required to unlock this dashboard in a new browser session."}</div>
      <input class="input" id="pw-cur" type="password" placeholder="Current password" />
      <input class="input" id="pw-new" type="password" placeholder="New password" />
      <button type="button" class="btn btn-secondary" id="btn-pw">Update password</button>
      </div>
    </section>
    ${sectionHeader("Application", `ReRouted ${state.appVersion || ""}`)}
    <section class="settings-group">
      <div class="settings-row update-row"><div class="settings-copy"><div class="row-title">Software updates</div><div class="row-sub">${esc(updateUi.copy)}</div></div>${showDesktopSettings ? `<button type="button" class="btn ${updateUi.primary ? "btn-primary" : "btn-secondary"} btn-sm" id="btn-update" ${updateUi.disabled ? "disabled" : ""}>${esc(updateUi.label)}</button>` : ""}</div>
      ${showDesktopSettings ? '<div class="settings-row"><div class="settings-copy"><div class="row-title">Quit ReRouted</div><div class="row-sub">Stops the menu bar app and local gateway.</div></div><button type="button" class="btn btn-danger btn-sm" id="btn-quit">Quit</button></div>' : ""}
    </section>
    <div class="publisher-note"><button type="button" id="btn-product-site">ReRouted.dev</button> &middot; Independent personal project.</div>
  `;
  wireSecrets();
  $("#copy-settings-url").onclick = () => copy(state.endpoint);
  if ($("#tog-login")) {
    $("#tog-login").onchange = async (e) => {
      await api.invoke("app:set-open-at-login", e.target.checked);
    };
  }
  $("#tog-srv").onchange = async (e) => {
    await api.invoke("app:set-server-enabled", e.target.checked);
    await refresh();
  };
  $("#tog-bind").onchange = async (e) => {
    const r = await api.invoke("app:set-bind-host", e.target.checked ? "0.0.0.0" : "127.0.0.1");
    toast(r.ok ? (e.target.checked ? "Listening on all interfaces" : "Localhost only") : r.error || "Restart failed");
    await refresh();
    renderSettings();
  };
  view.querySelectorAll("input[data-key-en]").forEach((el) => {
    el.onchange = async () => {
      await api.invoke("app:set-api-key-enabled", { id: el.dataset.keyEn, enabled: el.checked });
      await refresh();
    };
  });
  view.querySelectorAll("button[data-key-del]").forEach((btn) => {
    btn.onclick = async () => {
      if (armDelete !== btn.dataset.keyDel) {
        armDelete = btn.dataset.keyDel;
        btn.textContent = "Sure?";
        return;
      }
      armDelete = null;
      await api.invoke("app:revoke-api-key", btn.dataset.keyDel);
      toast("Revoked");
      await refresh();
      renderSettings();
    };
  });
  $("#btn-new-key").onclick = async () => {
    const r = await api.invoke("app:create-api-key", $("#new-key-name").value.trim());
    if (r.ok) toast("Key created");
    await refresh();
    renderSettings();
  };
  $("#btn-pw").onclick = async () => {
    const r = await api.invoke("app:change-admin-password", {
      current: $("#pw-cur").value,
      next: $("#pw-new").value,
    });
    toast(r.ok ? "Password updated" : r.error || "Failed");
  };
  if ($("#btn-update")) $("#btn-update").onclick = async () => {
    const current = state.update?.status;
    const result = await api.invoke(
      current === "ready" ? "app:update-install" : "app:update-check"
    );
    if (result?.update) state.update = result.update;
    if (!result?.ok && result?.error) toast(result.error);
    if (page === "settings") render();
  };
  if ($("#btn-quit")) $("#btn-quit").onclick = () => api.invoke("app:quit");
  $("#btn-product-site").onclick = () =>
    api.invoke("app:open-external", "https://rerouted.dev");
}

function render() {
  if (!state) return;
  disposeProviderPanel({ clear: false });
  updateChrome();
  const onboarded = state.onboardingComplete;
  nav.hidden = !onboarded;
  stopPoll();

  if (!onboarded) {
    let step = state.onboardingStep || "permissions";
    const map = {
      permissions: renderPermissions,
      "admin-password": renderAdminPassword,
      welcome: renderWelcome,
      "oauth-providers": renderOauthProviders,
      "api-keys": renderApiKeys,
      "endpoint-ready": renderEndpointReady,
      tutorial: renderTutorial,
      "first-combo": renderFirstCombo,
    };
    (map[step] || renderPermissions)();
    return;
  }

  if (!state.unlocked && state.hasAdminPassword) {
    nav.hidden = true;
    renderLock();
    return;
  }

  const navPage = page === "quota" ? "providers" : page === "logs" ? "stats" : page;
  nav.querySelectorAll(".nav-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.page === navPage);
  });

  if (page === "home") {
    renderHome();
    startPoll(async () => {
      await refresh();
      if (page === "home") {
        updateChrome();
        updateHome();
      }
    }, 2000);
  } else if (page === "providers") renderProviders();
  else if (page === "combos") renderCombos();
  else if (page === "quota") {
    renderQuota();
    initializeQuota();
    startPoll(updateQuotaCountdowns, 1000);
    startQuotaRefreshPoll();
  }
  else if (page === "stats") {
    renderStats();
    startPoll(async () => {
      if (page === "stats") await renderStats();
    }, 2500);
  } else if (page === "logs") {
    renderLogs();
    startPoll(async () => {
      if (page === "logs") await renderLogs();
    }, 2000);
  } else if (page === "settings") renderSettings();
  else renderHome();
}

// Nav
nav.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.onclick = () => {
    page = btn.dataset.page;
    if (page === "providers") {
      selectedProviderKey = null;
      expandedAccountId = null;
    }
    if (page !== "combos") comboDraft = null;
    render();
  };
});

closeButton.onclick = () => api.invoke("app:hide-panel");

api.on("app:session-lock-changed", async (session) => {
  if (state && session?.unlocked === false) {
    state.unlocked = false;
    render();
  }
  await refresh();
  render();
});

api.on("app:update-state", (update) => {
  if (!state) return;
  state.update = update;
  if (page === "settings") render();
});

api.on("app:request-activity", (activity) => {
  if (!state || !Array.isArray(activity?.active)) return;
  state.activeRequests = activity.active;
  if (page === "home") {
    drawLiveRequestPaths();
  }
});

api.on("app:provider-identities-updated", async () => {
  await refresh();
  if (quotaState?.accounts?.length) {
    quotaState.accounts = quotaState.accounts.map((account) => {
      const provider = (state.providers || []).find((item) => item.id === account.providerId);
      return provider
        ? {
            ...account,
            name: provider.name,
            email: provider.email,
            profileName: provider.profileName,
            accountAlias: provider.accountAlias,
          }
        : account;
    });
  }
  if (page === "providers" || page === "quota") render();
});

api.on("app:open-settings", () => {
  if (!state?.onboardingComplete) return;
  page = "settings";
  render();
});

// Boot + harness hooks
async function boot() {
  await refresh();
  render();
}
window.__rr_boot = boot;
window.__rr_render = render;
window.__rr_goto_page = (p) => {
  page = p;
  if (page === "providers") {
    selectedProviderKey = null;
    expandedAccountId = null;
  }
  render();
};
window.addEventListener("resize", () => queueLiveRequestPaths(true));
boot();
