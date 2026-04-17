import type { Client, Plugin } from "@buape/carbon";
import { describe, expect, it, vi } from "vitest";

const { registerVoiceClientSpy } = vi.hoisted(() => ({
  registerVoiceClientSpy: vi.fn(),
}));

vi.mock("@buape/carbon/voice", () => ({
  VoicePlugin: class VoicePlugin {
    id = "voice";

    registerClient(client: {
      getPlugin: (id: string) => unknown;
      registerListener: (listener: object) => object;
      unregisterListener: (listener: object) => boolean;
    }) {
      registerVoiceClientSpy(client);
      if (!client.getPlugin("gateway")) {
        throw new Error("gateway plugin missing");
      }
      client.registerListener({ type: "legacy-voice-listener" });
    }
  },
}));

vi.mock("openclaw/plugin-sdk/config-runtime", () => ({
  isDangerousNameMatchingEnabled: () => false,
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  danger: (value: string) => value,
}));

vi.mock("openclaw/plugin-sdk/text-runtime", () => ({
  normalizeOptionalString: (value: string | null | undefined) => {
    if (typeof value !== "string") {
      return undefined;
    }
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
  },
}));

vi.mock("../proxy-request-client.js", () => ({
  createDiscordRequestClient: vi.fn(),
}));

vi.mock("./auto-presence.js", () => ({
  createDiscordAutoPresenceController: vi.fn(),
}));

vi.mock("./gateway-plugin.js", () => ({
  createDiscordGatewayPlugin: vi.fn(),
}));

vi.mock("./gateway-supervisor.js", () => ({
  createDiscordGatewaySupervisor: vi.fn(),
}));

vi.mock("./listeners.js", () => ({
  DiscordMessageListener: function DiscordMessageListener() {},
  DiscordPresenceListener: function DiscordPresenceListener() {},
  DiscordReactionListener: function DiscordReactionListener() {},
  DiscordReactionRemoveListener: function DiscordReactionRemoveListener() {},
  DiscordThreadUpdateListener: function DiscordThreadUpdateListener() {},
  registerDiscordListener: vi.fn(),
}));

vi.mock("./presence.js", () => ({
  resolveDiscordPresenceUpdate: vi.fn(() => undefined),
}));

import {
  createDiscordMonitorClient,
  DiscordBotIdentityUnresolvedError,
  fetchDiscordBotIdentity,
} from "./provider.startup.js";

describe("createDiscordMonitorClient", () => {
  it("adds listener compat for legacy voice plugins", () => {
    registerVoiceClientSpy.mockReset();

    const gatewayPlugin = {
      id: "gateway",
      registerClient: vi.fn(),
      registerRoutes: vi.fn(),
    } as Plugin;

    const result = createDiscordMonitorClient({
      accountId: "default",
      applicationId: "app-1",
      token: "token-1",
      commands: [],
      components: [],
      modals: [],
      voiceEnabled: true,
      discordConfig: {},
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
      createClient: (_options, handlers, plugins = []) => {
        const pluginRegistry = plugins.map((plugin) => ({ id: plugin.id, plugin }));
        return {
          listeners: [...(handlers.listeners ?? [])],
          plugins: pluginRegistry,
          getPlugin: (id: string) => pluginRegistry.find((entry) => entry.id === id)?.plugin,
        } as Client;
      },
      createGatewayPlugin: () => gatewayPlugin as never,
      createGatewaySupervisor: () => ({ shutdown: vi.fn(), handleError: vi.fn() }) as never,
      createAutoPresenceController: () =>
        ({
          enabled: false,
          start: vi.fn(),
          stop: vi.fn(),
          refresh: vi.fn(),
          runNow: vi.fn(),
        }) as never,
      isDisallowedIntentsError: () => false,
    });

    expect(registerVoiceClientSpy).toHaveBeenCalledTimes(1);
    expect(result.client.listeners).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "legacy-voice-listener" })]),
    );
  });
});

describe("fetchDiscordBotIdentity", () => {
  // Issue #42219 regression: before this fix, fetchUser failures only logged
  // and returned { botUserId: undefined }. That undefined botUserId bypassed
  // the `if (botId && mentionDecision.shouldSkip)` drop in
  // message-handler.preflight.ts, letting guild messages skip `requireMention`.
  // The fix is to fail fast so the provider supervisor restarts on transient
  // failures and never continues with a missing identity.

  function makeRuntime() {
    return {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
  }

  it("returns the resolved identity on a normal fetchUser response", async () => {
    const runtime = makeRuntime();
    const logStartupPhase = vi.fn();

    const result = await fetchDiscordBotIdentity({
      client: {
        fetchUser: vi.fn(async () => ({
          id: "bot-123",
          username: "openclaw-bot",
          globalName: "OpenClaw",
        })),
      } as unknown as Parameters<typeof fetchDiscordBotIdentity>[0]["client"],
      runtime,
      logStartupPhase,
    });

    expect(result).toEqual({ botUserId: "bot-123", botUserName: "openclaw-bot" });
    expect(logStartupPhase).toHaveBeenCalledWith("fetch-bot-identity:start");
    expect(logStartupPhase).toHaveBeenCalledWith(
      "fetch-bot-identity:done",
      expect.stringContaining("botUserId=bot-123"),
    );
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("throws DiscordBotIdentityUnresolvedError when fetchUser rejects (issue #42219)", async () => {
    const runtime = makeRuntime();
    const logStartupPhase = vi.fn();

    await expect(
      fetchDiscordBotIdentity({
        client: {
          fetchUser: vi.fn(async () => {
            throw new Error("network down");
          }),
        } as unknown as Parameters<typeof fetchDiscordBotIdentity>[0]["client"],
        runtime,
        logStartupPhase,
      }),
    ).rejects.toBeInstanceOf(DiscordBotIdentityUnresolvedError);

    // Logged once at error with the cause, and the startup phase tracker saw
    // the error transition so the supervisor's log is still accurate.
    expect(runtime.error).toHaveBeenCalledTimes(1);
    expect(logStartupPhase).toHaveBeenCalledWith(
      "fetch-bot-identity:error",
      expect.stringContaining("network down"),
    );
  });

  it("throws DiscordBotIdentityUnresolvedError when the response has no id", async () => {
    const runtime = makeRuntime();
    const logStartupPhase = vi.fn();

    await expect(
      fetchDiscordBotIdentity({
        client: {
          fetchUser: vi.fn(async () => ({ username: "headless" })),
        } as unknown as Parameters<typeof fetchDiscordBotIdentity>[0]["client"],
        runtime,
        logStartupPhase,
      }),
    ).rejects.toBeInstanceOf(DiscordBotIdentityUnresolvedError);

    expect(runtime.error).toHaveBeenCalledTimes(1);
    expect(logStartupPhase).toHaveBeenLastCalledWith("fetch-bot-identity:error", "missing-id");
  });

  it("wraps the original cause so the supervisor can inspect the underlying error", async () => {
    const runtime = makeRuntime();
    const logStartupPhase = vi.fn();
    const original = new Error("ECONNRESET");

    try {
      await fetchDiscordBotIdentity({
        client: {
          fetchUser: vi.fn(async () => {
            throw original;
          }),
        } as unknown as Parameters<typeof fetchDiscordBotIdentity>[0]["client"],
        runtime,
        logStartupPhase,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DiscordBotIdentityUnresolvedError);
      expect((err as { cause?: unknown }).cause).toBe(original);
    }
  });
});
