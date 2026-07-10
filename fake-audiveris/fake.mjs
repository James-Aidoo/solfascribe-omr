// A stand-in Audiveris for the test suite: same CLI surface (-batch -export -sheets
// -output), behavior keyed off the INPUT FILENAME so each corpus-taught scenario is
// reproducible without Java. CI never needs the real engine.
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const processArguments = process.argv.slice(2);
const outputIndex = processArguments.indexOf('-output');
const outputDirectory = outputIndex >= 0 ? processArguments[outputIndex + 1] : '.';
const sheetsIndex = processArguments.indexOf('-sheets');
const sheets = sheetsIndex >= 0 ? processArguments[sheetsIndex + 1] : null;
const inputPath = processArguments[processArguments.length - 1];
const scenario = basename(inputPath).replace(/\.pdf$/i, '');
// The job store always uploads as input.pdf — the scenario travels in the CONTENT when
// the filename is generic (the store writes the original name as the first line).
import { readFileSync } from 'node:fs';
const contentScenario = (() => {
  try {
    return readFileSync(inputPath, 'utf8').split('\n')[0].trim();
  } catch {
    return '';
  }
})();
const effectiveScenario = scenario === 'input' ? contentScenario : scenario;

const writeMovement = (bookName, movementFilename) => {
  const bookDirectory = join(outputDirectory, bookName);
  mkdirSync(bookDirectory, { recursive: true });
  writeFileSync(join(bookDirectory, movementFilename), `<fake-mxl scenario="${effectiveScenario}"/>`);
};

switch (effectiveScenario) {
  case 'ok':
    console.log('Processing book ok, 1 sheets');
    writeMovement('ok', 'ok.mxl');
    break;
  case 'movements':
    console.log('Processing book movements, 6 sheets');
    writeMovement('movements', 'movements.mvt1.mxl');
    writeMovement('movements', 'movements.mvt2.mxl');
    break;
  case 'rhythms':
    console.log('Voice excess 1/8 at measure 12 — no correct rhythm could be found');
    break;
  case 'badsheet':
    console.log('Book badsheet has 3 sheets');
    if (sheets && !sheets.split(/\s+/).includes('2')) {
      writeMovement('badsheet', 'badsheet.mxl');
    } else {
      console.log('Sheet #2 flagged invalid — export aborted');
    }
    break;
  case 'slow':
    await new Promise((resolve) => setTimeout(resolve, 5000));
    break;
  case 'garbage':
    console.log('Could not load input as a score');
    break;
  default:
    console.log(`Unknown fake scenario "${effectiveScenario}"`);
}
