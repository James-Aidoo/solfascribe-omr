# Third-party notices

## Audiveris (AGPL-3.0)

The Docker image built from this repository downloads, builds, and bundles
[Audiveris](https://github.com/Audiveris/audiveris), the optical music recognition
engine, which is licensed under the **GNU Affero General Public License v3.0**.

- Audiveris source code: https://github.com/Audiveris/audiveris
- The exact version bundled is pinned by the `AUDIVERIS_VERSION` build argument in the
  [Dockerfile](./Dockerfile) (currently 5.10.2).

The glue service in `src/` is a separate program that invokes Audiveris as a
command-line subprocess and is licensed under MIT (see [LICENSE](./LICENSE)). If you
offer this service over a network, AGPL §13 entitles your users to the source of the
Audiveris version you run — keeping the bundled version pinned to an unmodified upstream
release (as this Dockerfile does) satisfies that by reference to the links above. If you
MODIFY Audiveris itself, you must publish your modified source.

## Tesseract OCR (Apache-2.0)

The image installs Tesseract OCR and its English traineddata from Debian packages.
