import os
import uuid
import shutil
import subprocess
from fastapi import FastAPI, UploadFile, File
from fastapi.responses import FileResponse
from pdf2docx import Converter

LIBREOFFICE = r"C:\Program Files\LibreOffice\program\soffice.exe"
WORK_DIR = "files"
os.makedirs(WORK_DIR, exist_ok=True)

app = FastAPI(title="My PDF Converter")


def save_upload(file: UploadFile, extension: str) -> tuple[str, str]:
    job_id = str(uuid.uuid4())
    path = os.path.join(WORK_DIR, job_id + extension)
    with open(path, "wb") as f:
        shutil.copyfileobj(file.file, f)
    return job_id, path


@app.post("/word-to-pdf")
def word_to_pdf(file: UploadFile = File(...)):
    extension = os.path.splitext(file.filename)[1].lower() or ".docx"
    job_id, input_path = save_upload(file, extension)
    subprocess.run(
        [LIBREOFFICE, "--headless", "--convert-to", "pdf", "--outdir", WORK_DIR, input_path],
        check=True,
    )
    output_path = os.path.join(WORK_DIR, job_id + ".pdf")
    name = os.path.splitext(file.filename)[0] + ".pdf"
    return FileResponse(output_path, filename=name, media_type="application/pdf")


@app.post("/pdf-to-word")
def pdf_to_word(file: UploadFile = File(...)):
    job_id, input_path = save_upload(file, ".pdf")
    output_path = os.path.join(WORK_DIR, job_id + ".docx")
    cv = Converter(input_path)
    cv.convert(output_path)
    cv.close()
    name = os.path.splitext(file.filename)[0] + ".docx"
    return FileResponse(
        output_path,
        filename=name,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )

@app.get("/")
def home():
    return FileResponse("index.html")