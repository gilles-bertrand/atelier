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
  /**
   * Scripts d'entrée du skill (dossier `scripts/` ou frontmatter `scripts`), dans la
   * VM quand `guestPath` est connu, sinon côté hôte. Nommés dans le prompt système.
   */
  scripts?: string[];
  /**
   * Mots-clés déclencheurs (frontmatter `triggers`, en minuscules) : une demande qui
   * en contient un fait charger le SKILL.md d'office dans le tour (critère 2).
   */
  triggers?: string[];
}
