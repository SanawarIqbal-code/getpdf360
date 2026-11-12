FROM python:3.12-slim

# Install LibreOffice (Writer, Impress, Calc), Ghostscript and common fonts
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       libreoffice-writer \
       libreoffice-impress \
       libreoffice-calc \
       ghostscript \
       fonts-dejavu-core \
       fonts-liberation \
       fonts-crosextra-carlito \
       fonts-crosextra-caladea \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python packages
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the app code, pages and images
COPY app.py ./
COPY pages ./pages
COPY static ./static

# Run as a normal user, not as admin
RUN useradd --create-home appuser && chown -R appuser /app
USER appuser

ENV LIBREOFFICE=soffice
EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
