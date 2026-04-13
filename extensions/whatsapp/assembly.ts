import {
  defineBundledChannelEntry,
  defineBundledChannelSetupEntry,
} from "openclaw/plugin-sdk/channel-entry-contract";
import {
  createDelegatedSetupWizardProxy,
  type ChannelSetupWizard,
} from "openclaw/plugin-sdk/setup-runtime";

type WhatsAppRuntimeAssembly = typeof import("./src/runtime-api.js");

export const whatsappAssembly = {
  id: "whatsapp",
  name: "WhatsApp",
  description: "WhatsApp channel plugin",
  entry: {
    plugin: {
      specifier: "./channel-plugin-api.js",
      exportName: "whatsappPlugin",
    },
    runtime: {
      specifier: "./runtime-api.js",
      exportName: "setWhatsAppRuntime",
    },
  },
  setupEntry: {
    plugin: {
      specifier: "./setup-plugin-api.js",
      exportName: "whatsappSetupPlugin",
    },
  },
  package: {
    entrySources: ["./index.ts"],
    setupEntrySource: "./setup-entry.ts",
    persistedAuthState: {
      specifier: "./auth-presence",
      exportName: "hasAnyWhatsAppAuth",
    },
    packagedArtifacts: [
      "assembly.js",
      "auth-presence.js",
      "channel-plugin-api.js",
      "index.js",
      "light-runtime-api.js",
      "login-qr-runtime.js",
      "package.json",
      "runtime-api.js",
      "setup-entry.js",
      "setup-plugin-api.js",
    ],
  },
  runtime: {
    sharedExportNames: [
      "getActiveWebListener",
      "getWebAuthAgeMs",
      "logWebSelfId",
      "logoutWeb",
      "monitorWebChannel",
      "readWebSelfId",
      "startWebLoginWithQr",
      "waitForWebLogin",
      "webAuthExists",
      "whatsappSetupWizard",
    ],
  },
} as const;

let runtimeAssemblyPromise: Promise<WhatsAppRuntimeAssembly> | null = null;

export function loadWhatsAppChannelRuntime(): Promise<WhatsAppRuntimeAssembly> {
  runtimeAssemblyPromise ??= import("./src/runtime-api.js");
  return runtimeAssemblyPromise;
}

export const whatsappSetupWizardProxy = createDelegatedSetupWizardProxy({
  channel: whatsappAssembly.id,
  loadWizard: async (): Promise<ChannelSetupWizard> =>
    (await loadWhatsAppChannelRuntime()).whatsappSetupWizard,
  status: {
    configuredLabel: "linked",
    unconfiguredLabel: "not linked",
    configuredHint: "linked",
    unconfiguredHint: "not linked",
    configuredScore: 5,
    unconfiguredScore: 4,
  },
  resolveShouldPromptAccountIds: (params) => params.shouldPromptAccountIds,
  credentials: [],
  delegateFinalize: true,
  disable: (cfg) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      whatsapp: {
        ...cfg.channels?.whatsapp,
        enabled: false,
      },
    },
  }),
  onAccountRecorded: (accountId, options) => {
    options?.onAccountId?.(whatsappAssembly.id, accountId);
  },
});

export function defineWhatsAppBundledChannelEntry(importMetaUrl: string) {
  return defineBundledChannelEntry({
    id: whatsappAssembly.id,
    name: whatsappAssembly.name,
    description: whatsappAssembly.description,
    importMetaUrl,
    plugin: whatsappAssembly.entry.plugin,
    runtime: whatsappAssembly.entry.runtime,
  });
}

export function defineWhatsAppBundledChannelSetupEntry(importMetaUrl: string) {
  return defineBundledChannelSetupEntry({
    importMetaUrl,
    plugin: whatsappAssembly.setupEntry.plugin,
  });
}
