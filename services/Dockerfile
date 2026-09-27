# One image definition for both calculation engines.
# Build context is services/ so the shared runtime is available to either service.
#   docker build -f services/Dockerfile --build-arg SERVICE=workforce-engine services/
FROM python:3.12-slim

ARG SERVICE
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    SERVICE_NAME=${SERVICE}

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY shared ./shared
COPY ${SERVICE}/app ./app

RUN useradd --create-home --uid 10001 engine
USER engine

# Runs as a queue consumer. RUN_CONSUMER=false plus uvicorn serves the HTTP surface
# instead, which is how the workforce engine exposes its daily-close endpoint.
CMD ["python", "-m", "app.main"]
