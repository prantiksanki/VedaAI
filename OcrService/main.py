import base64
import io

import pypdfium2 as pdfium
import pytesseract
from fastapi import FastAPI, File, HTTPException, UploadFile
from PIL import Image

app = FastAPI(title="VedaAI OCR Service (geometry only)")

MAX_DIMENSION = 2000  # cap longest edge; keeps inference fast and payloads small
PDF_RENDER_SCALE = 2.0


MIN_CONFIDENCE = 40  # Tesseract's 0-100 scale; below this is mostly noise/specks, not real text


def detect_word_boxes(pil_img: Image.Image) -> list[dict]:
    """
    Detection-only (no recognition/text-reading is trusted downstream). VedaAI's
    grading pipeline reads and transcribes handwriting with a vision LLM, which is
    far more accurate than any OCR text model - this service exists ONLY to return
    precise word/line bounding boxes for the answer-highlight overlay. Tesseract's
    own text output is discarded; only its word bounding boxes are used, which is
    lightweight enough to run without a GPU/PyTorch runtime.
    """
    img_w, img_h = pil_img.size
    data = pytesseract.image_to_data(pil_img, output_type=pytesseract.Output.DICT)
    words = []
    for i in range(len(data["text"])):
        if int(data["conf"][i]) < MIN_CONFIDENCE:
            continue
        if not data["text"][i].strip():
            continue
        x, y, w, h = data["left"][i], data["top"][i], data["width"][i], data["height"][i]
        if w <= 0 or h <= 0:
            continue
        # Reject boxes that fall outside the page (or nearly cover it) - stray
        # detections on noise/artifacts, never a real word.
        if x < 0 or y < 0 or x + w > img_w or y + h > img_h:
            continue
        if w > img_w * 0.9 or h > img_h * 0.9:
            continue
        words.append({"x": float(x), "y": float(y), "width": float(w), "height": float(h)})
    return words


def _vertical_overlap_ratio(a: dict, b: dict) -> float:
    """Fraction of the shorter fragment's height that overlaps with the other's y-range."""
    a_top, a_bottom = a["y"], a["y"] + a["height"]
    b_top, b_bottom = b["y"], b["y"] + b["height"]
    overlap = min(a_bottom, b_bottom) - max(a_top, b_top)
    if overlap <= 0:
        return 0.0
    shorter = min(a["height"], b["height"])
    return overlap / shorter if shorter > 0 else 0.0


def merge_word_boxes_into_lines(words: list[dict]) -> list[dict]:
    """
    Groups detected WORD boxes into LINE boxes: words whose vertical spans
    substantially overlap are on the same row. A handwritten line can arrive as
    several separate word detections; this unions them into one box per line so a
    highlight covers the whole line instead of a patchwork of small boxes.

    Deliberately conservative: requires strong overlap (not mere proximity) so
    tightly spaced but genuinely separate lines are not glued together.
    """
    if not words:
        return []

    OVERLAP_THRESHOLD = 0.5

    remaining = list(words)
    groups = []
    while remaining:
        seed = remaining.pop(0)
        group = [seed]
        i = 0
        while i < len(remaining):
            candidate = remaining[i]
            if any(_vertical_overlap_ratio(candidate, member) >= OVERLAP_THRESHOLD for member in group):
                group.append(remaining.pop(i))
            else:
                i += 1
        groups.append(group)

    merged = []
    for group in groups:
        group.sort(key=lambda w: w["x"])
        x0 = min(w["x"] for w in group)
        y0 = min(w["y"] for w in group)
        x1 = max(w["x"] + w["width"] for w in group)
        y1 = max(w["y"] + w["height"] for w in group)
        merged.append(
            {
                "x": round(x0, 4),
                "y": round(y0, 4),
                "width": round(x1 - x0, 4),
                "height": round(y1 - y0, 4),
            }
        )
    return merged


def clamp_scale(width: int, height: int, scale: float) -> float:
    longest_edge = max(width, height) * scale
    if longest_edge <= MAX_DIMENSION:
        return scale
    return scale * (MAX_DIMENSION / longest_edge)


def pdf_to_page_images(data: bytes) -> list[Image.Image]:
    pdf = pdfium.PdfDocument(data)
    images = []
    for page in pdf:
        width, height = page.get_size()
        scale = clamp_scale(width, height, PDF_RENDER_SCALE)
        bitmap = page.render(scale=scale)
        images.append(bitmap.to_pil())
    return images


def load_page_images(filename: str, content_type: str, data: bytes) -> list[Image.Image]:
    if content_type == "application/pdf" or filename.lower().endswith(".pdf"):
        return pdf_to_page_images(data)

    image = Image.open(io.BytesIO(data)).convert("RGB")
    scale = clamp_scale(image.width, image.height, 1.0)
    if scale < 1.0:
        image = image.resize((int(image.width * scale), int(image.height * scale)))
    return [image]


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/detect-lines")
async def detect_lines(file: UploadFile = File(...)):
    """
    Geometry only: returns each page's text-LINE bounding boxes (normalized 0-1),
    numbered in reading order, and the page image. No text is read or returned -
    the caller (a vision LLM) reads content and picks which line indices belong to
    each answer; this endpoint exists purely to give those picks pixel-precise boxes.
    """
    data = await file.read()
    try:
        page_images = load_page_images(file.filename or "", file.content_type or "", data)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not read file: {exc}") from exc

    if not page_images:
        raise HTTPException(status_code=400, detail="No pages found in file")

    pages_out = []
    for page_index, pil_img in enumerate(page_images):
        width, height = pil_img.size
        raw_words = detect_word_boxes(pil_img)
        words = [
            {
                "x": round(w["x"] / width, 4),
                "y": round(w["y"] / height, 4),
                "width": round(w["width"] / width, 4),
                "height": round(w["height"] / height, 4),
            }
            for w in raw_words
        ]
        lines_out = merge_word_boxes_into_lines(words)
        # Reading order top-to-bottom, then left-to-right within a row. Assumes
        # single-column layout - a strict y-then-x sort will interleave columns
        # row-by-row on multi-column pages.
        lines_out.sort(key=lambda line: (line["y"], line["x"]))
        for i, line in enumerate(lines_out):
            line["index"] = i
        jpeg_bytes = _pil_to_bytes(pil_img)
        pages_out.append(
            {
                "page": page_index + 1,
                "width": width,
                "height": height,
                "lines": lines_out,
                "dataUrl": f"data:image/jpeg;base64,{base64.b64encode(jpeg_bytes).decode('ascii')}",
            }
        )

    return {"pages": pages_out}


def _pil_to_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    return buf.getvalue()
