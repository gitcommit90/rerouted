"use strict";

const { KEYED_PRESETS } = require("../lib/constants");

const OAUTH_NOTICE =
  "Subscription OAuth sessions are not officially licensed for router use and may carry account risk.";

function publicModelOptions(state) {
  const options = [];
  for (const provider of state.providers || []) {
    if (provider.enabled === false) continue;
    for (const model of provider.models || []) {
      if (model.enabled === false) continue;
      options.push({
        label: `${provider.name}${provider.accountAlias ? ` · ${provider.accountAlias}` : ""}: ${model.name || model.id}`,
        providerId: provider.id,
        model: model.id,
      });
    }
  }
  return options;
}

async function createPassword(prompts, invoke, output) {
  while (true) {
    const password = await prompts.secret("Create an admin password (4+ characters)", { required: true });
    const confirm = await prompts.secret("Confirm admin password", { required: true });
    if (password !== confirm) {
      output.write("Passwords do not match. Try again.\n");
      continue;
    }
    const result = await invoke("app:set-admin-password", password);
    if (result.ok) return;
    output.write(`${result.error || "Could not save password"}\n`);
  }
}

async function importDetected(prompts, invoke, output) {
  if (!(await prompts.confirm("Scan this machine for supported provider credentials?"))) return;
  output.write("Scanning local credential files…\n");
  const result = await invoke("app:detect-providers");
  const found = result.found || [];
  if (!found.length) {
    output.write("No supported credentials were found.\n");
    return;
  }
  const indexes = await prompts.multiSelect(
    "Import detected accounts",
    found.map((item) => ({
      label: `${item.name || item.type}${item.email ? ` · ${item.email}` : ""} (${item.source})`,
    })),
    { defaultAll: true }
  );
  if (!indexes.length) return;
  await invoke("app:import-detected", indexes.map((index) => found[index].id));
  output.write(`Imported ${indexes.length} account${indexes.length === 1 ? "" : "s"}.\n`);
}

async function connectOauth(prompts, invoke, output) {
  output.write(`\n${OAUTH_NOTICE}\n`);
  while (await prompts.confirm("Connect an OAuth subscription account now?", { defaultValue: false })) {
    const state = await invoke("app:get-state");
    const providers = state.oauthProviders || [];
    const index = await prompts.select(
      "OAuth provider",
      providers.map((provider) => provider.name)
    );
    const type = providers[index].id;
    const started = await invoke("app:oauth-start", type);
    if (!started.ok) {
      output.write(`Could not start OAuth: ${started.error}\n`);
      continue;
    }
    output.write(`\nOpen this URL in a browser:\n${started.authUrl}\n\n`);
    const code = await prompts.text(
      "Paste the callback URL/code, or press Enter after the browser returns automatically"
    );
    const completed = await invoke("app:oauth-complete", {
      type,
      pasteCode: code || undefined,
    });
    if (completed.ok) output.write(`Connected ${completed.account.name}.\n`);
    else output.write(`Could not connect: ${completed.error}\n`);
  }
}

async function addKeyedProvider(prompts, invoke, output) {
  while (await prompts.confirm("Add an API-key provider now?", { defaultValue: false })) {
    const presets = [...Object.values(KEYED_PRESETS), { id: "custom", name: "Custom OpenAI-compatible" }];
    const index = await prompts.select("API-key provider", presets.map((preset) => preset.name));
    const preset = presets[index];
    const custom = preset.id === "custom";
    const name = custom
      ? await prompts.text("Connection name", { required: true })
      : preset.name;
    const accountId = preset.needsAccountId
      ? await prompts.text("Cloudflare account ID", { required: true })
      : "";
    const baseUrl = custom
      ? await prompts.text("Base URL (https://…/v1)", { required: true })
      : preset.baseUrl.replace("{account_id}", accountId);
    const apiKey = await prompts.secret("API key", { required: true });
    const explicitModel = custom
      ? await prompts.text("Exact model ID if /models is unavailable (optional)")
      : "";
    output.write("Testing connection and discovering models…\n");
    const tested = await invoke("app:test-keyed-provider", {
      providerType: custom ? "openai-compat" : preset.id,
      baseUrl,
      apiKey,
      modelId: explicitModel,
    });
    if (!tested.ok) {
      output.write(`Connection failed: ${tested.error}\n`);
      continue;
    }
    const added = await invoke("app:add-keyed-provider", {
      preset: custom ? null : preset.id,
      name,
      baseUrl,
      apiKey,
      accountId,
      models: (tested.models || []).map((model) => ({
        ...(typeof model === "string" ? { id: model, name: model } : model),
        enabled: true,
      })),
    });
    if (added.ok) output.write(`Added ${name} with ${(tested.models || []).length} model(s).\n`);
    else output.write(`Could not add provider: ${added.error}\n`);
  }
}

async function createRoute(prompts, invoke, output) {
  const state = await invoke("app:get-state");
  const models = publicModelOptions(state);
  if (!models.length) {
    output.write("No provider models are available yet. Add them later from the dashboard.\n");
    return;
  }
  if (!(await prompts.confirm("Create your first named route?"))) return;
  const name = await prompts.text("Route/model ID", { defaultValue: "coding", required: true });
  const strategyIndex = await prompts.select("Routing strategy", ["Fallback", "Round robin"]);
  const indexes = await prompts.multiSelect(
    "Route members (selection order is preserved)",
    models.map((model) => model.label)
  );
  if (!indexes.length) {
    output.write("Route skipped because no models were selected.\n");
    return;
  }
  const result = await invoke("app:save-combo", {
    name,
    strategy: strategyIndex === 1 ? "round-robin" : "fallback",
    members: indexes.map((index) => ({
      providerId: models[index].providerId,
      model: models[index].model,
    })),
  });
  if (result.ok) output.write(`Created route ${name}.\n`);
  else output.write(`Could not create route: ${result.error}\n`);
}

async function runFirstSetup({ prompts, controlPlane, dashboardUrl, output = process.stdout }) {
  const invoke = (channel, ...args) =>
    controlPlane.invoke(channel, args, { harness: true });
  const initial = await invoke("app:get-state");
  if (initial.onboardingComplete) return false;

  output.write("\nReRouted headless setup\n");
  output.write("One local gateway for your provider accounts, keys, and named routes.\n");
  output.write(`The same setup is also available at ${dashboardUrl}\n\n`);

  await invoke("app:set-onboarding-step", "admin-password");
  await createPassword(prompts, invoke, output);
  await invoke("app:set-onboarding-step", "auto-detect");
  await importDetected(prompts, invoke, output);
  await invoke("app:set-onboarding-step", "oauth-providers");
  await connectOauth(prompts, invoke, output);
  await invoke("app:set-onboarding-step", "api-keys");
  await addKeyedProvider(prompts, invoke, output);
  await invoke("app:set-onboarding-step", "first-combo");
  await createRoute(prompts, invoke, output);
  await invoke("app:complete-onboarding");
  output.write("\nSetup complete. ReRouted will keep running until you press Ctrl+C.\n");
  return true;
}

module.exports = { runFirstSetup, publicModelOptions };
