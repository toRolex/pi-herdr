import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import herdrExtension from "../../src/index.js";
import { getAgentResult } from "../../src/tools/result.js";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
	if (process.env.TURN_PROBE_LEGACY_RESULT !== "1") return herdrExtension(pi);
	const adapter = new Proxy(pi, {
		get(target, key) {
			if (key !== "registerTool") return Reflect.get(target, key);
			return (tool: any) => {
				if (tool.name === "herdr_get_agent_result") {
					tool = { ...tool, parameters: Type.Object({ target: Type.String(), wait: Type.Optional(Type.Boolean()) }), async execute(_id: string, params: any, signal: AbortSignal) {
						const result = await getAgentResult(params, { signal });
						return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
					} };
				}
				return target.registerTool(tool);
			};
		},
	});
	return herdrExtension(adapter);
}
