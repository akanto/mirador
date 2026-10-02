import type { PromptTemplate } from "./model.ts";

const PARAMETER = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** The names of the template's {{parameters}}, each once, in the order they first appear. */
export const parametersOf = (text: string) => [...new Set([...text.matchAll(PARAMETER)].map(([, name]) => name!).filter(Boolean))];

export const filledIn = (text: string, values: Record<string, string>) => text.replace(PARAMETER, (placeholder, name: string) => (name ? (values[name] ?? "") : placeholder));

/** Added once, to a host that has never had templates; deleted ones stay deleted. */
export const defaultPromptTemplates: Omit<PromptTemplate, "createdAt">[] = [
  {
    id: "default-deep-pr-review",
    name: "Deep PR review",
    text:
      "{{Pull request}}, make a very deep review, use cb reviewer skill too, you can use worktree for code checking and validating your concerns. " +
      "Make a summary for me to make me understand it faster, focus on how the code flow happens, please focus on make your response easy to understand by a human, me :)",
  },
];

export const PROMPT_TEMPLATE_NAME_LIMIT = 100;
export const PROMPT_TEMPLATE_TEXT_LIMIT = 20_000;

/** What is wrong with a template the user wants to save, if anything. */
export function promptTemplateProblem({ id, name, text }: Pick<PromptTemplate, "id" | "name" | "text">): string | null {
  if (typeof id !== "string" || !id || id.length > 100) return "A template needs an id.";
  if (typeof name !== "string" || !name.trim()) return "A template needs a name.";
  if (name.length > PROMPT_TEMPLATE_NAME_LIMIT) return `A template's name can be at most ${PROMPT_TEMPLATE_NAME_LIMIT} characters.`;
  if (typeof text !== "string" || !text.trim()) return "A template needs a text.";
  if (text.length > PROMPT_TEMPLATE_TEXT_LIMIT) return `A template's text can be at most ${PROMPT_TEMPLATE_TEXT_LIMIT} characters.`;
  return null;
}
