import { z } from "zod";

const choice = z.object({ value: z.string().max(512), name: z.string().max(512) });
const option = z.object({
  id: z.string().max(512),
  category: z.string().nullish(),
  type: z.literal("select"),
  currentValue: z.string().max(512),
  options: z.array(z.union([choice, z.object({ options: z.array(choice) })])),
});

export const ModelSchema = z.object({
  id: z.string().max(512),
  current: z.string().max(512),
  choices: z.array(choice).max(500),
});
export type SessionModel = z.infer<typeof ModelSchema>;

export function readModel(input: unknown): SessionModel | undefined {
  if (!Array.isArray(input)) return;
  const candidates = input.flatMap((item) => {
    const parsed = option.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
  const model =
    candidates.find((item) => item.category === "model") ??
    candidates.find((item) => item.id === "model" && !item.category);
  if (!model) return;
  const choices = model.options
    .flatMap((item) => ("options" in item ? item.options : [item]))
    .slice(0, 500);
  if (choices.length) return { id: model.id, current: model.currentValue, choices };
}
