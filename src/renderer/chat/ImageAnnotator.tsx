import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { Circle, Eraser, Minus, MoveUpRight, Pencil, Square, Undo2 } from "lucide-react";

/**
 * Drawing on a sent picture before it goes back into the chat (user, 26.11):
 * freehand, a few shapes and five quick colors — enough to point at what you
 * mean. The marks are kept in the picture's own pixels, so the flattened
 * result is as sharp as the original; the dialog that holds this adds it to
 * the composer when it closes (see MessageImages).
 */

type Tool = "pen" | "arrow" | "line" | "rect" | "ellipse";
interface Point { x: number; y: number }
interface Mark { tool: Tool; color: string; width: number; points: Point[] }

const TOOLS: Array<{ tool: Tool; label: string; Icon: typeof Pencil }> = [
  { tool: "pen", label: "Draw", Icon: Pencil },
  { tool: "arrow", label: "Arrow", Icon: MoveUpRight },
  { tool: "line", label: "Line", Icon: Minus },
  { tool: "rect", label: "Rectangle", Icon: Square },
  { tool: "ellipse", label: "Ellipse", Icon: Circle },
];
const COLORS: Array<{ value: string; label: string }> = [
  { value: "#ff3b30", label: "Red" },
  { value: "#ffcc00", label: "Yellow" },
  { value: "#34c759", label: "Green" },
  { value: "#007aff", label: "Blue" },
  { value: "#ffffff", label: "White" },
];
// What main takes for one picture (attachments.ts: 5 MiB each).
const PICTURE_LIMIT = 5 * 1024 * 1024;

function draw(context: CanvasRenderingContext2D, mark: Mark): void {
  const [a, b] = [mark.points[0], mark.points[mark.points.length - 1]];
  if (!a || !b) return;
  context.strokeStyle = mark.color;
  context.lineWidth = mark.width;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.beginPath();
  if (mark.tool === "pen") {
    context.moveTo(a.x, a.y);
    for (let index = 1; index < mark.points.length - 1; index++) {
      const here = mark.points[index], next = mark.points[index + 1];
      context.quadraticCurveTo(here.x, here.y, (here.x + next.x) / 2, (here.y + next.y) / 2);
    }
    context.lineTo(b.x, b.y);
  } else if (mark.tool === "line" || mark.tool === "arrow") {
    context.moveTo(a.x, a.y);
    context.lineTo(b.x, b.y);
    if (mark.tool === "arrow") {
      const angle = Math.atan2(b.y - a.y, b.x - a.x), head = mark.width * 4;
      for (const side of [-1, 1]) {
        context.moveTo(b.x, b.y);
        context.lineTo(b.x - head * Math.cos(angle + side * Math.PI / 7), b.y - head * Math.sin(angle + side * Math.PI / 7));
      }
    }
  } else if (mark.tool === "rect") {
    context.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  } else {
    context.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
  }
  context.stroke();
}

function blob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise(resolve => canvas.toBlob(resolve, type, quality));
}

export interface ImageAnnotatorHandle {
  /** The picture with its marks, flattened, or null when nothing was drawn. */
  finish(): Promise<{ bytes: Uint8Array; extension: "png" | "jpg" } | null>;
}

export const ImageAnnotator = forwardRef<ImageAnnotatorHandle, { src: string; alt: string }>(
  function ImageAnnotator({ src, alt }, handle) {
    const image = useRef<HTMLImageElement | null>(null);
    const canvas = useRef<HTMLCanvasElement>(null);
    const [size, setSize] = useState<{ width: number; height: number } | null>(null);
    const [tool, setTool] = useState<Tool>("pen");
    const [color, setColor] = useState(COLORS[0].value);
    const [marks, setMarks] = useState<Mark[]>([]);
    const drawing = useRef<Mark | null>(null);
    const [, redraw] = useState(0);

    // A line about 1/300 of the picture's longer side: the same weight on a screenshot and on a thumbnail.
    const width = size ? Math.max(3, Math.round(Math.max(size.width, size.height) / 300)) : 4;

    // One canvas holds the picture and the marks, at the picture's own size; CSS
    // scales it as it would an image, so a pointer's place on it is a pixel of it.
    useEffect(() => {
      const picture = new Image();
      picture.onload = () => { image.current = picture; setSize({ width: picture.naturalWidth, height: picture.naturalHeight }); };
      picture.src = src;
      return () => { picture.onload = null; };
    }, [src]);

    useLayoutEffect(() => {
      const node = canvas.current;
      const context = node?.getContext("2d");
      if (!node || !context || !size || !image.current) return;
      context.clearRect(0, 0, node.width, node.height);
      context.drawImage(image.current, 0, 0, size.width, size.height);
      for (const mark of marks) draw(context, mark);
      if (drawing.current) draw(context, drawing.current);
    });

    useEffect(() => {
      const undo = (event: KeyboardEvent) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z" && !event.shiftKey) {
          event.preventDefault();
          setMarks(current => current.slice(0, -1));
        }
      };
      window.addEventListener("keydown", undo);
      return () => window.removeEventListener("keydown", undo);
    }, []);

    useImperativeHandle(handle, () => ({
      async finish() {
        const picture = image.current;
        if (!marks.length || !picture || !size) return null;
        const flat = document.createElement("canvas");
        flat.width = size.width;
        flat.height = size.height;
        const context = flat.getContext("2d");
        if (!context) return null;
        context.drawImage(picture, 0, 0, size.width, size.height);
        for (const mark of marks) draw(context, mark);
        // PNG keeps a screenshot's text crisp; past main's limit, a JPEG of the same picture.
        let made = await blob(flat, "image/png"), extension: "png" | "jpg" = "png";
        for (const quality of [0.92, 0.85, 0.75]) {
          if (made && made.size <= PICTURE_LIMIT) break;
          made = await blob(flat, "image/jpeg", quality);
          extension = "jpg";
        }
        if (!made || made.size > PICTURE_LIMIT) throw new Error("The annotated picture is larger than the 5 MiB a message takes.");
        return { bytes: new Uint8Array(await made.arrayBuffer()), extension };
      },
    }), [marks, size]);

    const at = (event: React.PointerEvent<HTMLCanvasElement>): Point => {
      const box = event.currentTarget.getBoundingClientRect();
      return {
        x: ((event.clientX - box.left) / box.width) * (size?.width ?? box.width),
        y: ((event.clientY - box.top) / box.height) * (size?.height ?? box.height),
      };
    };

    return (
      <div className="image-annotator">
        <div className="image-annotator-stage">
          {size ? <canvas ref={canvas} width={size.width} height={size.height} role="img" aria-label={`${alt} — draw on it`}
            onPointerDown={event => {
              if (event.button !== 0) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              const point = at(event);
              drawing.current = { tool, color, width, points: [point, point] };
              redraw(value => value + 1);
            }}
            onPointerMove={event => {
              const mark = drawing.current;
              if (!mark) return;
              const point = at(event);
              if (mark.tool === "pen") mark.points.push(point);
              else mark.points[1] = point;
              redraw(value => value + 1);
            }}
            onPointerUp={() => {
              const mark = drawing.current;
              drawing.current = null;
              if (!mark) return;
              const [a, b] = [mark.points[0], mark.points[mark.points.length - 1]];
              // A click without a drag draws nothing, except a dot with the pen.
              if (mark.tool === "pen" || Math.hypot(b.x - a.x, b.y - a.y) > 2) setMarks(current => [...current, mark]);
              else redraw(value => value + 1);
            }}
            onPointerCancel={() => { drawing.current = null; redraw(value => value + 1); }} />
            : <p role="status">Loading preview…</p>}
        </div>
        <div className="image-annotator-bar" role="toolbar" aria-label="Draw on the picture; closing adds it to your message">
          {TOOLS.map(({ tool: value, label, Icon }) => (
            <button key={value} type="button" title={label} aria-label={label} aria-pressed={tool === value}
              className={tool === value ? "is-active" : undefined} onClick={() => setTool(value)}>
              <Icon size={15} aria-hidden />
            </button>
          ))}
          <span className="image-annotator-divider" aria-hidden />
          {COLORS.map(({ value, label }) => (
            <button key={value} type="button" title={label} aria-label={`${label} ink`} aria-pressed={color === value}
              className={`image-annotator-color${color === value ? " is-active" : ""}`} onClick={() => setColor(value)}>
              <span style={{ background: value }} />
            </button>
          ))}
          <span className="image-annotator-divider" aria-hidden />
          <button type="button" title="Undo (⌘Z)" aria-label="Undo" disabled={!marks.length} onClick={() => setMarks(current => current.slice(0, -1))}>
            <Undo2 size={15} aria-hidden />
          </button>
          <button type="button" title="Clear the drawing" aria-label="Clear the drawing" disabled={!marks.length} onClick={() => setMarks([])}>
            <Eraser size={15} aria-hidden />
          </button>
        </div>
      </div>
    );
  },
);
