# Build from the REPO ROOT (the pipeline depends on packages/vane-tools):
#   docker build -f pipeline/Dockerfile -t vane-pipeline .
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

# libeccodes as a fallback for platforms where the PyPI eccodes wheel
# doesn't bundle the C library.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libeccodes0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY packages/vane-tools packages/vane-tools
COPY pipeline pipeline
RUN cd pipeline && uv sync --no-dev

# Conversion scratch space (tar + extracted GRIBs, ~2.5 GB per Harmonie run)
ENV TMPDIR=/scratch
RUN mkdir -p /scratch

# stdout is a pipe under Docker; without this, log lines arrive minutes late
ENV PYTHONUNBUFFERED=1

# Liveness: the daemon touches /tmp/vane-heartbeat every 60s from the
# scheduler, so a dead process OR a wedged scheduler goes unhealthy.
# -mmin -10 leaves slack for the serial boot ticks (the first ICON
# download+convert blocks the loop for a few minutes).
HEALTHCHECK --interval=60s --timeout=10s --start-period=300s --retries=3 \
  CMD sh -c 'test -n "$(find /tmp/vane-heartbeat -mmin -10)"'

CMD ["uv", "run", "--directory", "pipeline", "vane-pipeline", "daemon"]
