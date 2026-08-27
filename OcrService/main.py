import base64
import io

import pypdfium2 as pdfium
from doctr.io import DocumentFile
from doctr.models import ocr_predictor
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from PIL import Image

app = FastAPI(title="VedaAI OCR Service")

MAX_DIMENSION = 2000  # cap longest edge; keeps inference fast and payloads small
PDF_RENDER_SCALE = 2.0

_predictors = {}


def get_predictor(doc_type: str):
    """
    Two separate predictors, routed by document type:
    - "printed": question papers are virtually always clean printed/typed text -
      fast, small backbones are accurate enough and keep this path quick.
    - "handwritten": answer sheets are virtually always handwritten - use docTR's
      strongest recognition architecture (parseq), which handles messier,
      more varied strokes far better than the small CRNN model.
    """
    if doc_type not in _predictors:
        if doc_type == "handwritten":
            _predictors[doc_type] = ocr_predictor(
                det_arch="db_resnet50",
                reco_arch="parseq",
                pretrained=True,
            )
        else:
            _predictors[doc_type] = ocr_predictor(
                det_arch="db_mobilenet_v3_large",
                reco_arch="crnn_mobilenet_v3_small",
                pretrained=True,
            )
    return _predictors[doc_type]


def _vertical_overlap_ratio(a: dict, b: dict) -> float:
    """Fraction of the shorter fragment's height that overlaps with the other's y-range."""
    a_top, a_bottom = a["y"], a["y"] + a["height"]
    b_top, b_bottom = b["y"], b["y"] + b["height"]
    overlap = min(a_bottom, b_bottom) - max(a_top, b_top)
    if overlap <= 0:
        return 0.0
    shorter = min(a["height"], b["height"])
    return overlap / shorter if shorter > 0 else 0.0


def merge_line_fragments(lines: list[dict]) -> list[dict]:
    """
    docTR's line detector can split a single visual line of (especially handwritten)
    text into multiple fragments with slightly different y-positions. Group fragments
    whose vertical spans substantially overlap (i.e. they are genuinely on the same
    row, not just vertically close) and merge each group into one line: concatenated
    text in left-to-right order, and a bounding box that unions all fragments - so a
    highlight covers the whole line instead of a patchwork of small boxes.

    Deliberately conservative: requires strong overlap (not mere proximity) so tightly
    spaced but genuinely separate handwritten lines are not glued together. Some real
    fragmentation may remain unmerged (multiple boxes per line) rather than risk a
    wrong merge that scrambles word order across lines.
    """
    if not lines:
        return []

    OVERLAP_THRESHOLD = 0.5

    remaining = list(lines)
    groups = []
    while remaining:
        seed = remaining.pop(0)
        group = [seed]
        i = 0
        while i < len(remaining):
            candidate = remaining[i]
            # Compare against every fragment already in the group (not a drifting
            # running bound) so the merge test stays anchored to real rows.
            if any(_vertical_overlap_ratio(candidate, member) >= OVERLAP_THRESHOLD for member in group):
                group.append(remaining.pop(i))
            else:
                i += 1
        groups.append(group)

    merged = []
    for group in groups:
        group.sort(key=lambda line: line["x"])
        text = " ".join(line["text"] for line in group)
        x0 = min(line["x"] for line in group)
        y0 = min(line["y"] for line in group)
        x1 = max(line["x"] + line["width"] for line in group)
        y1 = max(line["y"] + line["height"] for line in group)
        merged.append(
            {
                "text": text,
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


@app.on_event("startup")
def preload_models():
    # Load (and download, on first run) model weights eagerly so the first
    # real OCR request isn't slowed down by a model download/load.
    get_predictor("printed")
    get_predictor("handwritten")


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/ocr")
async def ocr(file: UploadFile = File(...), doc_type: str = Form("printed")):
    if doc_type not in ("printed", "handwritten"):
        raise HTTPException(status_code=400, detail='doc_type must be "printed" or "handwritten"')

    data = await file.read()
    try:
        page_images = load_page_images(file.filename or "", file.content_type or "", data)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not read file: {exc}") from exc

    if not page_images:
        raise HTTPException(status_code=400, detail="No pages found in file")

    predictor = get_predictor(doc_type)
    doc = DocumentFile.from_images([_pil_to_bytes(img) for img in page_images])
    result = predictor(doc)

    pages_out = []
    for page_index, (page, pil_img) in enumerate(zip(result.pages, page_images)):
        width, height = pil_img.size
        lines_out = []
        for block in page.blocks:
            for line in block.lines:
                text = " ".join(word.value for word in line.words).strip()
                if not text:
                    continue
                (x0, y0), (x1, y1) = line.geometry
                lines_out.append(
                    {
                        "text": text,
                        # geometry from docTR is already normalized 0-1, matching what the frontend expects
                        "x": round(x0, 4),
                        "y": round(y0, 4),
                        "width": round(x1 - x0, 4),
                        "height": round(y1 - y0, 4),
                    }
                )
        lines_out = merge_line_fragments(lines_out)
        # Block order from the detector isn't guaranteed to be strict top-to-bottom reading
        # order; sort explicitly since downstream prompts number lines assuming that order.
        # Note: this assumes single-column layout - a strict y-then-x sort will interleave
        # left/right columns row-by-row on multi-column pages.
        lines_out.sort(key=lambda line: (line["y"], line["x"]))
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
