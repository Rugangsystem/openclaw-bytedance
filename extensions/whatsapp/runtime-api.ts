// Keep runtime exports declared in src/runtime-api.ts so host/runtime/setup
// assembly stays aligned through assembly.ts. auto-reply stays forwarded here
// because re-exporting it from src/runtime-api.ts reintroduces a runtime cycle.
export * from "./src/runtime-api.js";
export * from "./src/auto-reply.js";
