"use strict";

const api = window.rerouted;
const $ = (sel, el = document) => el.querySelector(sel);
const view = $("#view");
const nav = $("#nav");
const toastEl = $("#toast");

let state = null;
let page = "home";
let toastTimer = null;
let armDelete = null;

function toast(msg) {
  toastEl.hidden = false;
  toastEl.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, 2200);
}

async function refresh() {
  state = await api.invoke("app:get-state");
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
};

function providerLabel(type) {
  return PROVIDER_LABELS[type] || String(type || "Provider");
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
  return String(combo?.name || combo?.id || "route");
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

const PASTE_CODE_PLACEHOLDER = "Paste code if prompted";

function stepProgress(step) {
  const steps = state.steps || [];
  const idx = Math.max(0, steps.indexOf(step));
  const dots = steps
    .slice(0, -1)
    .map((_, i) => `<div class="step-dot ${i <= idx ? "on" : ""}"></div>`)
    .join("");
  return `<div class="steps">${dots}</div>`;
}

// ─── Onboarding screens ───────────────────────────────────────────────

function renderPermissions() {
  view.innerHTML = `
    ${stepProgress("permissions")}
    <h1 class="h1">Permissions</h1>
    <p class="lead">ReRouted runs in your menu bar and serves a local API on this Mac only. Enable open at login so the endpoint is ready when you need it. Importing local credentials may prompt for macOS Keychain access.</p>
    <div class="card">
      <div class="toggle-row">
        <div>
          <div class="card-title">Open at Login</div>
          <div class="card-sub">Launch ReRouted when you sign in</div>
        </div>
        <label class="toggle"><input type="checkbox" id="tog-login" ${state.openAtLogin ? "checked" : ""} /><span></span></label>
      </div>
    </div>
    <div class="btn-row">
      <button type="button" class="btn btn-primary" id="btn-next">Continue</button>
    </div>
  `;
  $("#tog-login").onchange = async (e) => {
    await api.invoke("app:set-open-at-login", e.target.checked);
    await refresh();
  };
  $("#btn-next").onclick = () => goStep("admin-password");
}

function renderAdminPassword() {
  view.innerHTML = `
    ${stepProgress("admin-password")}
    <h1 class="h1">Create admin password</h1>
    <p class="lead">This password protects the settings panel on this Mac. It is stored as a scrypt hash — never sent anywhere.</p>
    <input class="input" id="pw1" type="password" placeholder="Password" autocomplete="new-password" />
    <input class="input" id="pw2" type="password" placeholder="Confirm password" autocomplete="new-password" />
    <div class="btn-row">
      <button type="button" class="btn btn-primary" id="btn-next">Continue</button>
    </div>
  `;
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
    <h1 class="h1">Every model.<br />One clean route.</h1>
    <p class="lead">Connect subscriptions and API keys once. ReRouted presents a single local endpoint and moves traffic when an account runs out.</p>
    <section class="hero-surface">
      <div class="gateway-state"><span class="status-node"></span>Runs on this Mac</div>
      <div class="route-map" aria-hidden="true"><span class="route-source">C</span><span class="route-track"></span><span class="route-source">G</span><span class="route-track"></span><span class="route-destination">/v1</span></div>
      <div class="hero-sub">Claude · ChatGPT · Gemini · Grok · API keys</div>
    </section>
    <div class="btn-row">
      <button type="button" class="btn btn-primary" id="btn-next">Continue</button>
    </div>
  `;
  $("#btn-next").onclick = () => goStep("auto-detect");
}

function renderAutoDetect() {
  view.innerHTML = `
    ${stepProgress("auto-detect")}
    <h1 class="h1">Auto-detect providers?</h1>
    <p class="lead">ReRouted can import supported credentials already stored on this Mac so you can skip another sign-in. Tokens stay local.</p>
    <div class="btn-row">
      <button type="button" class="btn btn-secondary" id="btn-skip">Skip</button>
      <button type="button" class="btn btn-primary" id="btn-scan">Scan this Mac</button>
    </div>
    <div id="detect-results"></div>
  `;
  $("#btn-skip").onclick = () => goStep("oauth-providers");
  $("#btn-scan").onclick = async () => {
    const box = $("#detect-results");
    box.innerHTML = `<p class="lead">Scanning…</p>`;
    const r = await api.invoke("app:detect-providers");
    const found = r.found || [];
    if (!found.length) {
      box.innerHTML = `<div class="card"><div class="card-sub">Nothing found. You can connect providers next.</div></div>
        <div class="btn-row"><button type="button" class="btn btn-primary" id="btn-next">Continue</button></div>`;
      $("#btn-next").onclick = () => goStep("oauth-providers");
      return;
    }
    box.innerHTML = `
      <p class="label">Found ${found.length}</p>
      <div class="check-list" id="det-list">
        ${found
          .map(
            (f) => `
          <label class="check-item">
            <input type="checkbox" checked data-id="${esc(f.id)}" />
            <div>
              <div class="card-title">${esc(f.name)}</div>
              <div class="card-sub">${esc(f.type)} · ${esc(f.source)}${f.email ? " · " + esc(f.email) : ""}</div>
            </div>
          </label>`
          )
          .join("")}
      </div>
      <div class="btn-row">
        <button type="button" class="btn btn-primary" id="btn-import">Import selected</button>
      </div>`;
    $("#btn-import").onclick = async () => {
      const ids = [...view.querySelectorAll("#det-list input:checked")].map((el) => el.dataset.id);
      await api.invoke("app:import-detected", ids);
      toast(`Imported ${ids.length}`);
      goStep("oauth-providers");
    };
  };
}

function renderOauthProviders() {
  const done = new Set((state.providers || []).map((p) => p.type));
  const list = state.oauthProviders || [];
  view.innerHTML = `
    ${stepProgress("oauth-providers")}
    <h1 class="h1">Connect OAuth providers</h1>
    <p class="lead">Click a provider to sign in with your browser. Multiple accounts per provider are supported — connect again to add another.</p>
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
      <button type="button" class="btn btn-primary" id="btn-next">Continue</button>
    </div>
  `;
  view.querySelectorAll(".tile").forEach((btn) => {
    btn.onclick = async () => {
      const type = btn.dataset.type;
      const panel = $("#oauth-panel");
      panel.innerHTML = `<div class="card"><div class="card-title">Signing in to ${esc(type)}…</div>
        <div class="card-sub">Complete login in your browser, then click I'm done.</div>
        <div class="btn-row" style="margin-top:10px">
          <button type="button" class="btn btn-secondary btn-sm" id="btn-reopen">Open browser again</button>
          <button type="button" class="btn btn-primary btn-sm" id="btn-done">I'm done</button>
        </div>
        <input class="input" id="paste-code" placeholder="${PASTE_CODE_PLACEHOLDER}" style="margin-top:10px" />
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
  $("#btn-next").onclick = () => goStep("api-keys");
}

function keyedProviderPickerHtml(presets) {
  return `<div class="provider-grid" data-keyed-preset-grid>
    ${presets
      .map(
        (preset) =>
          `<button type="button" class="tile" data-keyed-preset="${esc(preset.id)}" aria-pressed="false">${esc(preset.name)}</button>`
      )
      .join("")}
    <button type="button" class="tile" data-keyed-preset="custom" aria-pressed="false">Custom</button>
  </div>
  <div data-keyed-form></div>`;
}

function bindKeyedProviderPicker(root, { onAdded, successMessage = "Provider added" } = {}) {
  const presets = state.keyedPresets || [];
  root.querySelectorAll("[data-keyed-preset]").forEach((button) => {
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
      form.innerHTML = `
        <div class="card">
          <div class="label">${esc(isCustom ? "Custom provider" : preset.name)}</div>
          ${
            isCustom
              ? `<input class="input" data-keyed-field="name" placeholder="Name" />
                <input class="input" data-keyed-field="base" placeholder="Base URL (https://…/v1)" />`
              : ""
          }
          ${
            preset?.needsAccountId
              ? `<input class="input" data-keyed-field="account" placeholder="Cloudflare Account ID" />`
              : ""
          }
          <input class="input" data-keyed-field="key" type="password" placeholder="API key" />
          <div class="btn-row">
            <button type="button" class="btn btn-secondary btn-sm" data-keyed-action="test">Fetch models / Test</button>
            <button type="button" class="btn btn-primary btn-sm" data-keyed-action="add" disabled>Add</button>
          </div>
          <div class="model-test-status" data-keyed-status hidden></div>
          <button type="button" class="btn btn-secondary btn-sm" data-keyed-copy-error hidden>Copy full error</button>
        </div>`;
      requestAnimationFrame(() => form.scrollIntoView({ behavior: "smooth", block: "nearest" }));

      const field = (name) => $(`[data-keyed-field="${name}"]`, form);
      const testButton = $("[data-keyed-action='test']", form);
      const addButton = $("[data-keyed-action='add']", form);
      const status = $("[data-keyed-status]", form);
      const copyError = $("[data-keyed-copy-error]", form);
      const accountId = () => field("account")?.value?.trim() || "";
      const baseUrl = () =>
        isCustom
          ? field("base").value.trim()
          : (preset.baseUrl || "").replace("{account_id}", accountId());
      const inputs = [...form.querySelectorAll("[data-keyed-field]")];
      const fingerprint = () =>
        JSON.stringify([presetId, baseUrl(), field("key").value.trim(), accountId()]);
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
      inputs.forEach((input) => input.addEventListener("input", invalidateTest));

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
            baseUrl: baseUrl(),
            apiKey: field("key").value.trim(),
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
        status.textContent = `OK — ${models.length} models`;
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
            models: models.slice(0, 50).map((model) =>
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
}

function renderApiKeys() {
  const presets = state.keyedPresets || [];
  view.innerHTML = `
    ${stepProgress("api-keys")}
    <h1 class="h1">Add an API key</h1>
    <p class="lead">Optional. Quick-add a known OpenAI-compatible provider, or enter a custom base URL. Custom providers must pass Fetch models before Add.</p>
    ${keyedProviderPickerHtml(presets)}
    <div class="btn-row">
      <button type="button" class="btn btn-secondary" id="btn-skip">Skip</button>
      <button type="button" class="btn btn-primary" id="btn-next">Continue</button>
    </div>
  `;
  $("#btn-skip").onclick = () => goStep("endpoint-ready");
  $("#btn-next").onclick = () => goStep("endpoint-ready");
  bindKeyedProviderPicker(view);
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
      <button type="button" class="btn btn-primary" id="btn-next">I've saved this</button>
    </div>
  `;
  $("#copy-url").onclick = () => copy(state.endpoint);
  wireSecrets();
  $("#btn-next").onclick = () => goStep("tutorial");
}

let tutorialPage = 0;
const TUTORIAL = [
  {
    t: "What is ReRouted?",
    b: "A local gateway. Your editors and agents send OpenAI-style chat completions to localhost; ReRouted talks to ChatGPT, Claude, Antigravity, xAI, and OpenAI-compatible APIs behind the scenes.",
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
      ${tutorialPage > 0 ? `<button type="button" class="btn btn-secondary" id="btn-back">Back</button>` : ""}
      <button type="button" class="btn btn-primary" id="btn-next">${tutorialPage < TUTORIAL.length - 1 ? "Next" : "Continue"}</button>
    </div>
  `;
  if ($("#btn-back"))
    $("#btn-back").onclick = () => {
      tutorialPage--;
      renderTutorial();
    };
  $("#btn-next").onclick = () => {
    if (tutorialPage < TUTORIAL.length - 1) {
      tutorialPage++;
      renderTutorial();
    } else goStep("first-combo");
  };
}

function renderFirstCombo() {
  const models = flatModels();
  view.innerHTML = `
    ${stepProgress("first-combo")}
    <div class="eyebrow">First route</div>
    <h1 class="h1">Name the model your tools will use</h1>
    <p class="lead">Optional. This exact model ID appears in <span class="mono">/v1/models</span>; its members stay behind the scenes.</p>
    <input class="input" id="c-name" placeholder="Model ID (for example, coding)" value="coding" />
    <div class="seg" id="c-strat">
      <button type="button" data-s="fallback" class="active">Fallback</button>
      <button type="button" data-s="round-robin">Round-robin</button>
    </div>
    <div class="label">Members</div>
    <div class="member-pick">
      ${
        models.length
          ? models
              .map(
                (m) =>
                  `<label class="check-item"><input type="checkbox" data-pid="${esc(m.providerId)}" data-model="${esc(m.upstreamModel)}" /><div><div class="card-title ellip">${esc(m.name || m.upstreamModel)}</div><div class="card-sub mono">${esc(m.id)}</div></div></label>`
              )
              .join("")
          : `<div class="empty">No models yet — add a provider first.</div>`
      }
    </div>
    <div class="btn-row">
      <button type="button" class="btn btn-secondary" id="btn-skip">Skip</button>
      <button type="button" class="btn btn-primary" id="btn-create">Create route</button>
    </div>
  `;
  let strategy = "fallback";
  view.querySelectorAll("#c-strat button").forEach((b) => {
    b.onclick = () => {
      view.querySelectorAll("#c-strat button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      strategy = b.dataset.s;
    };
  });
  $("#btn-skip").onclick = () => finishOnboarding();
  $("#btn-create").onclick = async () => {
    const members = [...view.querySelectorAll(".member-pick input:checked")].map((el) => ({
      providerId: el.dataset.pid,
      model: el.dataset.model,
    }));
    const name = $("#c-name").value.trim();
    if (!name) return toast("Enter a model ID");
    if (!members.length) return toast("Pick at least one model");
    const result = await api.invoke("app:save-combo", {
      name,
      strategy,
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
      <p class="lead">Your Mac session normally unlocks this panel. Enter the admin password if the session state cannot be verified.</p>
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

function fmtTime(at) {
  if (!at) return "";
  try {
    return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "";
  }
}

function fmtNum(n) {
  const x = Number(n) || 0;
  if (x >= 1_000_000) return (x / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (x >= 10_000) return (x / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return x.toLocaleString();
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

function renderHome() {
  const s = state.stats || { totalRequests: 0, recent: [] };
  const recent = s.recent || [];
  const online = state.serverListening && state.serverEnabled;
  const last = recent[0];
  const lastLabel = last ? friendlyRoute(last.model) : "Waiting for first request";
  const u24 = state.usage || {};
  const tokenTotal =
    Number(u24.total_tokens) ||
    Number(u24.prompt_tokens || 0) + Number(u24.completion_tokens || 0) + Number(u24.cached_tokens || 0);
  const errorRate = u24.requests ? Math.round(((u24.errors || 0) / u24.requests) * 100) : 0;
  view.innerHTML = `
    ${pageHeader("Wayfinder", "Status", "One local endpoint. Every account and route behind it.")}
    <section class="hero-surface">
      <div class="gateway-state"><span class="status-node ${online ? "" : "off"}"></span>${online ? "Gateway live" : "Gateway stopped"}</div>
      <div class="hero-title">${esc(lastLabel)}</div>
      <div class="hero-sub">${last ? `${esc(last.providerName || last.providerType || "ReRouted")} · ${esc(fmtTime(last.at))}` : "Traffic will appear here as soon as a client connects."}</div>
      <div class="route-map" aria-hidden="true">
        <span class="route-source">A</span><span class="route-track"></span><span class="route-source">B</span><span class="route-track"></span><span class="route-destination">/v1</span>
      </div>
      <div class="endpoint-row"><code>${esc(state.endpoint)}</code><button type="button" class="btn btn-secondary btn-sm" id="copy-url">Copy</button></div>
    </section>
    <div class="metric-ribbon">
      <div class="metric"><div class="metric-value">${fmtNum(u24.requests || 0)}</div><div class="metric-label">Requests 24h</div></div>
      <div class="metric"><div class="metric-value">${fmtNum(tokenTotal)}</div><div class="metric-label">Tokens 24h</div></div>
      <div class="metric"><div class="metric-value">${errorRate}%</div><div class="metric-label">Error rate</div></div>
    </div>
    <details class="disclosure">
      <summary>Credentials and network</summary>
      <div class="disclosure-body">
        <div class="label">Gateway key</div>
        ${secretHtml(state.apiKey, "home-key")}
        <div class="card-sub">${esc(state.listenHint || "")}</div>
      </div>
    </details>
    ${sectionHeader("Traffic now", `${fmtNum(s.totalRequests || 0)} all time`)}
    <div class="group-list">
      ${
        recent.length
          ? recent
              .slice(0, 15)
              .map((r) => {
                const via = r.providerName || r.providerType || "";
                const tokens = (r.prompt_tokens || 0) + (r.completion_tokens || 0);
                const tone = Number(r.status) >= 400 ? "error" : "route";
                return `<div class="event-row">
                  <span class="event-dot ${tone}"></span>
                  <div class="event-main"><div class="event-title">${esc(friendlyRoute(r.model))}</div><div class="event-meta">${esc(via || "Local route")}${tokens ? ` · ${fmtNum(tokens)} tokens` : ""}${r.stream ? " · stream" : ""}</div></div>
                  <div class="event-time">${esc(fmtTime(r.at))}</div>
                </div>`;
              })
              .join("")
          : `<div class="empty">No traffic yet. Point a client at the local endpoint to see routing decisions here.</div>`
      }
    </div>
  `;
  $("#copy-url").onclick = () => copy(state.endpoint);
  wireSecrets();
}

const OAUTH_TYPES = new Set(["chatgpt", "codex", "claude", "antigravity", "xai"]);
let expandedProviderId = null;

function startOauthFlow({ type, providerId, onDone }) {
  const panel = $("#add-panel") || $("#oauth-panel");
  const box = document.createElement("div");
  box.className = "action-panel";
  const claudeHint =
    type === "claude"
      ? "After authorizing, paste the full localhost callback URL if the browser cannot return automatically."
      : "Most providers return automatically. Paste a code only if the provider shows one.";
  box.innerHTML = `<div class="action-panel-head"><div class="eyebrow">${providerId ? "Reconnect" : "New account"}</div><div class="action-panel-title">${esc(providerLabel(type))}</div><div class="action-panel-sub">Opening a secure browser session. ${esc(claudeHint)}</div></div>
    <div class="gateway-state"><span class="status-node"></span><span id="oauth-status-line">Starting OAuth…</span></div>
    <details class="disclosure" style="margin:10px 0 0">
      <summary>Having trouble?</summary>
      <div class="disclosure-body"><div class="label">Authorization URL</div><div class="auth-url-box" id="oauth-url-display">Starting…</div>
      <input class="input" id="paste-code-oauth" placeholder="${type === "claude" ? "Paste full localhost callback URL" : PASTE_CODE_PLACEHOLDER}" autocomplete="off" /></div>
    </details>
    <div class="btn-row">
      <button type="button" class="btn btn-secondary btn-sm" id="btn-copy-oauth-url">Copy URL</button>
      <button type="button" class="btn btn-secondary btn-sm" id="btn-reopen-oauth">Open browser</button>
      <button type="button" class="btn btn-secondary btn-sm" id="btn-oauth-logs">Logs</button>
    </div>
    <button type="button" class="btn btn-primary" id="btn-done-oauth">Finish connection</button>`;
  if (panel) {
    panel.innerHTML = "";
    panel.appendChild(box);
  } else {
    view.appendChild(box);
  }

  let lastAuthUrl = "";
  async function start() {
    const status = box.querySelector("#oauth-status-line");
    const disp = box.querySelector("#oauth-url-display");
    status.textContent = "Starting OAuth…";
    const r = await api.invoke("app:oauth-start", type);
    if (!r?.ok) {
      status.textContent = r?.error || "OAuth start failed — see Logs";
      status.style.color = "var(--danger)";
      toast(r?.error || "OAuth start failed");
      return;
    }
    lastAuthUrl = r.authUrl || "";
    disp.textContent = lastAuthUrl;
    status.textContent = r.needsPaste
      ? `Redirect: ${r.redirectUri || "—"} · after Authorize paste the full localhost callback URL`
      : `Redirect: ${r.redirectUri || "—"} · waiting for browser callback`;
  }
  start().catch((e) => toast(e.message || "OAuth start failed"));

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
      if (!r?.ok) {
        status.textContent = r?.error || "Failed — open Logs";
        toast(r?.error || "OAuth failed");
        return;
      }
      toast(r.account?.reauthed ? "Re-authorized" : "Connected");
      status.textContent = "Connected";
      if (onDone) await onDone(r);
    } catch (e) {
      status.textContent = e.message || "OAuth failed";
      toast(e.message || "OAuth failed");
    }
  };
}

function renderProviders() {
  const list = state.providers || [];
  view.innerHTML = `
    ${pageHeader("Sources", "Accounts", "Connect subscriptions and API keys, then choose exactly which models are available.", '<button type="button" class="btn btn-primary btn-sm" id="btn-connect">Connect</button>')}
    ${accountSubnav("providers")}
    ${
      list.length
        ? list
            .map((p) => {
              const open = expandedProviderId === p.id;
              const models = p.models || [];
              const onCount = models.filter((m) => m.enabled !== false).length;
              const glyphClass = OAUTH_TYPES.has(p.type) ? p.type : "keyed";
              const glyph = providerLabel(p.type).slice(0, 2).toUpperCase();
              return `
      <section class="account-card group-list" data-prov-card="${esc(p.id)}">
        <div class="account-head" data-expand="${esc(p.id)}">
          <div class="account-glyph ${esc(glyphClass)}">${esc(glyph)}</div>
          <div class="account-copy">
            <div class="row-title">${esc(p.name || providerLabel(p.type))}</div>
            <div class="row-sub">${p.email ? esc(p.email) : esc(providerLabel(p.type))} · ${onCount} of ${models.length} models enabled</div>
          </div>
          <div class="account-side">
            ${p.accountAlias ? `<span class="alias-badge">${esc(aliasLabel(p.accountAlias))}</span>` : ""}
            <label class="toggle" data-stop-expand="1"><input type="checkbox" data-en="${esc(p.id)}" ${p.enabled !== false ? "checked" : ""} /><span></span></label>
            <span class="chevron">${open ? "−" : "+"}</span>
          </div>
        </div>
        ${
          open
            ? `<div class="provider-detail">
          <div class="provider-meta-line"><span class="pill">${esc(providerLabel(p.type))}</span>${p.accountAlias ? `<span class="pill mono">${esc(p.accountAlias)}</span>` : ""}<span class="pill">${models.length} models</span></div>
          ${
            models.length
              ? models
                  .map(
                    (m) => `
            <div class="model-row">
              <div class="meta">
                <div class="row-title">${esc(m.name || m.id)}</div>
                <div class="model-id">${esc(m.gatewayId || m.id)}</div>
              </div>
              <label class="toggle" data-stop-expand="1"><input type="checkbox" data-model-en="${esc(p.id)}" data-mid="${esc(m.id)}" ${m.enabled !== false ? "checked" : ""} /><span></span></label>
            </div>`
                  )
                  .join("")
              : `<div class="empty">No models configured for this account.</div>`
          }
          <div class="label" style="margin-top:12px">Add exact model ID</div>
          <div class="copy-field"><input class="input" id="add-model-${esc(p.id)}" placeholder="provider-model-id" /><button type="button" class="btn btn-secondary btn-sm" data-add-model="${esc(p.id)}">Test &amp; add</button></div>
          <div class="model-test-status" id="add-model-status-${esc(p.id)}" hidden></div>
          <button type="button" class="btn btn-secondary btn-sm model-error-copy" data-copy-model-error="${esc(p.id)}" hidden>Copy full error</button>
          <div class="action-row">
            ${
              OAUTH_TYPES.has(p.type)
                ? `<button type="button" class="btn btn-secondary btn-sm" data-reauth="${esc(p.id)}" data-type="${esc(p.type === "codex" ? "chatgpt" : p.type)}">Reconnect</button>`
                : ""
            }
            <button type="button" class="btn btn-danger btn-sm" data-del="${esc(p.id)}">Disconnect</button>
          </div>
        </div>`
            : ""
        }
      </section>`;
            })
            .join("")
        : `<div class="empty">No accounts connected. Connect a subscription or API key to begin routing.</div>`
    }
    <div id="add-panel"></div>
  `;
  wireSubnav();
  // Toggles must not trigger card expand (and CSP blocks inline onclick)
  view.querySelectorAll("[data-stop-expand]").forEach((el) => {
    el.addEventListener("click", (e) => e.stopPropagation());
  });
  view.querySelectorAll("[data-expand]").forEach((el) => {
    el.onclick = (e) => {
      if (e.target.closest("[data-stop-expand], .toggle, input, button, label")) return;
      const id = el.dataset.expand;
      expandedProviderId = expandedProviderId === id ? null : id;
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
      expandedProviderId = pid;
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
  $("#btn-connect").onclick = () => {
    const listO = state.oauthProviders || [];
    $("#add-panel").innerHTML = `
      <div class="action-panel">
        <div class="action-panel-head"><div class="eyebrow">New source</div><div class="action-panel-title">Connect an account</div><div class="action-panel-sub">Use a subscription login or bring an OpenAI-compatible API key.</div></div>
        <div class="provider-grid">
        ${listO.map((p) => `<button type="button" class="tile" data-type="${esc(p.id)}">${esc(p.name)}</button>`).join("")}
        </div>
        <button type="button" class="btn btn-secondary" id="btn-key">Connect an API key</button>
      </div>
      <div id="oauth-panel"></div>`;
    view.querySelectorAll("#add-panel .tile").forEach((btn) => {
      btn.onclick = () => {
        startOauthFlow({
          type: btn.dataset.type,
          onDone: async () => {
            await refresh();
            renderProviders();
          },
        });
      };
    });
    $("#btn-key").onclick = () => {
      const panel = $("#add-panel");
      const presets = state.keyedPresets || [];
      panel.innerHTML = `
        <div class="action-panel">
          <div class="action-panel-head"><div class="eyebrow">API source</div><div class="action-panel-title">Connect an API key</div><div class="action-panel-sub">Choose a preset or bring any OpenAI-compatible endpoint. ReRouted tests it before adding its models.</div></div>
          ${keyedProviderPickerHtml(presets)}
        </div>`;
      bindKeyedProviderPicker(panel, {
        successMessage: "API source connected",
        onAdded: () => renderProviders(),
      });
    };
  };
}

function memberKey(m) {
  return `${m.providerId}::${m.model || m.upstreamModel}`;
}

let comboDraft = null;

function beginComboEdit(combo) {
  comboDraft = {
    id: combo?.storageId || combo?.id || null,
    name: combo?.name || "",
    strategy: combo?.strategy || "fallback",
    members: (combo?.members || []).map((member) => ({
      providerId: member.providerId,
      model: member.model || member.upstreamModel,
    })),
  };
  renderCombos();
}

function syncComboDraft() {
  if (!comboDraft) return;
  const name = $("#c-name");
  if (name) comboDraft.name = name.value;
}

function comboMemberInfo(member, models) {
  return models.find(
    (model) => model.providerId === member.providerId && model.upstreamModel === member.model
  );
}

function renderCombos() {
  const combos = state.combos || [];
  const models = flatModels();
  const editor = comboDraft;

  view.innerHTML = `
    ${pageHeader("Routing", "Routes", "Give clients one memorable model ID while ReRouted handles account and provider failover.", '<button type="button" class="btn btn-primary btn-sm" id="btn-new-route">New route</button>')}
    ${
      combos.length
        ? combos
            .map(
              (c) => `
      <section class="route-card">
        <div class="route-head">
          <div class="route-copy">
            <div class="route-name">${esc(comboRouteId(c))}</div>
            <div class="route-summary">${c.strategy === "round-robin" ? "Rotate every request" : "Fill in order, then fall back"} · ${(c.members || []).length} member${(c.members || []).length === 1 ? "" : "s"}</div>
            <div class="route-nodes">${(c.members || []).slice(0, 5).map((_, index) => `${index ? '<span class="route-node-line"></span>' : ""}<span class="route-node">${index + 1}</span>`).join("")}${(c.members || []).length > 5 ? '<span class="route-node-line"></span><span class="route-node">+</span>' : ""}</div>
          </div>
          <div class="action-row">
            <span class="strategy-badge">${esc(c.strategy)}</span>
            <button type="button" class="btn btn-secondary btn-sm" data-edit="${esc(c.storageId || c.id)}">Edit</button>
            <button type="button" class="btn btn-danger btn-sm" data-del="${esc(c.storageId || c.id)}">Delete</button>
          </div>
        </div>
      </section>`
            )
            .join("")
        : `<div class="empty">No routes yet. Create a memorable model ID and choose where requests should go.</div>`
    }
    ${
      editor
        ? `<section class="action-panel route-editor">
      <div class="action-panel-head"><div class="eyebrow">${editor.id ? "Edit route" : "New route"}</div><div class="action-panel-title">${editor.id ? esc(editor.name || "Route") : "Build a route"}</div><div class="action-panel-sub">The model ID below is what clients see in <span class="mono">/v1/models</span>.</div></div>
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
                  const info = comboMemberInfo(member, models);
                  return `<div class="member-row">
                    <div class="member-index">${index + 1}</div>
                    <div class="ellip"><div class="row-title">${esc(info?.name || member.model)}</div><div class="model-id">${esc(info?.id || member.model)}</div></div>
                    <div class="member-actions"><button type="button" data-member-up="${index}" title="Move up" ${index === 0 ? "disabled" : ""}>↑</button><button type="button" data-member-down="${index}" title="Move down" ${index === editor.members.length - 1 ? "disabled" : ""}>↓</button><button type="button" data-member-remove="${index}" title="Remove">×</button></div>
                  </div>`;
                })
                .join("")
            : `<div class="empty" style="margin:0;border:0">Add at least one model to this route.</div>`
        }
      </div>
      <div class="copy-field"><select class="select" id="c-add-model"><option value="">Choose an account and model…</option>${models.map((model, index) => `<option value="${index}">${esc(model.name)} · ${esc(model.upstreamModel)}</option>`).join("")}</select><button type="button" class="btn btn-secondary btn-sm" id="btn-add-member">Add</button></div>
      <div class="btn-row"><button type="button" class="btn btn-secondary" id="btn-cancel-edit">Cancel</button><button type="button" class="btn btn-primary" id="btn-create">${editor.id ? "Save route" : "Create route"}</button></div>
    </section>`
        : ""
    }
  `;
  $("#btn-new-route").onclick = () => beginComboEdit(null);
  view.querySelectorAll("button[data-edit]").forEach((btn) => {
    btn.onclick = () =>
      beginComboEdit(
        combos.find((combo) => (combo.storageId || combo.id) === btn.dataset.edit)
      );
  });
  view.querySelectorAll("button[data-del]").forEach((btn) => {
    btn.onclick = async () => {
      if (armDelete !== btn.dataset.del) {
        armDelete = btn.dataset.del;
        btn.textContent = "Sure?";
        return;
      }
      await api.invoke("app:delete-combo", btn.dataset.del);
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
      [editor.members[index - 1], editor.members[index]] = [editor.members[index], editor.members[index - 1]];
      renderCombos();
    };
  });
  view.querySelectorAll("[data-member-down]").forEach((button) => {
    button.onclick = () => {
      syncComboDraft();
      const index = Number(button.dataset.memberDown);
      [editor.members[index], editor.members[index + 1]] = [editor.members[index + 1], editor.members[index]];
      renderCombos();
    };
  });
  view.querySelectorAll("[data-member-remove]").forEach((button) => {
    button.onclick = () => {
      syncComboDraft();
      editor.members.splice(Number(button.dataset.memberRemove), 1);
      renderCombos();
    };
  });
  $("#btn-add-member").onclick = () => {
    syncComboDraft();
    const value = $("#c-add-model").value;
    if (value === "") return toast("Choose a model");
    const index = Number(value);
    const model = models[index];
    if (!model) return toast("Choose a model");
    const member = { providerId: model.providerId, model: model.upstreamModel };
    if (editor.members.some((item) => memberKey(item) === memberKey(member))) {
      return toast("That model is already in the route");
    }
    editor.members.push(member);
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
}

let statsPeriod = "24h";
let statsRenderRequest = 0;
let logsRenderRequest = 0;
let pollTimer = null;
let quotaState = null;
let quotaLoading = false;
let quotaInitialized = false;

function stopPoll() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
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
  const identity = account.name || providerLabel(account.type);
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
        <div class="row-sub">${account.email ? `${esc(account.email)} · ` : ""}${esc(account.plan || providerLabel(account.type))}</div>
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
  if (quotaInitialized) return;
  quotaInitialized = true;
  try {
    const r = await api.invoke("app:quota-get");
    if (r?.ok) quotaState = r.quota;
  } catch {
    /* the refresh path below will surface provider-specific errors */
  }
  if (page === "quota") renderQuota();
  if (!quotaState?.refreshedAt) await refreshQuota();
}

function renderQuota() {
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
  if (page !== "stats" || requestId !== statsRenderRequest) return;
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
  if (page !== "logs" || requestId !== logsRenderRequest) return;
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
  const keys = state.apiKeys || [];
  const bindAll = state.bindHost === "0.0.0.0";
  const update = state.update || { status: "idle", currentVersion: state.appVersion };
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
    ${sectionHeader("General")}
    <section class="settings-group">
      <div class="settings-row">
        <div class="settings-copy"><div class="row-title">Open at login</div><div class="row-sub">Keep the local gateway ready after sign-in.</div></div>
        <label class="toggle"><input type="checkbox" id="tog-login" ${state.openAtLogin ? "checked" : ""} /><span></span></label>
      </div>
    </section>
    ${sectionHeader("Gateway", state.serverListening ? "Online" : "Offline")}
    <section class="settings-group">
      <div class="settings-row">
        <div class="settings-copy"><div class="row-title">Serve the gateway</div><div class="row-sub">Accept OpenAI-compatible requests on <span class="mono">/v1</span>.</div></div>
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
      <div class="settings-row stack"><div class="row-title">Change admin password</div><div class="row-sub" style="margin-bottom:9px">Used only when the active Mac session cannot unlock the panel.</div>
      <input class="input" id="pw-cur" type="password" placeholder="Current password" />
      <input class="input" id="pw-new" type="password" placeholder="New password" />
      <button type="button" class="btn btn-secondary" id="btn-pw">Update password</button>
      </div>
    </section>
    ${sectionHeader("Application", `ReRouted ${state.appVersion || ""}`)}
    <section class="settings-group">
      <div class="settings-row update-row"><div class="settings-copy"><div class="row-title">Software updates</div><div class="row-sub">${esc(updateUi.copy)}</div></div><button type="button" class="btn ${updateUi.primary ? "btn-primary" : "btn-secondary"} btn-sm" id="btn-update" ${updateUi.disabled ? "disabled" : ""}>${esc(updateUi.label)}</button></div>
      <div class="settings-row"><div class="settings-copy"><div class="row-title">Quit ReRouted</div><div class="row-sub">Stops the menu bar app and local gateway.</div></div><button type="button" class="btn btn-danger btn-sm" id="btn-quit">Quit</button></div>
    </section>
    <div class="publisher-note"><button type="button" id="btn-product-site">ReRouted.dev</button> &middot; Released by <button type="button" id="btn-public-bytes">Public Bytes</button>.</div>
  `;
  wireSecrets();
  $("#copy-settings-url").onclick = () => copy(state.endpoint);
  $("#tog-login").onchange = async (e) => {
    await api.invoke("app:set-open-at-login", e.target.checked);
  };
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
  $("#btn-update").onclick = async () => {
    const current = state.update?.status;
    const result = await api.invoke(
      current === "ready" ? "app:update-install" : "app:update-check"
    );
    if (result?.update) state.update = result.update;
    if (!result?.ok && result?.error) toast(result.error);
    if (page === "settings") renderSettings();
  };
  $("#btn-quit").onclick = () => api.invoke("app:quit");
  $("#btn-product-site").onclick = () =>
    api.invoke("app:open-external", "https://rerouted.dev");
  $("#btn-public-bytes").onclick = () =>
    api.invoke("app:open-external", "https://publicbytes.org");
}

function render() {
  if (!state) return;
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
      "auto-detect": renderAutoDetect,
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
      if (page === "home") renderHome();
    }, 2000);
  } else if (page === "providers") renderProviders();
  else if (page === "combos") renderCombos();
  else if (page === "quota") {
    renderQuota();
    initializeQuota();
    startPoll(updateQuotaCountdowns, 1000);
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
    if (page !== "combos") comboDraft = null;
    render();
  };
});

$("#btn-close").onclick = () => api.invoke("app:hide-panel");

api.on("app:session-lock-changed", async () => {
  await refresh();
  render();
});

api.on("app:update-state", (update) => {
  if (!state) return;
  state.update = update;
  if (page === "settings") renderSettings();
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
  render();
};
boot();
