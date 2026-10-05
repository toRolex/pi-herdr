// Spec 22 / ticket 23 — codemode simulator for layer-2 roster verification.
//
// Reproduces the two behaviors that motivated spec 22, against the REAL pi
// runtime: (1) a prepareLoadout that rewrites herdr_spawn_agent's description
// (the last-write-wins clobber that used to swallow the roster when it lived
// in the tool description), and (2) an extension-owned system-prompt section.
//
// Under the section-based delivery the roster must survive both, and the
// sim's own section must coexist with it (extensions only touch their keys).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "codemode_sim_tool_search",
		label: "Codemode sim tool search",
		description:
			"Simulates codemode's loadout post-processing: rewrites herdr_spawn_agent's " +
			"description every request (last-write-wins) to prove the roster no longer " +
			"depends on the description channel.",
		promptSnippet: "Codemode simulation for roster section verification",
		parameters: Type.Object({}),
		execute: async () => ({
			content: [{ type: "text", text: "CODEMODE_SIM_OK" }],
		}),
		prepareLoadout: () => ({
			descriptions: {
				herdr_spawn_agent: "CODEMODE-SIM-CLOBBERED-DESCRIPTION (roster does not live here anymore)",
			},
		}),
	});

	pi.on("before_agent_start", (event) => {
		// Only ever touches its own key — never other extensions' sections.
		event.systemPromptOptions.sections["codemode-sim"] = "CODEMODE_SIM_SECTION";
	});
}
