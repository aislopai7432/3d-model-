// The player's program for the tutorial job T01: the reference program from tutorial-part.js with every
// cycle call replaced by a marker line (tool changes, moves and the hole positions stay). The tutorial
// guides the player to insert the cycles below the markers with the programGUIDE forms.
import { TUTORIAL_PROGRAM_STEPS, tutorialProgramFromSteps } from './tutorial-part.js';

export const MARK = {
  face: '; >>> OP1 FACE: INSERT CYCLE71 BELOW THIS LINE (MILLING > CYCLE71)',
  pocket: '; >>> OP2 POCKET: INSERT POCKET3 BELOW THIS LINE (MILLING > POCKET3)',
  drill: '; >>> OP3 DRILL: INSERT MCALL CYCLE81 BELOW THIS LINE (DRILLING > MCALL ON, THEN RE-COMPILE)',
};
export const MARK_RE = { face: /^; >>> OP1/, pocket: /^; >>> OP2/, drill: /^; >>> OP3/ };

export function tutorialTemplate() {
  const steps = TUTORIAL_PROGRAM_STEPS.map((s) => ({ ...s, programLines: [MARK[s.id] || `; >>> INSERT ${s.cycle} BELOW THIS LINE`] }));
  return tutorialProgramFromSteps(steps).replace(/^(G17 )/m, '; TUTORIAL: THE CYCLES GO BELOW THE LINES MARKED >>>\n$1');
}
