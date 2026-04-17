import {
  Client,
  ReadyListener,
  type BaseCommand,
  type BaseMessageInteractiveComponent,
  type Modal,
  type Plugin,
} from "@buape/carbon";
import type { GatewayPlugin } from "@buape/carbon/gateway";
import { VoicePlugin } from "@buape/carbon/voice";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { isDangerousNameMatchingEnabled } from "openclaw/plugin-sdk/config-runtime";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { createDiscordRequestClient } from "../proxy-request-client.js";
import type { DiscordGuildEntryResolved } from "./allow-list.js";
import { createDiscordAutoPresenceController } from "./auto-presence.js";
import type { DiscordDmPolicy } from "./dm-command-auth.js";
import type { MutableDiscordGateway } from "./gateway-handle.js";
import { createDiscordGatewayPlugin } from "./gateway-plugin.js";
import { createDiscordGatewaySupervisor } from "./gateway-supervisor.js";
import {
  DiscordMessageListener,
  DiscordPresenceListener,
  DiscordReactionListener,
  DiscordReactionRemoveListener,
  DiscordThreadUpdateListener,
  registerDiscordListener,
} from "./listeners.js";
import { resolveDiscordPresenceUpdate } from "./presence.js";

type DiscordAutoPresenceController = ReturnType<typeof createDiscordAutoPresenceController>;
type DiscordListenerConfig = {
  dangerouslyAllowNameMatching?: boolean;
  intents?: { presence?: boolean };
};
type CreateClientFn = (
  options: ConstructorParameters<typeof Client>[0],
  handlers: ConstructorParameters<typeof Client>[1],
  plugins: ConstructorParameters<typeof Client>[2],
) => Client;
type CarbonEventQueueOptions = NonNullable<ConstructorParameters<typeof Client>[0]["eventQueue"]>;

type ListenerCompatClient = Client & {
  plugins?: Array<{ id: string; plugin: Plugin }>;
  registerListener?: (listener: object) => object;
  unregisterListener?: (listener: object) => boolean;
};

function withLegacyListenerCompat(client: Client): ListenerCompatClient {
  const compatClient = client as ListenerCompatClient;
  if (!compatClient.registerListener) {
    compatClient.registerListener = (listener: object) => {
      if (!compatClient.listeners.includes(listener as never)) {
        compatClient.listeners.push(listener as never);
      }
      return listener;
    };
  }
  if (!compatClient.unregisterListener) {
    compatClient.unregisterListener = (listener: object) => {
      const index = compatClient.listeners.indexOf(listener as never);
      if (index < 0) {
        return false;
      }
      compatClient.listeners.splice(index, 1);
      return true;
    };
  }
  return compatClient;
}

function registerLatePlugin(client: Client, plugin: Plugin) {
  const compatClient = withLegacyListenerCompat(client);
  void plugin.registerClient?.(compatClient);
  void plugin.registerRoutes?.(compatClient);
  if (!compatClient.plugins?.some((entry) => entry.id === plugin.id)) {
    compatClient.plugins?.push({ id: plugin.id, plugin });
  }
}

export function createDiscordStatusReadyListener(params: {
  discordConfig: Parameters<typeof resolveDiscordPresenceUpdate>[0];
  getAutoPresenceController: () => DiscordAutoPresenceController | null;
}): ReadyListener {
  return new (class DiscordStatusReadyListener extends ReadyListener {
    async handle(_data: unknown, client: Client) {
      const autoPresenceController = params.getAutoPresenceController();
      if (autoPresenceController?.enabled) {
        autoPresenceController.refresh();
        return;
      }

      const gateway = client.getPlugin<GatewayPlugin>("gateway");
      if (!gateway) {
        return;
      }

      const presence = resolveDiscordPresenceUpdate(params.discordConfig);
      if (!presence) {
        return;
      }

      gateway.updatePresence(presence);
    }
  })();
}

export function createDiscordMonitorClient(params: {
  accountId: string;
  applicationId: string;
  token: string;
  proxyFetch?: typeof fetch;
  commands: BaseCommand[];
  components: BaseMessageInteractiveComponent[];
  modals: Modal[];
  voiceEnabled: boolean;
  discordConfig: Parameters<typeof resolveDiscordPresenceUpdate>[0] & {
    eventQueue?: Pick<
      CarbonEventQueueOptions,
      "listenerTimeout" | "maxQueueSize" | "maxConcurrency"
    >;
  };
  runtime: RuntimeEnv;
  createClient: CreateClientFn;
  createGatewayPlugin: typeof createDiscordGatewayPlugin;
  createGatewaySupervisor: typeof createDiscordGatewaySupervisor;
  createAutoPresenceController: typeof createDiscordAutoPresenceController;
  isDisallowedIntentsError: (err: unknown) => boolean;
}) {
  let autoPresenceController: DiscordAutoPresenceController | null = null;
  const clientPlugins: Plugin[] = [
    params.createGatewayPlugin({
      discordConfig: params.discordConfig,
      runtime: params.runtime,
    }),
  ];
  if (params.voiceEnabled) {
    clientPlugins.push(new VoicePlugin());
  }
  const voicePlugin = clientPlugins.find((plugin) => plugin.id === "voice");
  const constructorPlugins = voicePlugin
    ? clientPlugins.filter((plugin) => plugin !== voicePlugin)
    : clientPlugins;

  // Pass eventQueue config to Carbon so the gateway listener budget can be tuned.
  // Default listenerTimeout is 120s (Carbon defaults to 30s, which is too short for some
  // Discord normalization/enqueue work).
  const eventQueueOpts = {
    listenerTimeout: 120_000,
    slowListenerThreshold: 30_000,
    ...params.discordConfig.eventQueue,
  } satisfies CarbonEventQueueOptions;
  const readyListener = createDiscordStatusReadyListener({
    discordConfig: params.discordConfig,
    getAutoPresenceController: () => autoPresenceController,
  });
  const client = params.createClient(
    {
      baseUrl: "http://localhost",
      deploySecret: "a",
      clientId: params.applicationId,
      publicKey: "a",
      token: params.token,
      autoDeploy: false,
      eventQueue: eventQueueOpts,
    },
    {
      commands: params.commands,
      listeners: [readyListener],
      components: params.components,
      modals: params.modals,
    },
    constructorPlugins,
  );
  if (voicePlugin) {
    registerLatePlugin(client, voicePlugin);
  }
  if (params.proxyFetch) {
    client.rest = createDiscordRequestClient(params.token, {
      fetch: params.proxyFetch,
    });
  }
  const gateway = client.getPlugin<GatewayPlugin>("gateway") as MutableDiscordGateway | undefined;
  const gatewaySupervisor = params.createGatewaySupervisor({
    gateway,
    isDisallowedIntentsError: params.isDisallowedIntentsError,
    runtime: params.runtime,
  });

  if (gateway) {
    autoPresenceController = params.createAutoPresenceController({
      accountId: params.accountId,
      discordConfig: params.discordConfig,
      gateway,
      log: (message) => params.runtime.log?.(message),
    });
    autoPresenceController.start();
  }

  return {
    client,
    gateway,
    gatewaySupervisor,
    autoPresenceController,
    eventQueueOpts,
  };
}

/**
 * Error thrown when the bot identity cannot be resolved during startup.
 * Used so the provider supervisor can distinguish fail-fast identity errors
 * from unrelated startup failures and retry on transient network issues
 * (issue #42219).
 */
export class DiscordBotIdentityUnresolvedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DiscordBotIdentityUnresolvedError";
  }
}

export async function fetchDiscordBotIdentity(params: {
  client: Pick<Client, "fetchUser">;
  runtime: RuntimeEnv;
  logStartupPhase: (phase: string, details?: string) => void;
}) {
  params.logStartupPhase("fetch-bot-identity:start");
  let botUser: Awaited<ReturnType<Client["fetchUser"]>>;
  try {
    botUser = await params.client.fetchUser("@me");
  } catch (err) {
    // Fail fast instead of continuing with botUserId=undefined. A missing bot
    // id short-circuits the `if (botId && mentionDecision.shouldSkip)` guard
    // in message-handler.preflight.ts, letting guild messages bypass
    // `requireMention: true`, and it also disables author-id self-message
    // filtering. Throwing here lets the provider supervisor restart on
    // transient failures, matching the fail-fast stance other startup paths
    // (e.g. fetchDiscordApplicationId when credentials are bad) take.
    params.runtime.error?.(danger(`discord: failed to fetch bot identity: ${String(err)}`));
    params.logStartupPhase("fetch-bot-identity:error", String(err));
    throw new DiscordBotIdentityUnresolvedError(
      `discord: failed to fetch bot identity: ${String(err)}`,
      { cause: err },
    );
  }
  const botUserId = botUser?.id;
  if (!botUserId) {
    // API succeeded but returned no id — still not safe to proceed. Same
    // reasoning as the catch block above.
    const reason = `discord: bot identity response missing id (user=${botUser ? "present" : "missing"})`;
    params.runtime.error?.(danger(reason));
    params.logStartupPhase("fetch-bot-identity:error", "missing-id");
    throw new DiscordBotIdentityUnresolvedError(reason);
  }
  const botUserName =
    normalizeOptionalString(botUser?.username) ?? normalizeOptionalString(botUser?.globalName);
  params.logStartupPhase(
    "fetch-bot-identity:done",
    `botUserId=${botUserId} botUserName=${botUserName ?? "<missing>"}`,
  );
  return { botUserId, botUserName };
}

export function registerDiscordMonitorListeners(params: {
  cfg: OpenClawConfig;
  client: Pick<Client, "listeners">;
  accountId: string;
  discordConfig: DiscordListenerConfig;
  runtime: RuntimeEnv;
  botUserId?: string;
  dmEnabled: boolean;
  groupDmEnabled: boolean;
  groupDmChannels?: string[];
  dmPolicy: DiscordDmPolicy;
  allowFrom?: string[];
  groupPolicy: "open" | "allowlist" | "disabled";
  guildEntries?: Record<string, DiscordGuildEntryResolved>;
  logger: NonNullable<ConstructorParameters<typeof DiscordMessageListener>[1]>;
  messageHandler: ConstructorParameters<typeof DiscordMessageListener>[0];
  trackInboundEvent?: () => void;
  eventQueueListenerTimeoutMs?: number;
}) {
  registerDiscordListener(
    params.client.listeners,
    new DiscordMessageListener(params.messageHandler, params.logger, params.trackInboundEvent, {
      timeoutMs: params.eventQueueListenerTimeoutMs,
    }),
  );

  const reactionListenerOptions: ConstructorParameters<typeof DiscordReactionListener>[0] = {
    cfg: params.cfg,
    accountId: params.accountId,
    runtime: params.runtime,
    botUserId: params.botUserId,
    dmEnabled: params.dmEnabled,
    groupDmEnabled: params.groupDmEnabled,
    groupDmChannels: params.groupDmChannels ?? [],
    dmPolicy: params.dmPolicy,
    allowFrom: params.allowFrom ?? [],
    groupPolicy: params.groupPolicy,
    allowNameMatching: isDangerousNameMatchingEnabled(params.discordConfig),
    guildEntries: params.guildEntries,
    logger: params.logger,
    onEvent: params.trackInboundEvent,
  };
  registerDiscordListener(
    params.client.listeners,
    new DiscordReactionListener(reactionListenerOptions),
  );
  registerDiscordListener(
    params.client.listeners,
    new DiscordReactionRemoveListener(reactionListenerOptions),
  );
  registerDiscordListener(
    params.client.listeners,
    new DiscordThreadUpdateListener(params.cfg, params.accountId, params.logger),
  );

  if (params.discordConfig.intents?.presence) {
    registerDiscordListener(
      params.client.listeners,
      new DiscordPresenceListener({ logger: params.logger, accountId: params.accountId }),
    );
    params.runtime.log?.("discord: GuildPresences intent enabled — presence listener registered");
  }
}
