# solfascribe-omr — Audiveris in a box behind a four-route REST API.
#
# Stage 1 builds Audiveris (AGPL-3.0, https://github.com/Audiveris/audiveris) from its
# release tag; stage 2 is the slim runtime: JRE + the engine's OCR language file + Node
# for the glue service.
# See NOTICE.md for the licence split (MIT glue, AGPL engine).

# The image is multi-arch by construction (amd64 AND arm64 — the production target is
# an arm64 Oracle Ampere A1 VM; CI proves the arm64 build on a native arm runner):
#  - eclipse-temurin manifests publish both architectures.
#  - Every apt package (fontconfig, curl) is arch-native from Ubuntu's repos.
#  - The NodeSource setup script detects the architecture and serves arm64 debs.
#  - The Audiveris build is Java bytecode plus bytedeco tesseract/leptonica natives; its
#    5.10.2 build.gradle deliberately bundles BOTH linux-x86_64 and linux-arm64 native
#    classifiers on Linux, so the installDist output runs on either architecture
#    regardless of which one built it. No URL or arch string below is hardcoded.

# Audiveris 5.10.2 declares theMinJavaVersion 25 — a 21 JDK fails compileJava with
# "invalid source release: 25".
FROM eclipse-temurin:25-jdk AS audiveris-build
ARG AUDIVERIS_VERSION=5.10.2
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch ${AUDIVERIS_VERSION} https://github.com/Audiveris/audiveris.git /build
WORKDIR /build
RUN ./gradlew --no-daemon :app:installDist

FROM eclipse-temurin:25-jre
# fontconfig + the fonts a headless engraving pass expects; curl for the health check and
# the language-file fetch below. NO apt tesseract: Audiveris carries its own Tesseract as
# bytedeco natives, self-contained (`ldd` on the linux-arm64 build shows nothing beyond
# libc/libstdc++ and its bundled leptonica), and the apt package's English file is the
# LSTM-only "fast" model, which the engine cannot use — next block.
RUN apt-get update && apt-get install -y --no-install-recommends \
      fontconfig fonts-dejavu-core curl \
    && rm -rf /var/lib/apt/lists/*

# The OCR language file. Audiveris drives Tesseract in LEGACY mode (OEM_TESSERACT_ONLY,
# hardcoded in its TesseractOrder.java), so the file must carry the legacy model. The
# files in the tesseract-ocr/tessdata repository do — it is where the engine's own
# downloader fetches from — while tessdata_fast and tessdata_best are LSTM-only and fail
# with "TesseractOrder. Could not initialize TessBaseAPI languages: eng in legacy mode",
# after which every scan comes back wordless. The first Oracle scans did exactly that
# (2026-09-24) on Ubuntu's tesseract-ocr-eng, which ships the fast model. Pinned to the
# 4.1.0 release and checksummed; the SolfaScribe home path runs the byte-identical file.
ARG TESSDATA_RELEASE=4.1.0
ARG TESSDATA_ENG_SHA256=daa0c97d651c19fba3b25e81317cd697e9908c8208090c94c3905381c23fc047
RUN mkdir -p /opt/tessdata \
    && curl -fsSL -o /opt/tessdata/eng.traineddata \
         "https://github.com/tesseract-ocr/tessdata/raw/${TESSDATA_RELEASE}/eng.traineddata" \
    && echo "${TESSDATA_ENG_SHA256}  /opt/tessdata/eng.traineddata" | sha256sum -c -
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
    WORK_ROOT=/tmp/solfascribe-omr \
    # Where the engine finds its OCR language file (the fetch above).
    TESSDATA_PREFIX=/opt/tessdata \
    # All interfaces INSIDE the container — the container is the boundary; the service's
    # own default is 127.0.0.1 for a bare-metal host (security review 2026-09-15).
    HOST=0.0.0.0
EXPOSE 8480
# Not root (review note): the service only needs its own files and WORK_ROOT.
# UID 1000 specifically — Hugging Face Spaces runs Docker Spaces as that UID, so the
# same image works there unchanged. The Ubuntu base already ships a UID-1000 user
# ("ubuntu" as of 24.04) — remove whoever holds the UID first.
RUN existing="$(getent passwd 1000 | cut -d: -f1)" \
    && if [ -n "$existing" ]; then userdel -r "$existing"; fi \
    && useradd --create-home --uid 1000 omr && chown -R omr /service \
    # Pre-create the default WORK_ROOT owned by omr: a named volume mounted there
    # (deploy/oracle) inherits this ownership on first use, so the non-root service
    # can write its job directories.
    && mkdir -p /tmp/solfascribe-omr && chown omr /tmp/solfascribe-omr
USER omr
HEALTHCHECK --interval=30s --timeout=5s CMD curl -sf http://localhost:8480/healthz || exit 1
CMD ["npx", "tsx", "src/server.ts"]
