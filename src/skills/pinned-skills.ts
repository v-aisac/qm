import { isSafeSkillName } from "./skill-name.ts";

const MAX_PINNED_SKILLS = 12;

export function parsePinnedSkills(raw: unknown): { value: string[] } | { error: string } {
  if (raw === undefined || raw === null) return { value: [] };
  if (!Array.isArray(raw) || !raw.every((name) => typeof name === "string"))
    return { error: "pinned skills require { names: string[] } (an empty list clears them)" };
  const names = [...new Set(raw.map((name) => name.trim()).filter(Boolean))];
  const bad = names.find((name) => !isSafeSkillName(name));
  if (bad) return { error: `not a valid skill name: ${bad}` };
  if (names.length > MAX_PINNED_SKILLS) return { error: `at most ${MAX_PINNED_SKILLS} skills can be pinned` };
  return { value: names };
}
