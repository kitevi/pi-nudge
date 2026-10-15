import { describe, expect, it } from "vitest";
import { createJiti } from "jiti";

// Pi loads extensions through jiti, so load the extension the same way pi
// will: this also exercises the ESM-only node-notifier dependency through
// require(esm).
describe("extension module load", () => {
	it("loads through jiti and exports the default factory", () => {
		const jiti = createJiti(import.meta.url);
		const mod = jiti("../src/extension.ts") as { default?: unknown };
		const factory = mod.default ?? mod;
		expect(typeof factory).toBe("function");
	});
});
