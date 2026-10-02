import { useRef, useState, type ClipboardEvent, type Dispatch, type DragEvent, type RefObject, type SetStateAction } from "react";
import { flushSync } from "react-dom";
import { imageUrl } from "../shared/images.ts";
import { useDraftAttachments } from "./drafts.ts";
import { useImagePreview } from "./ImagePreview.tsx";
import {
  imageFilesIn,
  imagesToPaste,
  nextNumber,
  placeholder,
  referencedAttachments,
  restoredDraft,
  uploadImage,
  withoutPlaceholder,
  type Attachment,
} from "./pasted-images.ts";

const carriesFiles = (event: DragEvent) => event.dataTransfer.types.includes("Files");

/** Images pasted or dropped into the message box: each goes in as `[Image #n]` at the caret, as in Claude Code. */
export function useComposerImages(
  conversationId: string,
  text: string,
  setText: Dispatch<SetStateAction<string>>,
  textarea: RefObject<HTMLTextAreaElement | null>,
) {
  const [attachments, setAttachments] = useDraftAttachments(conversationId);
  const latest = useRef(attachments);
  latest.current = attachments;
  const uploading = useRef(new Set<number>());
  const [uploadCount, setUploadCount] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);

  const insertAtCaret = (insertion: string) => {
    const box = textarea.current;
    const [start, end] = box ? [box.selectionStart, box.selectionEnd] : [Infinity, Infinity];
    flushSync(() => setText((current) => current.slice(0, start) + insertion + current.slice(end)));
    box?.setSelectionRange(start + insertion.length, start + insertion.length);
  };

  const reserveNumber = () => {
    const number = nextNumber([...latest.current.map(({ number }) => number), ...uploading.current]);
    uploading.current.add(number);
    return number;
  };

  const upload = async (file: File, number: number) => {
    try {
      const imageId = await uploadImage(conversationId, file);
      latest.current = [...latest.current, { number, imageId }];
      setAttachments(latest.current);
    } catch (error) {
      setText((current) => withoutPlaceholder(current, number));
      setProblem(`Could not attach ${file.name || "the image"}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      uploading.current.delete(number);
      setUploadCount(uploading.current.size);
    }
  };

  const attach = (files: File[]) => {
    setProblem(null);
    const pasted = files.map((file) => ({ file, number: reserveNumber() }));
    setUploadCount(uploading.current.size);
    insertAtCaret(pasted.map(({ number }) => `${placeholder(number)} `).join(""));
    pasted.forEach(({ file, number }) => void upload(file, number));
  };

  return {
    attachments,
    referenced: referencedAttachments(text, attachments),
    uploading: uploadCount > 0,
    problem,
    onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
      const images = imagesToPaste(event.clipboardData.getData("text/plain"), imageFilesIn(event.clipboardData));
      if (images.length === 0) return;
      event.preventDefault();
      attach(images);
    },
    onDragOver(event: DragEvent) {
      if (carriesFiles(event)) event.preventDefault();
    },
    onDrop(event: DragEvent) {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      const images = imageFilesIn(event.dataTransfer);
      if (images.length > 0) attach(images);
      else setProblem("Only images can go into a message.");
    },
    detach(attachment: Attachment) {
      setText((current) => withoutPlaceholder(current, attachment.number));
      setAttachments((current) => current.filter(({ imageId }) => imageId !== attachment.imageId));
    },
    restore(queuedText: string, imageIds: string[]) {
      const restored = restoredDraft(queuedText, imageIds, latest.current);
      latest.current = [...latest.current, ...restored.attachments];
      setAttachments(latest.current);
      return restored.text;
    },
    replace(replacements: Attachment[]) {
      latest.current = replacements;
      setAttachments(replacements);
    },
    clear() {
      setProblem(null);
      setAttachments([]);
    },
  };
}

export function PastedImages({
  conversationId,
  attachments,
  onRemove,
}: {
  conversationId: string;
  attachments: Attachment[];
  onRemove: (attachment: Attachment) => void;
}) {
  const [preview, open] = useImagePreview();
  if (attachments.length === 0) return null;
  return (
    <>
      <ul className="pasted-images" aria-label="Pasted images">
      {attachments.map((attachment) => (
        <li key={attachment.imageId}>
          <button type="button" className="thumbnail" aria-label={`Show image #${attachment.number}`} onClick={() => open(imageUrl(conversationId, attachment.imageId))}>
            <img src={imageUrl(conversationId, attachment.imageId)} alt="" />
          </button>
          <span className="pasted-image-label">{placeholder(attachment.number)}</span>
          <button type="button" className="icon" aria-label={`Remove image #${attachment.number}`} onClick={() => onRemove(attachment)}>
            ✕
          </button>
        </li>
      ))}
      </ul>
      {preview}
    </>
  );
}

export function MessageImages({ conversationId, imageIds }: { conversationId: string; imageIds: string[] | undefined }) {
  const [preview, open] = useImagePreview();
  if (!imageIds?.length) return null;
  return (
    <div className="message-images">
      {imageIds.map((imageId, index) => (
        <button key={imageId} type="button" className="thumbnail" aria-label={`Show image ${index + 1}`} onClick={() => open(imageUrl(conversationId, imageId))}>
          <img src={imageUrl(conversationId, imageId)} alt="" />
        </button>
      ))}
      {preview}
    </div>
  );
}
