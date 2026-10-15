/** A path to a file as an agent writes it inline: absolute, or relative with a folder, and an extension. */
export const looksLikeFilePath = (text: string) => /^(\/|[\w.-]+\/)\S*\.\w+$/.test(text);
