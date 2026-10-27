/** Skill découvert dans `~/Atelier/skills/<nom>/SKILL.md`. */
export interface SkillInfo {
  /** Nom (frontmatter `name`). */
  name: string;
  /** Description injectée dans le prompt système (frontmatter `description`). */
  description: string;
  /** Chemin absolu du SKILL.md côté hôte. */
  path: string;
  /** Chemin du SKILL.md dans la VM (sous `/skills`). */
  guestPath?: string;
}
