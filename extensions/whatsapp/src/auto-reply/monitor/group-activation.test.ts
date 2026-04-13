import { afterEach, describe, expect, it, vi } from "vitest";
import { makeSessionStore } from "../../auto-reply.test-harness.js";
import { loadSessionStore } from "../config.runtime.js";
import { resolveGroupActivationFor } from "./group-activation.js";

describe("resolveGroupActivationFor", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("reads legacy named-account group activation and backfills the scoped key", async () => {
    const sessionKey = "agent:main:whatsapp:group:123@g.us:thread:whatsapp-account-work";
    const legacySessionKey = "agent:main:whatsapp:group:123@g.us";
    const { storePath, cleanup } = await makeSessionStore({
      [legacySessionKey]: { groupActivation: "always" },
    });
    cleanups.push(cleanup);

    const activation = await resolveGroupActivationFor({
      cfg: {
        channels: {
          whatsapp: {
            accounts: {
              work: {},
            },
          },
        },
        session: { store: storePath },
      } as never,
      accountId: "work",
      agentId: "main",
      sessionKey,
      conversationId: "123@g.us",
    });

    expect(activation).toBe("always");
    await vi.waitFor(() => {
      expect(loadSessionStore(storePath, { skipCache: true })[sessionKey]?.groupActivation).toBe(
        "always",
      );
    });
  });
});
