import { z } from "zod";

// ACP v1 custom methods and initialize metadata are intentionally separate from
// the stable protocol schema. Unknown extensions are never treated as supported.
export const SteeringCapability = z.object({ supported: z.literal(true) });
export const SteeringRequest = z.object({
  sessionId: z.string(),
  prompt: z.array(z.object({ type: z.literal("text"), text: z.string() })).min(1),
  _meta: z.object({ steering: z.object({ idleBehavior: z.literal("promptRequired") }) }),
});
export const SteeringResponse = z.object({
  outcome: z.enum(["injected", "startedNewTurn", "promptRequired", "failed"]),
  reason: z.string().optional(),
});
export const STEERING_METHOD = "_session/steering";

export function detectExtensions(meta: unknown) {
  const value = meta && typeof meta === "object" ? meta as Record<string, unknown> : {};
  return { steering: SteeringCapability.safeParse(value.steering).success };
}
