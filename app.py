import os
import re
import glob
import time
import uuid
import shutil
import threading
import subprocess
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape as xml_escape

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Request
from starlette.exceptions import HTTPException as StarletteHTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask

# ---------- Settings ----------
LIBREOFFICE = os.environ.get("LIBREOFFICE", r"C:\Program Files\LibreOffice\program\soffice.exe")
PDF2DOCX = shutil.which("pdf2docx") or "pdf2docx"
TESSERACT = os.environ.get("TESSERACT", shutil.which("tesseract") or "tesseract")
PDFTOPPM = os.environ.get("PDFTOPPM", shutil.which("pdftoppm") or "pdftoppm")
PDFINFO = os.environ.get("PDFINFO", shutil.which("pdfinfo") or "pdfinfo")


def find_ghostscript() -> str:
    """Ghostscript is 'gs' on Linux and 'gswin64c' on Windows."""
    if os.environ.get("GHOSTSCRIPT"):
        return os.environ["GHOSTSCRIPT"]
    for name in ("gs", "gswin64c"):
        if shutil.which(name):
            return shutil.which(name)
    found = sorted(glob.glob(r"C:\Program Files\gs\*\bin\gswin64c.exe"))
    return found[-1] if found else "gs"


GHOSTSCRIPT = find_ghostscript()
# Compression levels: how much images are shrunk
COMPRESS_LEVELS = {
    "recommended": "/ebook",   # 150 dpi images
    "strong": "/screen",       # 72 dpi images, smallest
    "light": "/printer",       # 300 dpi images, best quality
}
WORK_DIR = Path("files")
PAGES_DIR = Path("pages")
STATIC_DIR = Path("static")
MAX_FILE_SIZE = 20 * 1024 * 1024   # 20 MB for most tools
COMPRESS_MAX_SIZE = 100 * 1024 * 1024   # 100 MB for Compress PDF
CONVERT_TIMEOUT = 120              # seconds
OCR_TIMEOUT = 300                  # seconds; OCR is slow (about 3 s a page)
OCR_MAX_PAGES = 20
PPT_PICTURE_MAX_PAGES = 60
# OCR languages people can choose: form value -> Tesseract languages
OCR_LANGS = {"eng": "eng", "urd": "urd+eng", "hin": "hin+eng", "ara": "ara+eng"}
RTL_LANGS = {"urd", "ara"}
KEEP_FILES_FOR = 60 * 60           # 1 hour
CLEANUP_EVERY = 10 * 60            # 10 minutes

WORK_DIR.mkdir(exist_ok=True)

# docs_url=None hides the /docs test page from the public
app = FastAPI(title="GetPDF360", docs_url=None, redoc_url=None, openapi_url=None)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


# ---------- Friendly 404 page ----------
@app.exception_handler(StarletteHTTPException)
async def http_error(request: Request, exc: StarletteHTTPException):
    """Show a branded page for unknown addresses; keep JSON errors for the tools."""
    if exc.status_code == 404 and request.method == "GET" and not request.url.path.startswith("/api/"):
        return FileResponse(PAGES_DIR / "404.html", status_code=404, media_type="text/html")
    return JSONResponse({"detail": exc.detail}, status_code=exc.status_code, headers=getattr(exc, "headers", None))


# ---------- Helpers ----------
def new_job_dir() -> Path:
    job_dir = WORK_DIR / str(uuid.uuid4())
    job_dir.mkdir()
    return job_dir


def delete_job(job_dir: Path):
    shutil.rmtree(job_dir, ignore_errors=True)


def save_upload(file: UploadFile, job_dir: Path, extension: str, max_size: int = MAX_FILE_SIZE) -> Path:
    """Save the upload in 1 MB chunks, stopping if it gets too big."""
    path = job_dir / ("input" + extension)
    size = 0
    with open(path, "wb") as f:
        while chunk := file.file.read(1024 * 1024):
            size += len(chunk)
            if size > max_size:
                raise HTTPException(413, f"File is too large. The limit is {max_size // (1024 * 1024)} MB.")
            f.write(chunk)
    if size == 0:
        raise HTTPException(400, "The file is empty.")
    return path


def check_signature(path: Path, kind: str):
    """Check the file's first bytes, not just its name."""
    with open(path, "rb") as f:
        start = f.read(8)
    if kind == "pdf" and not start.startswith(b"%PDF"):
        raise HTTPException(400, "This is not a valid PDF file.")
    if kind == "image" and not (start.startswith(b"\xff\xd8") or start.startswith(b"\x89PNG")):
        raise HTTPException(400, "This isn't a valid JPG or PNG image.")
    if kind in ("word", "office") and not (start.startswith(b"PK\x03\x04") or start.startswith(b"\xd0\xcf\x11\xe0")):
        raise HTTPException(400, "This is not a valid Word file." if kind == "word" else "This file isn't a valid document.")


def run_command(command: list[str], timeout: int = CONVERT_TIMEOUT):
    # One thread per program: the server has one CPU, so this keeps OCR from slowing everything else
    env = dict(os.environ, OMP_THREAD_LIMIT="1")
    try:
        return subprocess.run(command, check=True, timeout=timeout, capture_output=True, env=env)
    except subprocess.TimeoutExpired:
        raise HTTPException(504, "The conversion took too long. Please try a smaller file.")
    except subprocess.CalledProcessError:
        raise HTTPException(500, "Sorry, that file couldn't be converted.")
    except FileNotFoundError:
        raise HTTPException(500, "This tool needs extra software that isn't installed on this computer. It works on the live site.")


def pdf_page_count(path: Path) -> int:
    """Number of pages, using pdfinfo. Returns 0 if it can't tell."""
    try:
        out = run_command([PDFINFO, str(path)]).stdout.decode("utf-8", "ignore")
    except HTTPException:
        return 0
    m = re.search(r"^Pages:\s+(\d+)", out, re.M)
    return int(m.group(1)) if m else 0


def cleanup_loop():
    """Every 10 minutes, delete anything older than 1 hour."""
    while True:
        try:
            cutoff = time.time() - KEEP_FILES_FOR
            for item in WORK_DIR.iterdir():
                if item.stat().st_mtime < cutoff:
                    if item.is_dir():
                        shutil.rmtree(item, ignore_errors=True)
                    else:
                        item.unlink(missing_ok=True)
        except Exception:
            pass
        time.sleep(CLEANUP_EVERY)


threading.Thread(target=cleanup_loop, daemon=True).start()


def send_result(output_path: Path, name: str, media_type: str, job_dir: Path):
    """Send the converted file, then delete the job folder.
    The job id header lets the page confirm the deletion (privacy receipt)."""
    return FileResponse(
        output_path,
        filename=name,
        media_type=media_type,
        headers={"X-Job-Id": job_dir.name, "Cache-Control": "no-store"},
        background=BackgroundTask(delete_job, job_dir),
    )


# ---------- Conversion endpoints ----------
@app.post("/word-to-pdf")
def word_to_pdf(file: UploadFile = File(...)):
    extension = Path(file.filename or "").suffix.lower()
    if extension not in (".doc", ".docx"):
        raise HTTPException(400, "Please upload a .doc or .docx file.")

    job_dir = new_job_dir()
    try:
        input_path = save_upload(file, job_dir, extension)
        check_signature(input_path, "word")
        profile = (job_dir / "lo-profile").resolve().as_uri()
        run_command([
            LIBREOFFICE, f"-env:UserInstallation={profile}",
            "--headless", "--convert-to", "pdf",
            "--outdir", str(job_dir), str(input_path),
        ])
        output_path = job_dir / "input.pdf"
        if not output_path.exists():
            raise HTTPException(500, "Sorry, that file couldn't be converted.")
    except Exception:
        delete_job(job_dir)
        raise

    name = Path(file.filename).stem + ".pdf"
    return send_result(output_path, name, "application/pdf", job_dir)


def office_to_pdf(file: UploadFile, allowed: tuple, label: str):
    """PowerPoint / Excel / Word to PDF with LibreOffice."""
    extension = Path(file.filename or "").suffix.lower()
    if extension not in allowed:
        raise HTTPException(400, f"Please upload a {label} file ({', '.join(allowed)}).")

    job_dir = new_job_dir()
    try:
        input_path = save_upload(file, job_dir, extension)
        check_signature(input_path, "office")
        profile = (job_dir / "lo-profile").resolve().as_uri()
        run_command([
            LIBREOFFICE, f"-env:UserInstallation={profile}",
            "--headless", "--convert-to", "pdf",
            "--outdir", str(job_dir), str(input_path),
        ])
        output_path = job_dir / "input.pdf"
        if not output_path.exists():
            raise HTTPException(500, "Sorry, that file couldn't be converted.")
    except Exception:
        delete_job(job_dir)
        raise

    name = Path(file.filename).stem + ".pdf"
    return send_result(output_path, name, "application/pdf", job_dir)


@app.post("/powerpoint-to-pdf")
def powerpoint_to_pdf(file: UploadFile = File(...)):
    return office_to_pdf(file, (".ppt", ".pptx", ".odp"), "PowerPoint")


@app.post("/excel-to-pdf")
def excel_to_pdf(file: UploadFile = File(...)):
    return office_to_pdf(file, (".xls", ".xlsx", ".ods"), "Excel")


@app.post("/pdf-to-word")
def pdf_to_word(file: UploadFile = File(...)):
    extension = Path(file.filename or "").suffix.lower()
    if extension != ".pdf":
        raise HTTPException(400, "Please upload a .pdf file.")

    job_dir = new_job_dir()
    try:
        input_path = save_upload(file, job_dir, ".pdf")
        check_signature(input_path, "pdf")
        output_path = job_dir / "output.docx"
        run_command([PDF2DOCX, "convert", str(input_path), str(output_path)])
        if not output_path.exists():
            raise HTTPException(500, "Sorry, that file couldn't be converted.")
    except Exception:
        delete_job(job_dir)
        raise

    name = Path(file.filename).stem + ".docx"
    return send_result(
        output_path, name,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        job_dir,
    )


# Steps tried, gentlest first, when the user asks for a size limit (e.g. under 100 KB)
def _res(dpi: int) -> list[str]:
    return ["-dDownsampleColorImages=true", "-dDownsampleGrayImages=true",
            "-dColorImageDownsampleType=/Bicubic", "-dGrayImageDownsampleType=/Bicubic",
            f"-dColorImageResolution={dpi}", f"-dGrayImageResolution={dpi}",
            "-dColorImageDownsampleThreshold=1.0", "-dGrayImageDownsampleThreshold=1.0"]


GRAY = ["-sColorConversionStrategy=Gray", "-dProcessColorModel=/DeviceGray"]
TARGET_STEPS = [
    ("/ebook", []),
    ("/screen", []),
    ("/screen", _res(50)),
    ("/screen", _res(36)),
    ("/screen", _res(36) + GRAY),
]
TARGET_SIZES_KB = {50, 100, 150, 200, 300, 500, 1024, 2048}


def ghostscript_compress(input_path: Path, output_path: Path, setting: str, extra: list[str]):
    run_command([
        GHOSTSCRIPT, "-sDEVICE=pdfwrite", "-dCompatibilityLevel=1.5",
        f"-dPDFSETTINGS={setting}", "-dDetectDuplicateImages=true", *extra,
        "-dNOPAUSE", "-dQUIET", "-dBATCH", "-dSAFER",
        f"-sOutputFile={output_path}", str(input_path),
    ], timeout=180)
    if not output_path.exists():
        raise HTTPException(500, "Sorry, that PDF couldn't be compressed.")


@app.post("/compress-pdf")
def compress_pdf(file: UploadFile = File(...), level: str = Form("recommended"), target: int = Form(0)):
    extension = Path(file.filename or "").suffix.lower()
    if extension != ".pdf":
        raise HTTPException(400, "Please upload a .pdf file.")

    job_dir = new_job_dir()
    headers = {}
    try:
        input_path = save_upload(file, job_dir, ".pdf", COMPRESS_MAX_SIZE)
        check_signature(input_path, "pdf")
        original = input_path.stat().st_size

        if level == "target":
            if target not in TARGET_SIZES_KB:
                raise HTTPException(400, "Please choose a size from the list.")
            limit = target * 1024
            best = input_path
            if original > limit:
                for i, (setting, extra) in enumerate(TARGET_STEPS):
                    attempt = job_dir / f"try{i}.pdf"
                    ghostscript_compress(input_path, attempt, setting, extra)
                    if attempt.stat().st_size < best.stat().st_size:
                        best = attempt
                    if best.stat().st_size <= limit:
                        break
            output_path = best
            headers["X-Target-Met"] = "1" if output_path.stat().st_size <= limit else "0"
        else:
            output_path = job_dir / "output.pdf"
            ghostscript_compress(input_path, output_path, COMPRESS_LEVELS.get(level, "/ebook"), [])
            # Never hand back a bigger file: keep the original if it didn't shrink
            if output_path.stat().st_size >= original:
                output_path = input_path
    except Exception:
        delete_job(job_dir)
        raise

    name = Path(file.filename).stem + "-compressed.pdf"
    response = send_result(output_path, name, "application/pdf", job_dir)
    response.headers.update(headers)
    return response


# ---------- OCR: scanned PDF or photo -> Word, searchable PDF or text ----------
def clean_ocr_line(line: str) -> str:
    """Tesseract often reads bullet points as odd symbols; turn them back into bullets."""
    return re.sub(r"^\s*[¢°«©®•eo*]\s+(?=\S)", "• ", line).rstrip()


def text_to_docx(pages: list[str], path: Path, rtl: bool):
    """Write a simple Word file: one paragraph per block of text, a page break between pages."""
    bidi = "<w:bidi/>" if rtl else ""
    run_rtl = "<w:rPr><w:rtl/></w:rPr>" if rtl else ""
    body = []
    for n, page in enumerate(pages):
        if n:
            body.append('<w:p><w:r><w:br w:type="page"/></w:r></w:p>')
        for block in re.split(r"\n\s*\n", page.strip()):
            lines = [clean_ocr_line(l) for l in block.split("\n") if l.strip()]
            if not lines:
                continue
            runs = '<w:r><w:br/></w:r>'.join(
                f'<w:r>{run_rtl}<w:t xml:space="preserve">{xml_escape(l)}</w:t></w:r>' for l in lines)
            body.append(f"<w:p><w:pPr>{bidi}</w:pPr>{runs}</w:p>")
    if not body:
        body.append("<w:p/>")
    document = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
                + "".join(body) +
                '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
                '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/>'
                '</w:sectPr></w:body></w:document>')
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml",
                   '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                   '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                   '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                   '<Default Extension="xml" ContentType="application/xml"/>'
                   '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
                   '</Types>')
        z.writestr("_rels/.rels",
                   '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                   '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
                   '</Relationships>')
        z.writestr("word/document.xml", document)


def upright_image(path: Path):
    """Phone photos store their rotation separately; turn the pixels upright so OCR can read them."""
    try:
        from PIL import Image, ImageOps
        with Image.open(path) as im:
            fixed = ImageOps.exif_transpose(im)
            if fixed is not im:
                fixed.save(path)
    except Exception:
        pass


@app.post("/ocr-pdf")
def ocr_pdf(file: UploadFile = File(...), lang: str = Form("eng"), output: str = Form("docx")):
    extension = Path(file.filename or "").suffix.lower()
    if extension not in (".pdf", ".jpg", ".jpeg", ".png"):
        raise HTTPException(400, "Please upload a PDF, JPG or PNG file.")
    if lang not in OCR_LANGS:
        raise HTTPException(400, "Please choose a language from the list.")
    if output not in ("docx", "pdf", "txt"):
        raise HTTPException(400, "Please choose Word, PDF or text.")

    job_dir = new_job_dir()
    try:
        input_path = save_upload(file, job_dir, extension)
        if extension == ".pdf":
            check_signature(input_path, "pdf")
            pages = pdf_page_count(input_path)
            if pages > OCR_MAX_PAGES:
                raise HTTPException(400, f"This PDF has {pages} pages. OCR works on up to {OCR_MAX_PAGES} pages at a time. Use Split PDF to send it in parts.")
            run_command([PDFTOPPM, "-r", "300", "-gray", "-png", "-l", str(OCR_MAX_PAGES),
                         str(input_path), str(job_dir / "page")])
            images = sorted(job_dir.glob("page*.png"))
        else:
            check_signature(input_path, "image")
            upright_image(input_path)
            images = [input_path]
        if not images:
            raise HTTPException(500, "Sorry, that file couldn't be read.")

        list_file = job_dir / "pages.txt"
        list_file.write_text("\n".join(str(p.resolve()) for p in images) + "\n")
        out_base = job_dir / "ocr"
        formats = ["pdf", "txt"] if output == "pdf" else ["txt"]
        run_command([TESSERACT, str(list_file), str(out_base), "-l", OCR_LANGS[lang], *formats],
                    timeout=OCR_TIMEOUT)

        text = (job_dir / "ocr.txt").read_text("utf-8", "ignore") if (job_dir / "ocr.txt").exists() else ""
        if not re.search(r"\w{2,}", text):
            raise HTTPException(422, "We couldn't find any text. Check the scan is clear and the right language is chosen.")
        stem = Path(file.filename).stem
        if output == "docx":
            output_path = job_dir / "output.docx"
            text_to_docx(text.split("\f"), output_path, lang in RTL_LANGS)
            name, media = stem + ".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        elif output == "pdf":
            output_path = job_dir / "ocr.pdf"
            # Shrink the scan images; keep whichever file is smaller
            smaller = job_dir / "ocr-small.pdf"
            try:
                ghostscript_compress(output_path, smaller, "/ebook", [])
                if smaller.stat().st_size < output_path.stat().st_size:
                    output_path = smaller
            except HTTPException:
                pass
            name, media = stem + "-searchable.pdf", "application/pdf"
        else:
            output_path = job_dir / "output.txt"
            output_path.write_text("\n".join(clean_ocr_line(l) for l in text.replace("\f", "\n\n").split("\n")).strip() + "\n", "utf-8")
            name, media = stem + ".txt", "text/plain; charset=utf-8"
    except Exception:
        delete_job(job_dir)
        raise

    return send_result(output_path, name, media, job_dir)


# ---------- PDF to PowerPoint ----------
def pictures_to_pptx(images: list[Path], path: Path):
    """One slide per page image, sized to the page."""
    from pptx import Presentation
    from pptx.util import Emu
    from PIL import Image
    prs = Presentation()
    with Image.open(images[0]) as first:
        w, h = first.size
    prs.slide_width = Emu(12192000)
    prs.slide_height = Emu(int(12192000 * h / w))
    blank = prs.slide_layouts[6]
    for img in images:
        slide = prs.slides.add_slide(blank)
        slide.shapes.add_picture(str(img), 0, 0, width=prs.slide_width, height=prs.slide_height)
    prs.save(path)


@app.post("/pdf-to-powerpoint")
def pdf_to_powerpoint(file: UploadFile = File(...), mode: str = Form("editable")):
    extension = Path(file.filename or "").suffix.lower()
    if extension != ".pdf":
        raise HTTPException(400, "Please upload a .pdf file.")
    if mode not in ("editable", "pictures"):
        raise HTTPException(400, "Please choose Editable or Picture slides.")

    job_dir = new_job_dir()
    try:
        input_path = save_upload(file, job_dir, ".pdf")
        check_signature(input_path, "pdf")
        if mode == "editable":
            profile = (job_dir / "lo-profile").resolve().as_uri()
            run_command([
                LIBREOFFICE, f"-env:UserInstallation={profile}",
                "--headless", "--infilter=impress_pdf_import", "--convert-to", "pptx",
                "--outdir", str(job_dir), str(input_path),
            ])
            output_path = job_dir / "input.pptx"
        else:
            pages = pdf_page_count(input_path)
            if pages > PPT_PICTURE_MAX_PAGES:
                raise HTTPException(400, f"This PDF has {pages} pages. Picture slides work on up to {PPT_PICTURE_MAX_PAGES} pages. Try Editable, or split the PDF first.")
            run_command([PDFTOPPM, "-r", "150", "-jpeg", "-jpegopt", "quality=85",
                         "-l", str(PPT_PICTURE_MAX_PAGES), str(input_path), str(job_dir / "slide")])
            images = sorted(job_dir.glob("slide*.jpg"))
            if not images:
                raise HTTPException(500, "Sorry, that PDF couldn't be converted.")
            output_path = job_dir / "output.pptx"
            try:
                pictures_to_pptx(images, output_path)
            except ImportError:
                raise HTTPException(500, "This tool needs extra software that isn't installed on this computer. It works on the live site.")
        if not output_path.exists():
            raise HTTPException(500, "Sorry, that PDF couldn't be converted.")
    except Exception:
        delete_job(job_dir)
        raise

    name = Path(file.filename).stem + ".pptx"
    return send_result(output_path, name,
                       "application/vnd.openxmlformats-officedocument.presentationml.presentation", job_dir)


@app.get("/api/deleted/{job_id}")
def job_deleted(job_id: str):
    """Tells the page whether a finished job's files are gone (privacy receipt)."""
    try:
        uuid.UUID(job_id)
    except ValueError:
        raise HTTPException(400, "Unknown job.")
    return JSONResponse({"deleted": not (WORK_DIR / job_id).exists()},
                        headers={"Cache-Control": "no-store"})


# ---------- Pages ----------
def page(name: str):
    return FileResponse(PAGES_DIR / name, media_type="text/html")


@app.get("/")
def home():
    return page("index.html")


# Each tool page: address -> file in pages/
TOOL_PAGES = [
    "word-to-pdf", "pdf-to-word", "compress-pdf", "merge-pdf", "split-pdf", "jpg-to-pdf",
    "powerpoint-to-pdf", "excel-to-pdf", "pdf-to-jpg", "rotate-pdf", "add-page-numbers",
    "ocr-pdf", "pdf-to-powerpoint", "edit-pdf",
    "compress-pdf-to-100kb", "compress-pdf-to-200kb", "compress-pdf-to-500kb", "compress-pdf-to-1mb",
]


def make_page_route(slug: str):
    def show_page():
        return page(f"{slug}.html")
    show_page.__name__ = f"page_{slug.replace('-', '_')}"
    return show_page


for slug in TOOL_PAGES:
    app.get(f"/{slug}")(make_page_route(slug))

# Information pages
for slug in ["guides", "about", "privacy", "terms"]:
    app.get(f"/{slug}")(make_page_route(slug))


@app.get("/guides/{slug}")
def guide(slug: str):
    """A guide page. Only plain names like how-to-merge-pdf are allowed."""
    path = PAGES_DIR / "guides" / f"{slug}.html"
    if not re.fullmatch(r"[a-z0-9-]{1,80}", slug) or not path.is_file():
        raise HTTPException(404, "Page not found.")
    return FileResponse(path, media_type="text/html")


@app.get("/robots.txt")
def robots():
    return FileResponse(STATIC_DIR / "robots.txt", media_type="text/plain")


@app.get("/sitemap.xml")
def sitemap():
    return FileResponse(STATIC_DIR / "sitemap.xml", media_type="application/xml")


@app.get("/llms.txt")
def llms_txt():
    """Plain-text summary of the site for AI assistants."""
    return FileResponse(STATIC_DIR / "llms.txt", media_type="text/plain; charset=utf-8")


@app.get("/sw.js")
def service_worker():
    """Served from the site root so the app can be installed."""
    return FileResponse(STATIC_DIR / "sw.js", media_type="text/javascript",
                        headers={"Cache-Control": "no-cache", "Service-Worker-Allowed": "/"})


@app.get("/favicon.ico")
def favicon():
    return FileResponse(STATIC_DIR / "img" / "favicon.ico", media_type="image/x-icon")
