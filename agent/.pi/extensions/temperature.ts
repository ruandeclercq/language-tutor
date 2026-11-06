import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const temperature = Number(process.env.PI_TEMPERATURE ?? 0.3);

export default function temperatureExtension(pi: ExtensionAPI) {
  pi.on("before_provider_request", (event, ctx) => {
    return {
      ...event.payload,
      temperature,
    };
  });
}
