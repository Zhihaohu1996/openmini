import type { ManifestIssue } from './types';

export function formatManifestIssues(issues: ManifestIssue[]): string {
  const lines = issues.map((issue) =>
    issue.path ? `- ${issue.path}: ${issue.message}` : `- ${issue.message}`,
  );
  return ['Invalid OpenMini manifest:', ...lines].join('\n');
}

export class ManifestValidationError extends Error {
  readonly issues: ManifestIssue[];

  constructor(issues: ManifestIssue[]) {
    super(formatManifestIssues(issues));
    this.name = 'ManifestValidationError';
    this.issues = issues;
  }
}
