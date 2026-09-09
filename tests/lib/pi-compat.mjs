// Match Pi 0.85's extension loader, which maps legacy root imports to /compat.
// Older Pi releases expose that API at the root and need no alias.
import { registerHooks } from "node:module";
let compat;
try { compat = import.meta.resolve("@earendil-works/pi-ai/compat"); } catch { /* older Pi */ }
if (compat) registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier === "@earendil-works/pi-ai" ? compat : specifier, context);
} });
