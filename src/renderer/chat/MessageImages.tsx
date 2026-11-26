import { useEffect, useRef, useState } from "react";
import { Image as ImageIcon } from "lucide-react";
import type { ChatAttachment, Message } from "../../shared/types";
import { api } from "../api";
import { ContextMenu, Dialog, ErrorNote, errorText } from "../ui/primitives";
import { ImageAnnotator, type ImageAnnotatorHandle } from "./ImageAnnotator";

/**
 * The pictures a sent message carried, shown in the transcript at a readable
 * size instead of only their names (user, 26.11): click opens one full size,
 * right-click offers Copy image and Save image (no confirmation text: user, 26.11).
 * Drawing on the full-size view adds the marked picture to the message on close.
 * The bytes stay in main's private
 * snapshot; the window gets a data: URL to draw, and Copy and Save run in main.
 */

// The line ChatService.send adds under a message with attachments.
const ATTACHED = /(?:^|\n\n)Attached: [^\n]*$/;

// Pictures already drawn, by attachment id: a transcript re-renders often and a
// picture can be 5 MiB. The most recent few are kept.
const pictures = new Map<string, string>();
const PICTURES_KEPT = 24;
function keep(id: string, src: string): void {
  pictures.delete(id);
  pictures.set(id, src);
  while (pictures.size > PICTURES_KEPT) pictures.delete(pictures.keys().next().value as string);
}

/** A composer chip's small picture (user, 26.11: a pasted image showed only its name). */
export function AttachmentThumb({ conversationId, item, large = false }: { conversationId: string; item: ChatAttachment; large?: boolean }) {
  const [src, setSrc] = useState<string | null>(() => pictures.get(item.id) ?? null);
  useEffect(() => {
    if (item.kind !== "image" || pictures.has(item.id)) return;
    let current = true;
    api.chat.previewAttachment(conversationId, item.id).then(
      found => { keep(item.id, found); if (current) setSrc(found); },
      () => {},
    );
    return () => { current = false; };
  }, [conversationId, item.id, item.kind]);
  if (large) return src ? <img className="composer-attachment-card-img" src={src} alt="" draggable={false} /> : <span className="composer-attachment-card-img" aria-hidden />;
  return src ? <img className="composer-attachment-thumb" src={src} alt="" draggable={false} /> : <ImageIcon size={14} aria-hidden />;
}

/** A picture already drawn for this attachment, if any (the composer's editor opens with it at once). */
export function cachedPicture(id: string): string | undefined { return pictures.get(id); }
export function rememberPicture(id: string, src: string): void { keep(id, src); }

/** The attachments bound to a user message, or null when it has none (or the preload is older). */
export function useMessageAttachments(message: Message): ChatAttachment[] | null {
  const [attachments, setAttachments] = useState<ChatAttachment[] | null>(null);
  const wanted = message.role === "user" && ATTACHED.test(message.content);
  useEffect(() => {
    setAttachments(null);
    const list = api.chat.messageAttachments;
    if (!wanted || typeof list !== "function") return;
    let current = true;
    list(message.conversationId, message.id).then(
      found => { if (current) setAttachments(found.length ? found : null); },
      () => { if (current) setAttachments(null); },
    );
    return () => { current = false; };
  }, [wanted, message.conversationId, message.id]);
  return attachments;
}

/** The bubble's words once the pictures are shown above it: the "Attached:" line names only the files that are not pictures. */
export function bubbleText(content: string, attachments: ChatAttachment[] | null): string {
  if (!attachments?.some(item => item.kind === "image")) return content;
  const words = content.replace(ATTACHED, "");
  const files = attachments.filter(item => item.kind !== "image").map(item => item.name);
  if (files.length) return `${words}\n\nAttached: ${files.join(", ")}`;
  return words.trim() === "Attached files" ? "" : words;
}

export function MessageImages({ conversationId, images, onAttach }: {
  conversationId: string;
  images: ChatAttachment[];
  /** The annotated picture, attached to this chat: the composer takes it. */
  onAttach?: (attachments: ChatAttachment[]) => void;
}) {
  const annotator = useRef<ImageAnnotatorHandle>(null);
  const [sources, setSources] = useState<Record<string, string | Error>>(() =>
    Object.fromEntries(images.flatMap(item => pictures.has(item.id) ? [[item.id, pictures.get(item.id)!]] : [])));
  const [open, setOpen] = useState<ChatAttachment | null>(null);
  const [shown, setShown] = useState<ChatAttachment | null>(null);
  const [viewMenu, setViewMenu] = useState<{ x: number; y: number } | null>(null);
  const [menu, setMenu] = useState<{ item: ChatAttachment; position: { x: number; y: number }; button: HTMLElement } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    // A chat being summarised or restarted refuses the read for a moment: try
    // again a few times before the picture falls back to its name.
    const timers: ReturnType<typeof setTimeout>[] = [];
    const load = (item: ChatAttachment, attempt: number) => api.chat.previewAttachment(conversationId, item.id).then(
      src => { keep(item.id, src); if (mounted.current) setSources(current => ({ ...current, [item.id]: src })); },
      reason => {
        if (!mounted.current) return;
        if (attempt < 4) { timers.push(setTimeout(() => void load(item, attempt + 1), 2500)); return; }
        setSources(current => ({ ...current, [item.id]: new Error(errorText(reason)) }));
      },
    );
    for (const item of images) if (!pictures.has(item.id)) void load(item, 0);
    return () => { for (const timer of timers) clearTimeout(timer); };
  }, [conversationId, images]);
  const copy = async (item: ChatAttachment) => {
    setError(null);
    try {
      if (typeof api.chat.copyAttachment !== "function") throw new Error("Copying pictures needs the updated Hello. main process and preload. Reopen Hello. when ready.");
      await api.chat.copyAttachment(conversationId, item.id);
    } catch (reason) { if (mounted.current) setError(errorText(reason)); }
  };
  const save = async (item: ChatAttachment) => {
    setError(null);
    try {
      if (typeof api.chat.saveAttachment !== "function") throw new Error("Saving pictures needs the updated Hello. main process and preload. Reopen Hello. when ready.");
      await api.chat.saveAttachment(conversationId, item.id);
    } catch (reason) { if (mounted.current) setError(errorText(reason)); }
  };
  const view = (item: ChatAttachment) => { setShown(item); setOpen(item); };
  // Closing the full-size view keeps what was drawn on it: the picture with its
  // marks is attached to this chat and goes into the message being written.
  const close = async () => {
    const item = open;
    setOpen(null);
    if (!item) return;
    try {
      const drawn = await annotator.current?.finish();
      if (!drawn) return;
      if (typeof api.chat.attachAnnotated !== "function") throw new Error("Annotated pictures need the updated Hello. main process and preload. Reopen Hello. when ready.");
      const result = await api.chat.attachAnnotated(conversationId, item.name, drawn.bytes);
      if (result.attachments.length) onAttach?.(result.attachments);
    } catch (reason) { if (mounted.current) setError(errorText(reason)); }
  };
  return (
    <div className="message-images-block">
      <div className="message-images" role="list" aria-label="Attached pictures">
        {images.map(item => {
          const src = sources[item.id];
          return (
            <button key={item.id} type="button" role="listitem" className="message-image" title={item.name}
              aria-label={`${item.name}: open full size; context menu to copy or save`}
              onClick={() => view(item)}
              onContextMenu={event => {
                // The picture's own menu, not the message's text menu around it.
                event.preventDefault();
                event.stopPropagation();
                const bounds = event.currentTarget.getBoundingClientRect();
                setMenu({ item, button: event.currentTarget, position: { x: event.clientX || bounds.left + 16, y: event.clientY || bounds.top + 16 } });
              }}>
              {typeof src === "string" ? <img src={src} alt={item.name} draggable={false} />
                : src instanceof Error ? <span className="message-image-missing">{item.name}</span>
                : <span className="message-image-loading" role="status">Loading {item.name}…</span>}
            </button>
          );
        })}
      </div>
      <ErrorNote error={error} />
      <ContextMenu position={menu?.position ?? null} ariaLabel="Picture actions"
        items={menu ? [
          { id: "copy-image", label: "Copy image", action: () => void copy(menu.item) },
          { id: "save-image", label: "Save image…", action: () => void save(menu.item) },
        ] : []}
        onClose={reason => {
          if (reason === "escape") menu?.button.focus({ preventScroll: true });
          setMenu(null);
        }} />
      <Dialog open={open !== null} title={shown?.name ?? "Picture"} className="attachment-preview" dismissOnBackdrop onClose={() => void close()}>
        {shown && (typeof sources[shown.id] === "string"
          ? <div onContextMenu={event => {
                // Inside the dialog, so the menu stacks above it (MenuLayer 300).
                event.preventDefault();
                event.stopPropagation();
                setViewMenu({ x: event.clientX, y: event.clientY });
              }}>
              <ImageAnnotator key={shown.id} ref={annotator} src={sources[shown.id] as string} alt={shown.name} />
              <ContextMenu position={viewMenu} ariaLabel="Picture actions"
                items={[
                  { id: "copy-image", label: "Copy image", action: () => void copy(shown) },
                  { id: "save-image", label: "Save image…", action: () => void save(shown) },
                ]}
                onClose={() => setViewMenu(null)} />
            </div>
          : sources[shown.id] instanceof Error ? <ErrorNote error={(sources[shown.id] as Error).message} />
          : <p role="status">Loading preview…</p>)}
      </Dialog>
    </div>
  );
}
