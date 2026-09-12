# Use an official Python runtime as a parent image
FROM python:3.11-slim

# Install system dependencies for TA-Lib and Redis
RUN apt-get update && apt-get install --no-install-recommends -y \
    build-essential \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Install TA-Lib (Optimized with parallel compilation)
RUN wget http://prdownloads.sourceforge.net/ta-lib/ta-lib-0.4.0-src.tar.gz && \
    tar -xvzf ta-lib-0.4.0-src.tar.gz && \
    cd ta-lib/ && \
    ./configure --prefix=/usr && \
    make -j$(nproc) && \
    make install && \
    cd .. && \
    rm -rf ta-lib-0.4.0-src.tar.gz ta-lib/

# Set work directory
WORKDIR /app

# Install Python dependencies (Optimized with BuildKit cache)
COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-cache-dir -r requirements.txt

# Copy project files
COPY . .

# Expose port
EXPOSE 8001

# Command to run the application
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]