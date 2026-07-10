# solfascribe-omr — Audiveris in a box behind a four-route REST API.
#
# Stage 1 builds Audiveris (AGPL-3.0, https://github.com/Audiveris/audiveris) from its
# release tag; stage 2 is the slim runtime: JRE + Tesseract + Node for the glue service.
# See NOTICE.md for the licence split (MIT glue, AGPL engine).

FROM eclipse-temurin:21-jdk AS audiveris-build
ARG AUDIVERIS_VERSION=5.10.2
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch ${AUDIVERIS_VERSION} https://github.com/Audiveris/audiveris.git /build
WORKDIR /build
RUN ./gradlew --no-daemon :app:installDist

FROM eclipse-temurin:21-jre
# Tesseract runtime + English traineddata (Audiveris's OCR backend) and the fonts a
# headless engraving pass expects.
RUN apt-get update && apt-get install -y --no-install-recommends \
      tesseract-ocr tesseract-ocr-eng fontconfig fonts-dejavu-core curl \
    && rm -rf /var/lib/apt/lists/*
# Node 22 for the glue service.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

COPY --from=audiveris-build /build/app/build/install/app /opt/audiveris

WORKDIR /service
COPY package.json package-lock.json ./
# npm ci honours the lockfile exactly — no unpinned installs (review note).
RUN npm ci --omit=dev
COPY src ./src
COPY tsconfig.json ./

ENV AUDIVERIS_CMD=/opt/audiveris/bin/Audiveris \
    PORT=8480 \
    WORK_ROOT=/tmp/solfascribe-omr
EXPOSE 8480
# Not root (review note): the service only needs its own files and WORK_ROOT.
RUN useradd --system --create-home omr && chown -R omr /service
USER omr
HEALTHCHECK --interval=30s --timeout=5s CMD curl -sf http://localhost:8480/healthz || exit 1
CMD ["npx", "tsx", "src/server.ts"]
