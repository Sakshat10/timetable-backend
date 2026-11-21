// ---------------------------------------------------------------------------
// Which sections a subject requirement applies to. ONE definition, shared by the feasibility report, the generation normalizer (what generation
// schedules) and the teacher-assignment rules, so they cannot disagree about the curriculum.
//
//   A requirement belongs to a grade and optionally a stream. It applies to a section when the grade is the same and the stream is EXACTLY the same
//   (null equals null), and, when the requirement is restricted to selected sections, the section is one of them.
// ---------------------------------------------------------------------------

export interface RequirementScope {
  gradeId: string;
  streamId: string | null;
  /** null or absent: every section of the grade/stream (sectionScope ALL_SECTIONS). A list: only those sections (SELECTED_SECTIONS). */
  sectionIds?: readonly string[] | null | undefined;
}

export function requirementAppliesToSection(requirement: RequirementScope, section: { id?: string; gradeId: string; streamId: string | null }): boolean {
  if (requirement.gradeId !== section.gradeId || requirement.streamId !== section.streamId) return false;
  if (requirement.sectionIds === null || requirement.sectionIds === undefined) return true;
  return section.id !== undefined && requirement.sectionIds.includes(section.id);
}

/** The loader's mapping from the stored scope to the snapshot field. */
export function requirementSectionIds(row: { sectionScope: string; sections: ReadonlyArray<{ sectionId: string }> }): string[] | null {
  return row.sectionScope === 'SELECTED_SECTIONS' ? row.sections.map((s) => s.sectionId).sort() : null;
}
