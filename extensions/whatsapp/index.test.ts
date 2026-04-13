import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { listBundledPluginPackArtifacts } from "../../scripts/lib/bundled-plugin-build-entries.mjs";
import { assertBundledChannelEntries } from "../../test/helpers/bundled-channel-entry.ts";
import { importFreshModule } from "../../test/helpers/import-fresh.ts";
import { whatsappAssembly } from "./assembly.js";
import entry from "./index.js";
import setupEntry from "./setup-entry.js";
import * as runtimeAssembly from "./src/runtime-api.js";

describe("whatsapp bundled entries", () => {
  assertBundledChannelEntries({
    entry,
    expectedId: "whatsapp",
    expectedName: "WhatsApp",
    setupEntry,
  });

  it("keeps entry wrappers and package metadata delegated through the assembly owner", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(new URL("./package.json", import.meta.url), "utf8"),
    );
    const indexSource = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const setupEntrySource = fs.readFileSync(new URL("./setup-entry.ts", import.meta.url), "utf8");
    const runtimeApiSource = fs.readFileSync(new URL("./runtime-api.ts", import.meta.url), "utf8");
    const lightRuntimeApiSource = fs.readFileSync(
      new URL("./light-runtime-api.ts", import.meta.url),
      "utf8",
    );

    expect(indexSource).toContain("defineWhatsAppBundledChannelEntry(import.meta.url)");
    expect(setupEntrySource).toContain("defineWhatsAppBundledChannelSetupEntry(import.meta.url)");
    expect(runtimeApiSource).toContain('from "./src/runtime-api.js"');
    expect(lightRuntimeApiSource).toContain('from "./src/runtime-api.js"');
    expect(entry.id).toBe(whatsappAssembly.id);
    expect(entry.name).toBe(whatsappAssembly.name);
    expect(packageJson.openclaw.extensions).toEqual([...whatsappAssembly.package.entrySources]);
    expect(packageJson.openclaw.setupEntry).toBe(whatsappAssembly.package.setupEntrySource);
    expect(packageJson.openclaw.channel.persistedAuthState).toEqual(
      whatsappAssembly.package.persistedAuthState,
    );
  });

  it("packs the required WhatsApp assembly artifacts", () => {
    const artifacts = listBundledPluginPackArtifacts();

    for (const artifact of whatsappAssembly.package.packagedArtifacts) {
      expect(artifacts).toContain(`dist/extensions/whatsapp/${artifact}`);
    }
  });

  it("keeps heavy runtime imports cold while loading the setup plugin", async () => {
    const loadHeavyRuntime = vi.fn();

    vi.doMock("./src/runtime-api.js", () => {
      loadHeavyRuntime();
      return {
        whatsappSetupWizard: {},
      };
    });

    try {
      const { default: freshSetupEntry } = await importFreshModule<
        typeof import("./setup-entry.js")
      >(import.meta.url, "./setup-entry.js?scope=whatsapp-setup-cold");

      await freshSetupEntry.loadSetupPlugin();

      expect(loadHeavyRuntime).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("./src/runtime-api.js");
      vi.resetModules();
    }
  });

  it("keeps gateway startup and login exports on the shared runtime assembly surface", () => {
    for (const exportName of whatsappAssembly.runtime.sharedExportNames) {
      expect(runtimeAssembly).toHaveProperty(exportName);
    }
  });
});
