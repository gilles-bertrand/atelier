/**
 * @atelier/skills — découverte des skills (`~/Atelier/skills/<nom>/SKILL.md`),
 * section du prompt système et skills d'exemple (`xlsx`, `rapport-markdown`).
 * Voir docs/BRIEF.md §5.
 */
export {
  MAX_DESCRIPTION_LENGTH,
  MAX_SKILL_FILE_BYTES,
  SKILL_FILE,
  defaultSkillsDir,
  loadSkills,
  parseSkillFrontmatter,
  skillsPrompt,
  type LoadSkillsOptions,
  type SkillWarning,
} from './loader.js';
export { bundledExamplesDir, installExampleSkills } from './install.js';
