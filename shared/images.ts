/** The image types Claude and opencode take, by the file extension the host stores them under. */
export const imageTypes = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
} as const;

export type ImageExtension = keyof typeof imageTypes;

const imageIdPattern = /^[0-9a-f-]{36}\.(png|jpg|gif|webp)$/;

export const isImageId = (imageId: string) => imageIdPattern.test(imageId);

export const extensionFor = (mimeType: string) =>
  (Object.entries(imageTypes) as [ImageExtension, string][]).find(([, type]) => type === mimeType)?.[0];

export const mimeTypeOf = (imageId: string) => imageTypes[imageId.split(".").at(-1) as ImageExtension];

export const imageUrl = (conversationId: string, imageId: string) => `/conversations/${conversationId}/images/${imageId}`;

/** An image the agent's update carried, shown from its own data: never fetched from an address the agent named. */
export const carriedImageSource = ({ mimeType, data }: { mimeType: string; data: string }) =>
  extensionFor(mimeType) && data ? `data:${mimeType};base64,${data}` : null;
