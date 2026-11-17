/**
 * Hello's own program for PDFs: what a file is made of, and a VECTOR PDF made
 * smaller without rasterising it — a plan from CorelDRAW, AutoCAD or
 * Illustrator stays a drawing; its numbers are written shorter and what is
 * said twice is said once.
 *
 * The method is the owner's (a script a Claude agent wrote for their plans,
 * 16.11; docs/PROVENANCE.md): four levels from lossless to whole points, the
 * first one that reaches the target wins, and both files are rendered and
 * compared pixel by pixel before the result is called good. It is fixed: what
 * the model chooses arrives as data (a JSON job), never as code.
 *
 * Changed from the script it came from:
 * - a graphics-state table shared by several pages is renamed once, not once
 *   per page — the second page would have kept names that no longer exist;
 * - the scale and rotation of a matrix (`cm`, `Tm`) are left as written: a
 *   CAD export scales by 0.0003, which three decimals round to nothing;
 * - it answers in JSON, and says in so many words when it could not verify.
 */
export const PDF_PROGRAM = String.raw`
import json, os, shutil, subprocess, sys, tempfile
from decimal import Decimal

import pikepdf

# From the safest to the most aggressive: decimals kept for |x| >= 100, for 10 <= |x| < 100, for |x| < 10.
LEVELS = [
    ("lossless: duplicates removed, streams recompressed", None),
    ("coordinates to 2 decimals", (2, 2, 3)),
    ("coordinates to 1 decimal", (1, 1, 3)),
    ("whole points from 100 pt up, 1 to 3 decimals below", (0, 1, 3)),
]
TEXT_STRING_OPS = {"Tj", "TJ", "'", '"', "BDC", "DP", "MP", "BMC"}
MATRIX_OPS = {"cm", "Tm"}
STROKE_SPACE, STROKE_COLOR, STROKE_DIRECT = "CS", ("SC", "SCN"), ("RG", "G", "K")
FILL_SPACE, FILL_COLOR, FILL_DIRECT = "cs", ("sc", "scn"), ("rg", "g", "k")


def say(text):
    print(text, flush=True)


def analyze(path):
    pdf = pikepdf.open(path)
    images = drawing = fonts = 0
    states = 0
    for o in pdf.objects:
        if isinstance(o, pikepdf.Stream):
            size = len(o.read_raw_bytes())
            kind = o.get("/Subtype")
            if kind == pikepdf.Name.Image:
                images += size
            elif "/Length1" in o or "/Length2" in o or kind in (pikepdf.Name("/Type1C"), pikepdf.Name("/OpenType"), pikepdf.Name("/CIDFontType0C")):
                fonts += size
            else:
                drawing += size
        elif isinstance(o, pikepdf.Dictionary) and o.get("/Type") == pikepdf.Name.ExtGState:
            states += 1
    return {"bytes": os.path.getsize(path), "pages": len(pdf.pages), "imageBytes": images, "drawingBytes": drawing,
            "fontBytes": fonts, "graphicsStates": states, "dominatedBy": "images" if images > drawing else "drawing"}


def rounded(d, nd):
    f = float(d)
    a = abs(f)
    places = nd[0] if a >= 100 else (nd[1] if a >= 10 else nd[2])
    v = round(f, places)
    if places == 0:
        return int(v)
    v = Decimal(repr(v))
    return 0 if v == 0 else v


def round_operands(op, operands, nd):
    if nd is None or op in TEXT_STRING_OPS:
        return operands
    out = []
    for index, x in enumerate(operands):
        # The scale and rotation of a matrix are not coordinates: left as written.
        if op in MATRIX_OPS and index < 4:
            out.append(x)
        elif isinstance(x, Decimal):
            out.append(rounded(x, nd))
        elif isinstance(x, pikepdf.Array) and op == "d":
            out.append(pikepdf.Array([rounded(Decimal(str(float(y))), (2, 2, 3)) if isinstance(y, Decimal) else y for y in x]))
        else:
            out.append(x)
    return out


def process(ops, nd, renamed):
    """Numbers rounded, a colour set again to what it already is left out, a line to the point it starts from left out.
    The geometry, the order of drawing and the text are not touched."""
    out = []
    state = {"S": None, "F": None}
    stack = []
    last_point = None
    i, n = 0, len(ops)

    def made(operands, operator):
        return pikepdf.ContentStreamInstruction(operands, operator)

    while i < n:
        ins = ops[i]
        if isinstance(ins, pikepdf.ContentStreamInlineImage):
            out.append(ins); last_point = None; i += 1; continue
        op = str(ins.operator)
        operands = round_operands(op, list(ins.operands), nd)
        if op == "gs" and renamed and operands and str(operands[0]) in renamed:
            operands[0] = pikepdf.Name(renamed[str(operands[0])])
        if op == "q":
            stack.append(dict(state))
        elif op == "Q":
            state = stack.pop() if stack else {"S": None, "F": None}
        for side, space, colour, direct in (("S", STROKE_SPACE, STROKE_COLOR, STROKE_DIRECT), ("F", FILL_SPACE, FILL_COLOR, FILL_DIRECT)):
            if op == space:
                following = ops[i + 1] if i + 1 < n and not isinstance(ops[i + 1], pikepdf.ContentStreamInlineImage) else None
                if following is not None and str(following.operator) in colour:
                    values = round_operands(str(following.operator), list(following.operands), nd)
                    key = (tuple(map(str, operands)), str(following.operator), tuple(map(str, values)))
                    if state[side] == key:
                        i += 2; break
                    out.append(made(operands, ins.operator)); out.append(made(values, following.operator))
                    state[side] = key; i += 2; break
                state[side] = None
                out.append(made(operands, ins.operator)); i += 1; break
            if op in colour:
                state[side] = None
                out.append(made(operands, ins.operator)); i += 1; break
            if op in direct:
                key = (op, tuple(map(str, operands)))
                if state[side] == key:
                    i += 1; break
                state[side] = key
                out.append(made(operands, ins.operator)); i += 1; break
        else:
            if op == "l" and len(operands) == 2 and last_point == (str(operands[0]), str(operands[1])):
                i += 1; continue
            if op in ("m", "l") and len(operands) == 2:
                last_point = (str(operands[0]), str(operands[1]))
            elif op in ("c", "v", "y") and len(operands) >= 2:
                last_point = (str(operands[-2]), str(operands[-1]))
            else:
                last_point = None
            out.append(made(operands, ins.operator)); i += 1
    return out


def one_state_table(resources, done):
    """Graphics states that say the same thing become one. Returns old name -> new name, the same for every page that shares the table."""
    if resources is None or "/ExtGState" not in resources:
        return {}
    shared = resources.objgen if resources.is_indirect else None
    if shared is not None and shared in done:
        return done[shared]
    table = resources.ExtGState
    canon, renamed, kept = {}, {}, {}
    for key in list(table.keys()):
        o = table[key]
        try:
            signature = repr(sorted((str(a), repr(b)) for a, b in o.items()))
        except Exception:
            signature = "only:" + key
        if signature not in canon:
            canon[signature] = "/G%d" % len(canon)
            kept[canon[signature]] = o
        renamed[key] = canon[signature]
    resources.ExtGState = pikepdf.Dictionary(kept)
    if shared is not None:
        done[shared] = renamed
    return renamed


def rewrite(pdf, container, resources, nd, is_page, seen, done):
    renamed = one_state_table(resources, done)
    if is_page:
        ops = pikepdf.parse_content_stream(pikepdf.Page(container))
        container.Contents = pdf.make_stream(pikepdf.unparse_content_stream(process(ops, nd, renamed)))
    else:
        ops = pikepdf.parse_content_stream(container)
        container.write(pikepdf.unparse_content_stream(process(ops, nd, renamed)))
    if resources is not None and "/XObject" in resources:
        for _, form in resources.XObject.items():
            if form.get("/Subtype") == pikepdf.Name.Form and form.objgen not in seen:
                seen.add(form.objgen)
                rewrite(pdf, form, form.get("/Resources"), nd, False, seen, done)


def compress(source, target, nd):
    pdf = pikepdf.open(source)
    seen, done = set(), {}
    for page in pdf.pages:
        rewrite(pdf, page.obj, page.obj.get("/Resources"), nd, True, seen, done)
    pdf.remove_unreferenced_resources()
    pdf.save(target, object_stream_mode=pikepdf.ObjectStreamMode.generate, compress_streams=True, recompress_flate=True)
    if shutil.which("qpdf"):
        again = target + ".q.pdf"
        ran = subprocess.run(["qpdf", "--object-streams=generate", "--recompress-flate", "--compression-level=9", target, again], capture_output=True)
        if ran.returncode in (0, 3) and os.path.exists(again) and os.path.getsize(again) < os.path.getsize(target):
            os.replace(again, target)
        elif os.path.exists(again):
            os.remove(again)
    return os.path.getsize(target)


def verify(source, target, most=0.005, pages_checked=20):
    """Both files rendered, page by page, and their pixels compared."""
    if not shutil.which("pdftoppm"):
        return {"done": False, "reason": "pdftoppm is not installed (it comes with poppler: brew install poppler)"}
    try:
        from PIL import Image, ImageChops
    except ImportError:
        return {"done": False, "reason": "Pillow could not be installed into Hello's Python"}
    Image.MAX_IMAGE_PIXELS = None
    count = len(pikepdf.open(source).pages)
    pages, ok = [], True
    with tempfile.TemporaryDirectory() as folder:
        for number in range(1, min(count, pages_checked) + 1):
            pictures = []
            for tag, path in (("a", source), ("b", target)):
                prefix = os.path.join(folder, "%s%d" % (tag, number))
                subprocess.run(["pdftoppm", "-f", str(number), "-l", str(number), "-scale-to", "2000", "-png", "-singlefile", path, prefix], check=True, capture_output=True)
                pictures.append(Image.open(prefix + ".png").convert("RGB"))
            a, b = pictures
            if a.size != b.size:
                ok = False
                pages.append({"page": number, "ok": False, "reason": "the page is another size: %s against %s" % (a.size, b.size)})
                continue
            different = sum(ImageChops.difference(a, b).convert("L").histogram()[40:])
            share = different / (a.width * a.height)
            if share > most:
                ok = False
            pages.append({"page": number, "differentPixels": different, "share": round(share, 6), "ok": share <= most})
    return {"done": True, "ok": ok, "pages": pages, "pagesChecked": len(pages), "pagesInFile": count, "threshold": most}


def main():
    job = json.loads(os.environ["HELLO_PDF_JOB"])
    source = job["input"]
    result = {"input": analyze(source)}
    if job.get("analyze"):
        return result
    target = job["output"]
    want = job.get("targetBytes")
    best, levels = None, []
    with tempfile.TemporaryDirectory() as folder:
        for level, (name, nd) in enumerate(LEVELS[: int(job.get("maxLevel", 3)) + 1]):
            out = os.path.join(folder, "L%d.pdf" % level)
            say("level %d: %s ..." % (level, name))
            size = compress(source, out, nd)
            levels.append({"level": level, "name": name, "bytes": size})
            if best is None or size < best[1]:
                best = (out, size, level, name)
            if want is None or size <= want:
                break
        shutil.copyfile(best[0], target)
    result.update({"levels": levels, "chosen": {"level": best[2], "name": best[3], "bytes": best[1]}, "output": target,
                   "targetBytes": want, "reachedTarget": None if want is None else best[1] <= want})
    say("comparing the two files, page by page ...")
    try:
        result["verification"] = verify(source, target)
    except Exception as error:
        result["verification"] = {"done": False, "reason": "the comparison could not run: %s" % str(error)[:300]}
    return result


if __name__ == "__main__":
    # The answer goes to a file of its own: what is printed passes through the shell's filters, and is for a person to read.
    answer = main()
    with open(os.environ["HELLO_PDF_RESULT"], "w", encoding="utf-8") as out:
        json.dump(answer, out)
    say("done")
`;
