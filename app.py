import os
import time
import uuid
import shutil
import threading
import subprocess
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

# ---------- Settings ----------
LIBREOFFICE = os.environ.get("LIBREOFFICE", r"C:\Program Files\LibreOffice\program\soffice.exe")
PDF2DOCX = shutil.which("pdf2docx") or "pdf2docx"
WORK_DIR = Path("files")
MAX_FILE_SIZE = 20 * 1024 * 1024   # 20 MB
CONVERT_TIMEOUT = 120              # seconds
KEEP_FILES_FOR = 60 * 60           # 1 hour
CLEANUP_EVERY = 10 * 60            # 10 minutes

WORK_DIR.mkdir(exist_ok=True)
app = FastAPI(title="My PDF Converter")


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
    if kind == "word" and not (start.startswith(b"PK\x03\x04") or start.startswith(b"\xd0\xcf\x11\xe0")):
        raise HTTPException(400, "This is not a valid Word file.")


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


# ---------- Endpoints ----------
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
    return FileResponse(
        output_path,
        filename=name,
        media_type="application/pdf",
        background=BackgroundTask(delete_job, job_dir),
    )


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
    return FileResponse(
        output_path,
        filename=name,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        background=BackgroundTask(delete_job, job_dir),
    )


@app.get("/")
def home():
    return FileResponse("index.html")