import os
import re
import glob
import time
import uuid
import shutil
import threading
import subprocess
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask

# ---------- Settings ----------
LIBREOFFICE = os.environ.get("LIBREOFFICE", r"C:\Program Files\LibreOffice\program\soffice.exe")
PDF2DOCX = shutil.which("pdf2docx") or "pdf2docx"


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
MAX_FILE_SIZE = 20 * 1024 * 1024   # 20 MB
CONVERT_TIMEOUT = 120              # seconds
KEEP_FILES_FOR = 60 * 60           # 1 hour
CLEANUP_EVERY = 10 * 60            # 10 minutes

WORK_DIR.mkdir(exist_ok=True)

# docs_url=None hides the /docs test page from the public
app = FastAPI(title="GetPDF360", docs_url=None, redoc_url=None, openapi_url=None)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


# ---------- Helpers ----------
def new_job_dir() -> Path:
    job_dir = WORK_DIR / str(uuid.uuid4())
    job_dir.mkdir()
    return job_dir


def delete_job(job_dir: Path):
    shutil.rmtree(job_dir, ignore_errors=True)


def save_upload(file: UploadFile, job_dir: Path, extension: str) -> Path:
    """Save the upload in 1 MB chunks, stopping if it gets too big."""
    path = job_dir / ("input" + extension)
    size = 0
    with open(path, "wb") as f:
        while chunk := file.file.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_FILE_SIZE:
                raise HTTPException(413, "File is too large. The limit is 20 MB.")
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
    if kind in ("word", "office") and not (start.startswith(b"PK\x03\x04") or start.startswith(b"\xd0\xcf\x11\xe0")):
        raise HTTPException(400, "This is not a valid Word file." if kind == "word" else "This file isn't a valid document.")


def run_command(command: list[str]):
    try:
        subprocess.run(command, check=True, timeout=CONVERT_TIMEOUT, capture_output=True)
    except subprocess.TimeoutExpired:
        raise HTTPException(504, "The conversion took too long. Please try a smaller file.")
    except subprocess.CalledProcessError:
        raise HTTPException(500, "Sorry, that file couldn't be converted.")


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


@app.post("/compress-pdf")
def compress_pdf(file: UploadFile = File(...), level: str = Form("recommended")):
    extension = Path(file.filename or "").suffix.lower()
    if extension != ".pdf":
        raise HTTPException(400, "Please upload a .pdf file.")
    setting = COMPRESS_LEVELS.get(level, "/ebook")

    job_dir = new_job_dir()
    try:
        input_path = save_upload(file, job_dir, ".pdf")
        check_signature(input_path, "pdf")
        output_path = job_dir / "output.pdf"
        run_command([
            GHOSTSCRIPT, "-sDEVICE=pdfwrite", "-dCompatibilityLevel=1.5",
            f"-dPDFSETTINGS={setting}", "-dDetectDuplicateImages=true",
            "-dNOPAUSE", "-dQUIET", "-dBATCH", "-dSAFER",
            f"-sOutputFile={output_path}", str(input_path),
        ])
        if not output_path.exists():
            raise HTTPException(500, "Sorry, that PDF couldn't be compressed.")
        # Never hand back a bigger file: keep the original if it didn't shrink
        if output_path.stat().st_size >= input_path.stat().st_size:
            output_path = input_path
    except Exception:
        delete_job(job_dir)
        raise

    name = Path(file.filename).stem + "-compressed.pdf"
    return send_result(output_path, name, "application/pdf", job_dir)


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


@app.get("/favicon.ico")
def favicon():
    return FileResponse(STATIC_DIR / "img" / "favicon.ico", media_type="image/x-icon")
