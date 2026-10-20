import subprocess
from pdf2docx import Converter

LIBREOFFICE = r"C:\Program Files\LibreOffice\program\soffice.exe"

def word_to_pdf(word_file):
    subprocess.run([LIBREOFFICE, "--headless", "--convert-to", "pdf", word_file], check=True)
    print("Done: Word to PDF")

def pdf_to_word(pdf_file, word_file):
    cv = Converter(pdf_file)
    cv.convert(word_file)
    cv.close()
    print("Done: PDF to Word")

word_to_pdf("test.docx")
pdf_to_word("test.pdf", "result2.docx")