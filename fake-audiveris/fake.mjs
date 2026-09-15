// A stand-in Audiveris for the test suite: same CLI surface (-batch -export -sheets
// -output), behavior keyed off the INPUT FILENAME so each corpus-taught scenario is
// reproducible without Java. CI never needs the real engine.
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const processArguments = process.argv.slice(2);
// Echo the JVM-options env var the service sets for heap sizing, so the suite can
// assert it actually reaches the spawned engine (the real start script reads it).
if (process.env.AUDIVERIS_OPTS) {
  console.log(`[fake] AUDIVERIS_OPTS=${process.env.AUDIVERIS_OPTS}`);
}
const outputIndex = processArguments.indexOf('-output');
const outputDirectory = outputIndex >= 0 ? processArguments[outputIndex + 1] : '.';
// One argv entry per sheet number, like the real service sends (int[] handler form).
const sheetsIndex = processArguments.indexOf('-sheets');
let sheets = null;
if (sheetsIndex >= 0) {
  sheets = [];
  for (let index = sheetsIndex + 1; index < processArguments.length; index++) {
    if (!/^\d+$/.test(processArguments[index])) break;
    sheets.push(processArguments[index]);
  }
}
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
  case 'rhythms-noisy':
    // A real 5.10.2 run logs exception NAMES as WARN noise and carries on (the
    // Love-is-a-Verb tuning log): the rhythm abort underneath must still win.
    console.log('WARN [book] PartwiseBuilder.java:3244 | Error visiting System#2 in {Page#1.2}');
    console.log(
      'java.lang.NullPointerException: Cannot invoke "org.audiveris.omr.sheet.Part.getFirstMeasure()" because "refPart" is null',
    );
    console.log('\tat org.audiveris.omr.sheet.Part.createDummyPart(Part.java:359)');
    console.log('Voice excess 1/8 at measure 12 — no correct rhythm could be found');
    break;
  case 'oom':
    console.log('Exception in thread "main" java.lang.OutOfMemoryError: Java heap space');
    break;
  case 'crash':
    console.log('Exception in thread "main" java.lang.IllegalStateException: boom');
    console.log('\tat org.audiveris.omr.Main.main(Main.java:263)');
    break;
  case 'badsheet':
    console.log('Book badsheet has 3 sheets');
    if (sheets && !sheets.includes('2')) {
      writeMovement('badsheet', 'badsheet.mxl');
    } else {
      console.log('Sheet #2 flagged invalid — export aborted');
    }
    break;
  case 'slow':
    await new Promise((resolve) => setTimeout(resolve, 5000));
    break;
  case 'slowtree': {
    // A launcher that hands the real work to a child (the jpackage .exe over its JVM):
    // the grandchild sleeps long, writes its pid next to the input so the suite can
    // check the timeout kill reached it, and the "launcher" waits for it.
    const { spawn } = await import('node:child_process');
    const { writeFileSync: writePid } = await import('node:fs');
    const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], {
      stdio: 'ignore',
    });
    writePid(`${inputPath}.grandchild-pid`, String(grandchild.pid));
    await new Promise((resolve) => grandchild.on('exit', resolve));
    break;
  }
  case 'garbage':
    console.log('Could not load input as a score');
    break;
  default:
    console.log(`Unknown fake scenario "${effectiveScenario}"`);
}
